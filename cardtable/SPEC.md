# Card Table → General Tabletop: Implementation Spec (Phases 1–5)

This is the implementation contract for phases 1–5 of
`cardtable/TABLETOP.md`, §7.
Implementers, test authors and reviewers of each phase work from it.

The phases were built from it; where the code and the text below part,
the later decision in §9 says how and why (the index runs to D322). The
code, the tests and the docs cite its sections (§2g) and decisions (D42).

It is grounded in commit `c0e2f28` (`cardtable/app.js`, `ENGINE.md`,
`README.md`, `TABLETOP.md`). It assumes Phase 0 has landed. Phase 0 is
described in §0.3, and it introduces no change in behaviour.

This is revision 2. It folds in a full review: wire and boot fixes
(per-peer patch bases, the boot role decision, module-version checks),
attacker cases, hidden-information leaks, Worker robustness, and the
existing suites that must change. Decisions D43–D86 are new; D23, D33,
D36 and D42 were revised.

**How to read it**

- **MUST**, **MUST NOT** and **SHOULD** have their RFC meanings. Anything
  this spec does not pin down is the implementer's call, within CLAUDE.md:
  concise code, loud failures, no build step, CDN libraries only.
- Each sub-decision that TABLETOP.md left open is marked **[DECISION]**,
  with its reason. All of them are listed again in §9.
- Sections are numbered per phase (§2 = Phase 2). Inside a phase, the
  letters (a)…(m) follow the brief: data model, wire, actions, public view,
  facade, Worker, UI, persistence, CLI, security, performance, tests, and
  docs plus module ownership.
- JSON shapes use TypeScript-like notation: `x?` is optional, `a|b` is a
  union, and `int[lo..hi]` is a bounded integer. An optional field is
  **omitted** when it is absent: never `null`, unless null is listed.
- "Host state" means the authoritative object (`host` in today's app.js).
  "View" means the public object every peer renders, the host included.

**Contents**

- §0 Ground rules for every phase
- §1 Phase 1: Scale
- §2 Phase 2: Pieces, dice and boards
- §3 Phase 3: Space, and full-rules scripting in a Worker
- §4 Phase 4: Game boxes
- §5 Phase 5: Private material
- §6 Cross-phase dependency map
- §7 Risks
- §8 Process notes for implementers
- §9 Decisions index (D1–D322)
- §10 Appendices: every action, the final state, the final wire bodies,
  constants, and the facade by phase

Every phase section has the same thirteen parts:

| | Part | | Part |
|---|---|---|---|
| (a) | data model | (h) | persistence |
| (b) | wire protocol | (i) | CLI bridge |
| (c) | actions | (j) | security |
| (d) | public view | (k) | performance |
| (e) | facade and hooks | (l) | tests |
| (f) | Worker | (m) | docs and module ownership |
| (g) | UI | | |

---

## 0. Ground rules for every phase

### 0.1 Invariants that must never regress

1. **The security model.**
   - The room id is the fingerprint of the host's P-256 key.
   - Every host→guest message on `state` and `note` is `seal()`ed and
     bound to its recipient (`to` and `tp`), as `bound(signed(…))` does today.
   - The `decks`, `rules` and new `boxes` channels are `signed` and
     accepted only from `hostPeer`.
   - Seat keys go only to the authenticated host.
2. **The input gates.**
   - Every peer-supplied key goes through `own()`, and every number
     through `num()` or `normRot()`.
   - Every deck goes through `cleanDeck()`. Every box goes through the new
     `cleanBox()`, and every name through `cleanName()`.
   - Rendering uses `esc()` and `safeColor()`, and DOM nodes are built from
     validated numbers only. Peer-supplied markup never reaches `innerHTML`
     unescaped.
3. **Guests only ever see public views.**
   - A hidden identity (deck order, a face-down card's `i`, a hidden
     piece's type or face, a bag's contents, a die under a cup) never
     leaves the host.
   - The only exceptions are the per-recipient parts addressed to the one
     player entitled to them: that player's own hand, their `vis` pieces,
     their peek answers, asks, hints and `t.secret`.
4. **Flood control.**
   - `flood()`: a burst of 40 actions, then 20 per second, per guest.
   - `mayTalk()`: at most 5 chats or renames per 5 s.
   - Notices: 10, then 5 per second, per recipient.
   - The guest deck budget: 1.5 M chars per table.
   - New actions state their own cost (see each phase's (c)).
5. **Fail loudly** (CLAUDE.md).
   - Every `catch` calls `console.error`.
   - A user-facing failure shows a toast, or a notice to the actor.
   - The global `error` and `unhandledrejection` handlers stay. The rules
     Worker registers its own handlers and forwards them (§3f).
   - No failure is masked by stale data or a misleading message.
6. **Backward compatibility.**
   - Every existing template (`blank`, `turns`, `holdem`, `bridge`, `cah`,
     `dealer`) runs unchanged.
   - Every existing suite stays green. A suite that had to be updated for
     a protocol change is listed in that phase's (l).
   - Every older save (localStorage, any shape since the round table)
     resumes, as specified in each phase's (h).
7. **No build step.**
   - ES modules are served as-is, and libraries come from jsdelivr with
     pinned versions (`trystero@0.25.3` today; JSZip is new in phase 4, as
     `https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm`, because 3.10.1 ships
     no native ES-module build).
   - `cah-cards.js` stays a classic script.
   - `cardtable/` has no `package.json`, so `cli.js` stays CommonJS. Node
     tests import the ES modules from `.mjs` files and rely on Node ≥ 22.7
     ESM syntax detection (the harness checks `process.versions.node` and
     fails loudly on an older Node).
8. **No `sw.js`.** cardtable has no `CACHE_NAME` to bump.

### 0.2 Cross-cutting conventions (all phases)

| Topic | Convention |
|---|---|
| Ids | Item, deck and box ids are host-minted 8-hex strings (`uid()`). `put` MUST re-mint on a collision: `while (own(items, id)) id = uid()`. Player ids stay `/^[0-9a-f]{16}$/`. A type ref is `"<boxId>/<typeId>"`, with `typeId` matching `/^[A-Za-z0-9_-]{1,32}$/`. Seat ids, space ids, zone ids, ask ids and back ids match `/^[A-Za-z0-9_-]{1,24}$/`. |
| Coordinates | Table units. **An item's `x, y` is always its top-left corner** (as for cards today). **An address (a cell or a space) always centres the item on it.** Every API and every `game.json` field follows this one rule. **[DECISION]** One rule for everyone (TABLETOP's examples mix both), so `t.move(id, x, y)` keeps its meaning. |
| Item size | Cards and piles are `CARD_W × CARD_H` (100 × 140). Pieces, supplies and bags take `w × h` from their type, or from their back when hidden. Every place that uses `CARD_W` or `CARD_H` today MUST use `sizeOf(publicItem)`: clamping, the bar position, bulbs, `seatSpot`, motion, and drop spots. |
| Actor | A player id, or `RULES` for script ops. Script ops bypass owner and lock checks (scripts own the rules). Engine refusals (owner, lock, caps) apply to humans only. |
| Randomness | From Phase 2 on, all engine randomness goes through `env.randInt(n)`. That covers shuffle, roll, bag pulls and `t.random()`. `randInt` uses `crypto.getRandomValues` with rejection sampling (no modulo bias). `env.random()` returns `randInt(2**32) / 2**32`. **[DECISION]** Today `opShuffle` uses `Math.random`; TABLETOP requires the host's crypto RNG for rolls, and one RNG everywhere is simpler to audit. |
| Errors in ops | An op on a missing or vanished item returns `false` and calls `console.warn`, as today; scripts test for it. A malformed argument from a **script** (an unknown type, a bad address, a face out of range, a bad ask spec) **throws** `TypeError` with a message naming the call, and the hook fails loudly. A malformed field from a **peer** is ignored or clamped, or refused with a notice. It never throws. |
| Logging | Every state-changing op logs as its actor through `logEvent`. Hidden identities never appear in log text. Phase 3 adds run-length aggregation of Rules lines (§3e). |
| Wire version | `PROTO` = 1 + the phase number (phase 1 → 2, …, phase 5 → 6). See §1b.6. |
| Module version | Every module (`core.js`, `grid.js`, `store.js`, `pieces.js`, `templates.js`, `rules-worker.js`, `boxio.js`, `app.js`) exports the same integer `MODULE_V`, and every import specifier carries it: `import … from './core.js?v=1'` (`?v=` + MODULE_V); `index.html` loads `app.js?v=1` and `style.css?v=1` (D306). Every PR that changes any cardtable module bumps it in all of them at once (the cardtable counterpart of CLAUDE.md's `CACHE_NAME` rule). See §1b.6. |
| State version | `host.v` follows the same numbering. A migration chain `MIGRATE[v]` lifts a save one version at a time (§1h, §2h, …). |
| Caps | Each cap is a named constant exported from `core.js`. See §10.4. A cap is checked only when something **grows**: an old save above a cap still loads. |
| Placement | From Phase 2, every op that puts an item at a position goes through one core function, `place(it, x, y, {free})`: clamping, z, and from Phase 3 snapping and the `at` / zone indexes, and from Phase 5 the private-zone effects. The list of callers is in §3a. |
| Serialization order | Every `items` object that core builds (snapshot, patch, Worker patch, save, export) inserts its ids in **sorted** order, so property order never reveals creation order (§2d). |

### 0.3 What Phase 0 delivers

The phases below assume Phase 0 has landed with the following shape. If
Phase 0 chose different names, **keep Phase 0's names**: this spec's
*semantics* win, its *identifiers* do not.

- **`cardtable/core.js`** is DOM-free and runs in the page, the Worker and
  Node.
  - `createTable(state, env)` returns a table object `T`.
    - `env = { now(), random(), randInt(n), pid, uid() }`, where `pid` is the
      host's own player id. If Phase 0's `env` lacks `randInt`, Phase 1 adds
      it to the page and Node envs, and Phase 3 to the Worker's (§0.2
      Randomness).
    - `T.state` is the host state as plain JSON: `{seq, size, items,
      players, log, rules, guestDeckChars}`.
    - `T.decks` holds the deck catalog.
  - `T.apply(p, a)` is the mutation part of today's `apply`. It runs the
    rules-veto, the op switch and the `onAction` dispatch through an
    injected `T.rules = { has(name), call(name, ...args) }`.
  - The `opDealTop`, `opShuffle`, … family, `logEvent`, `mark`,
    `publicItems`, `publicPlayers`, `standardDeck`, `cleanDeck`,
    `cleanName`, `own`, `num`, `normRot` and `clampToFelt` are all
    parameterized by the table geometry.
  - `T.api` is today's `tApi` facade.
  - Item mutations go through `put(id, item)`, `remove(id)` and
    `touch(id)` (touch = "about to mutate in place").
  - Side effects are queues that the app drains through `T.drain()`:
    `{ fx, ann, notes:[{p,msg}], peeks:[{p,card}], dirtyDecks:Set,
    logDirty, rulesCodeDirty }`.
- **`cardtable/templates.js`** exports `RULES_TEMPLATES` and `GAMES`.
- **`app.js`** keeps the network, storage, rendering, input, dialogs, the
  CLI bridge and boot.
- **`cardtable/tests/`** holds the in-repo harness, the 28 suites and
  `run-all.sh`.
  - Logic suites import `core.js` in Node.
  - The local CDN copies are routed as they are today in `tests/h.js`.

### 0.4 New files over the phases (summary; details in each phase's (m))

| File | Phase | Role |
|---|---|---|
| `core.js` | P0, grows in each phase | State, ops, the public view, patches, gates, the facade, indexes, the setup interpreter, snapping. |
| `templates.js` | P0, grows | Rules templates, `GAMES`, the built-in `BOXES`, demo generators. |
| `store.js` | P1 | IndexedDB (`saves`, `catalog`, `assets`), content hashing, quota handling, migration from localStorage. |
| `grid.js` | P2 (drawing and the address grammar) and P3 (snapping and spatial maths) | Pure geometry: square and hex grids, address parsing and formatting, snapping, neighbours, distance, lines, point-in-polygon. Imported by `core.js` and `app.js`. |
| `pieces.js` | P2 | DOM rendering for pieces, supplies, bags and boards, the board SVG, the hint layer and the dice tumble. Imported by `app.js`. |
| `rules-worker.js` | P3 | The Worker entry: imports `core.js`, evaluates the script, runs actions against the mirror and returns patches. |
| `boxio.js` | P4 | `game.json` and `.zip` import (JSZip from the CDN, loaded lazily), image ingestion, and export. |

---

## 1. Phase 1: Scale

**Goal:** 1,000 items and 8 players stay smooth, with no change in what
players see. Phase 1 delivers:

- delta sync (seq-numbered patches, a snapshot on join, gap or reload);
- an incremental public view and dirty-set rendering;
- a running max z;
- indexed script reads;
- IndexedDB for saves and the deck catalog;
- a content-hash asset cache on every peer;
- a benchmark suite that fails when a budget regresses.

### 1a. Data model and state changes

**Host state, v2** (the `T.state` that core owns, persisted):

```ts
HostState = {
  v: 2,                          // NEW: state schema version
  seq: int,                      // +1 per committed change (as today's bump())
  size: 1300 | 1800 | 2400,      // unchanged in P1 (becomes `table` in P2)
  items: { [id]: Item },         // shapes unchanged in P1
  players: { [pid]: { name, color, online, hand: [{d, i}], seat } },  // `key` REMOVED
  keys: { [pid]: string },       // NEW: seat keys, moved out of players
  log: LogEntry[],               // unchanged entries {p, txt, ts, c?, n?, k?}
  rules?: { code, name, enabled, data, public },
  guestDeckChars: int,           // unchanged semantics (guest deck budget used)
  zMax: int,                     // NEW: running max z; zTop() = ++zMax
}
```

**[DECISION] Seat keys move to `host.keys`.**

- Reason: keys are a network-layer secret. From Phase 3 the whole
  `players` map is mirrored into the rules Worker and copied into patches.
  With the keys in a separate top-level map, they never travel there, and
  `players` patches can replace entries wholesale.
- `keys` is never part of a patch, a public view, a Worker snapshot or an
  export.

**The deck catalog, v2.** Image bytes leave the deck and live in the asset
store:

```ts
Deck = {
  name: string(1..24),
  back: Color | null,            // a solid-colour back only (COLOR_RE)
  backImg?: AssetId,             // NEW: an image back (was a data URL in `back`)
  imgs: (AssetId | null)[],      // ≤ MAX_DECK_CARDS; was data URLs
  cards: ( {r, s, c} | {g?, n?, txt?, col?, b?, meta?} )[],
}                                // per-card `img` is REMOVED (migrated into imgs + g)
AssetId = /^[0-9a-f]{64}$/       // hex SHA-256 of the image BYTES (not of the data URL string)
Asset   = { h: AssetId, mime: 'image/webp'|'image/png'|'image/jpeg'|'image/gif',
            size: int, data: ArrayBuffer, used: ms }
```

**[DECISION] Assets are stored as an `ArrayBuffer` plus a MIME type, not
as a `Blob`.**

- Older Safari versions had bugs storing Blobs in IndexedDB.
- An `ArrayBuffer` structured-clones everywhere.
- The page builds `new Blob([data], {type: mime})` → `URL.createObjectURL`
  once per asset, and memoizes it.

`cleanDeck` (core, synchronous):

- accepts the v2 shape only;
- `imgs` entries MUST match `ASSET_RE` or be `null`;
- `backImg` MUST match `ASSET_RE`;
- `back` MUST match `COLOR_RE` or be `null`;
- a card's `g` MUST index a non-null `imgs` entry;
- the caps stay `MAX_DECK_CARDS = 5000` cards and 24 MB of image bytes,
  where the byte total is summed from the asset sizes at ingestion.

**Ingestion** turns v1 data-URL decks into v2. It is asynchronous and
lives in `store.js`, on the page, never in core:

```ts
ingestDeck(deck: v1-or-v2 deck) -> Promise<{ deck: v2 Deck, cost: int }>
```

- **The v1 transport gate is `cleanDeckV1`** (core, synchronous): today's
  `cleanDeck`, renamed. It runs first, and the guest budget is checked on
  its result before anything is decoded (§1c).
- Every data URL (in `imgs[]`, a card's `img`, or `back`) MUST pass `IMG_RE`.
- It is decoded to bytes, and the magic bytes MUST match the declared MIME
  (PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`, GIF `GIF8`).
- **The image header is checked** (`imageDims(bytes, mime)` in `store.js`,
  pure, no decoding). It reads the pixel size from the PNG `IHDR`, the JPEG
  `SOFn` marker, the WebP `VP8 ` / `VP8L` / `VP8X` chunk, or the GIF
  logical screen descriptor. An image wider or taller than
  `IMG_MAX_SIDE` (4,096 px), larger than `IMG_MAX_PX` (16 Mpx), or whose
  header cannot be read, is refused.
  **[DECISION]** A few hundred bytes of PNG can declare 30,000 × 30,000
  pixels; decoding it would exhaust memory on every peer that renders it.
  The check runs wherever bytes enter a peer: ingestion, `putAsset` and the
  asset receive path (§1b.5).
- Each image is hashed, stored as an `Asset` (memory and IndexedDB), and
  replaced by its `AssetId`.
- A card's `img` becomes a new `imgs` entry plus its `g`. Duplicate bytes
  share one entry.
- `cost` = `JSON.stringify(cleanDeckV1(deck)).length`, exactly today's
  budget measure. The guest budget therefore keeps its meaning (1.5 M
  chars).
- Any failure throws with a readable message, such as `card 12: not a
  PNG/JPEG/WebP/GIF image` or `card 12: image is 30000 × 30000 px (max
  4096 per side, 16 Mpx)`.

**Indexes and dirty sets.** These live in core, are not persisted, and are
rebuilt by `createTable` in O(n):

```ts
T.byKind: Map<'c'|'p', Set<id>>                // P2 adds 'g'|'s'|'b'; P3 adds byAt
T.dirty = {
  items:   Set<id>,          // put/touch (an item created or changed)
  removed: Set<id>,          // remove (an item deleted)
  players: Set<pid>,         // anything in publicPlayers changed (name, colour, online, handCount, seat)
  hands:   Set<pid>,         // that player's private hand changed
  rules:   boolean,          // rules meta or public changed (see below)
  size:    boolean,
  log:     LogEntry[],       // entries appended since the last take
}
T.takeDirty() -> the above, then reset   // the app calls it once per broadcast tick
T.pub: Map<id, PublicItem>               // cached public items, refreshed for dirty ids in takeDirty()
```

- **Players.** Every mutation of a player goes through
  `touchPlayer(p, {hand})`: `ensurePlayer`, renames, online flips, seat
  assignment and every hand change (deal, draw, play, `handPile`,
  `toHand`, `takeHand`, `playFromHand`). `touchPlayer` adds `p` to
  `dirty.players`, and also to `dirty.hands` when `hand` is set.
  Phase 0's `put/remove/touch` already cover items.
- **Rules.** Scripts mutate `t.public` in place, so rules changes are found
  by comparison. `takeDirty()` compares `JSON.stringify({name, enabled,
  public})` with the last string it returned, and sets `dirty.rules` when
  they differ. It costs one stringify of a small object per tick.
- **The log.** `logEvent` pushes each new entry onto `dirty.log` as well as
  `state.log`. A collapsed duplicate adds nothing.
- **Trimming.** The bucket trimming (talk 100, loud 50, act 200) becomes a
  pure exported function, `trimLog(log)`. It keeps the **newest** N entries
  of each bucket, removing the oldest ones in a loop until every bucket
  fits. (Today's `logEvent` removes at most one entry per push, with an
  `if`; a loop makes the result independent of how entries were batched.)
  The host runs it after every push in `logEvent`; guests run it once after
  appending a patch's entries. Both copies stay identical, even when one
  action appends more than 200 entries.

**The running z.**

- `zTop()` returns `++state.zMax`; `createTable` sets `zMax` to the largest
  item `z` (or 0). A rules Worker's patch keeps `zMax` and every `z` within
  `Z_MAX` (2^52), and a resume past it renumbers the items 1…n in their
  order, so `zTop()` never leaves the integers a number keeps exactly
  (D150).
- Phase 2 adds a reserved z band for boards (`BOARD_Z0`, `boardSeq`; §2a).

### 1b. Wire protocol

**Channels after Phase 1**

| Channel | Dir | Envelope | Content |
|---|---|---|---|
| `act` | guest→host | plain | an action plus `_pid`, `_name`, `_key` and **`_v: PROTO`**; an anonymous knock is `{t:'hello', _v}` |
| `state` | host→guest | `bound(signed())` | a **snapshot** or a **patch** (below) |
| `decks` | host→guest | `signed`, from `hostPeer` only | a deck delta `{deckId: Deck v2}`, or the full catalog for a new connection |
| `rules` | host→guest | `signed`, from `hostPeer` only | unchanged: `{code, name}` |
| `note` | host→guest | `bound(signed())` | `{msg?, peek?, missing?: AssetId[], to, tp}`; `missing` is new (§1b.5) |
| `asset` | host→guest | **unsigned**; integrity by hash | **NEW**: binary bytes plus metadata `{h, mime}` |
| ~~`log`~~ | | | **RETIRED**: the log travels inside snapshots and patches |

**[DECISION] The log travels inside snapshots and patches.**

- Today the whole log (up to 350 entries) is re-sent on every log change,
  and that is the biggest per-action cost after the state itself.
- Appended entries plus the shared `trimLog` keep both copies identical.
- They are also bound to their recipient, where today's `log` channel is
  only signed.

**1b.1 Snapshot** (`kind: 'snap'`). This is the full public state for one
recipient:

```ts
{ v: PROTO, kind: 'snap', boot: ms, seq: int, host: pid,
  size: 1300|1800|2400,
  rules: { name, enabled, public } | null,
  items: { [id]: PublicItem },
  players: { [pid]: PublicPlayer },
  log: LogEntry[],                 // the whole log
  fx: Fx[], ann: string[],         // what accrued this tick (may be empty)
  to: pid | null, tp: peerId,      // bound: tp is signed in
  hand?: HandEntry[] }             // present iff `to` is non-null
```

**1b.2 Patch** (`kind: 'patch'`). It carries the changes since `base`, the
last `seq` this recipient was sent:

```ts
{ v: PROTO, kind: 'patch', boot: ms, base: int /* per recipient */, seq: int, host: pid,
  size?: int,
  rules?: { name, enabled, public } | null,   // present iff dirty.rules
  items?: { [id]: PublicItem },               // FULL replacement of each changed public item
  del?: id[],                                 // removed items
  players?: { [pid]: PublicPlayer },          // full replacement of each changed public player
  log?: LogEntry[],                           // entries to APPEND, then trimLog()
  fx?: Fx[], ann?: string[],
  to: pid | null, tp: peerId,
  hand?: HandEntry[] }                        // present iff to's hand is dirty (or `to` changed: that sends a snap)
```

**[DECISION] Patches replace whole items. There is no field-level diff.**

- Reason: a public item is under 150 bytes, so replacing it keeps a move
  well under the 1 KB budget.
- It is simple and obviously correct, and the reduction rules
  (`publicItems`) apply per item unchanged.

**1b.3 Host broadcast tick.** The tick still coalesces for 40 ms
(`scheduleBroadcast`). On each tick:

```js
const d = T.takeDirty(), cur = state.seq, now = Date.now();
const shared = buildShared(d);                    // items/del/players/log/rules/size/seq + fx/ann drained
for (const peer of Object.keys(room.getPeers())) {
  const p = peerPid[peer], to = p && own(state.players, p) ? p : null;   // §3f: a _join may still be queued
  const st = sync.get(peer);
  if (!st || st.to !== to || (st.needSnap && now - st.snapAt >= SNAP_MIN_MS)) {   // join, reload, gap, (re)registration
    send(snapshot(to));
    sync.set(peer, { seq: cur, to, snapAt: now, needSnap: false });
  } else if (!isEmpty(shared) || mine(d, to)) {
    send(patch(shared, st.seq, to));              // base = what THIS peer last received
    st.seq = cur;
  }                                               // else: nothing for this peer; its base stays put
}
```

- **`isEmpty(shared)`** ignores the envelope fields (`v`, `kind`, `boot`,
  `seq`, `host`).
- **`mine(d, to)`** is true when this tick has a per-recipient part for
  `to`: `d.hands.has(to)` (Phase 1), `d.asks`, `d.hints` or `d.secret` has
  it (Phase 3), or it has `vis` overrides (Phase 5). An anonymous peer
  (`to === null`) has none.
- **[DECISION] The patch base is per recipient.** A commit that changes
  only host-private state (`rules.data`, `_timers`; from Phase 3 a hint,
  ask or secret of someone else) produces an empty shared part, and peers
  are sent nothing. Their `sync.seq` must not advance, or every peer's next
  patch would look like a gap and the whole table would re-snapshot. With
  `base = st.seq` the chain stays unbroken: every tick with a non-empty
  shared part is sent to every synced peer, so whatever lies between
  `st.seq` and `cur` is exactly this tick's changes plus changes that
  peer cannot see.
- **`sync`** is host-only, per peer, and deleted in `onPeerLeave`. A
  `needSnap` that is still inside its 3 s window stays set, and is served
  on the first tick after the window (the 1b.7 timer schedules one).
- **The host renders its own view** from the same `shared`. It applies the
  patch to `view` with `to = pid`, through the guest code path, and never
  seals for itself.
- **Serialization SHOULD be done once per tick.** Build the `shared` JSON
  text once, **without** `to`, `tp`, `base` or any per-recipient part.
  Each per-peer body is then `prefix + rest`, where:
  - `prefix` = `'{"to":…,"tp":…,"base":…'`, then `',"hand":…'` and the
    other per-recipient parts that are present;
  - `rest` = `shared === '{}' ? '}' : ',' + shared.slice(1)`.

  `seal` signs that string, through a new `sealText(str)` that takes a
  pre-serialized string. Snapshots for several peers in one tick reuse a
  shared `itemsJSON` the same way.

**1b.4 Guest receive.** This replaces `handleState`:

```text
unseal → (bound) d.tp === selfId → d.v === PROTO else toast once "The host runs a different version of Card Table — reload this page" + console.error, drop
if role === 'host': demotion check as today (s.seq > host.seq || tie && peer < selfId) for BOTH kinds;
                    on demotion: clear `sync`, reject queued jobs, cancel the save throttle and stop
                    persisting (from Phase 3 also terminate the Worker, §3f.1), then accept as a guest
if d.to && d.to !== pid: drop (a replay)
kind 'snap':  accept iff d.boot > view.boot || (d.boot === view.boot && d.seq >= view.seq)
              → view = {…}, gameLog = d.log, myHand = d.hand ?? [], full render (renderItems(null))
kind 'patch': if d.boot === view.boot && d.base === view.seq → apply:
                prev = capture view.items[id] for every id in items ∪ del
                Object.assign(view.items, d.items); for id of del: delete view.items[id]
                Object.assign(view.players, d.players); if 'rules' in d: view.rules = d.rules; if d.size: setTableSize
                if d.log: gameLog.push(...d.log), trimLog(gameLog); if 'hand' in d: myHand = d.hand, handSig = ''
                view.seq = d.seq; renderItems(prev) (dirty-set render), cheap renderers as today
              (a patch whose only content is a per-recipient part, such as `hand`, is valid: it advances view.seq)
              else if d.boot < view.boot || (d.boot === view.boot && d.seq <= view.seq): ignore (stale or duplicate)
              else: GAP → console.warn('state gap', view.seq, '→', d.base); requestSnap()
```

- `requestSnap()` calls `act({t:'snap'})` at most once per 3 s.
- While waiting, the net-status tooltip says "re-syncing with the host…".
- A guest whose patch is ignored stays on its old view until the
  snapshot arrives. It NEVER applies a patch out of order.
- `fx` and `ann` are shown for both kinds, as today.

**1b.5 Assets** (the pull model, from the host only)

- **Guest.** On every `decks` (and, in Phase 2, `boxes`) message:
  - collect the referenced `AssetId`s;
  - skip those in memory, then (asynchronously) those in IndexedDB;
  - batch the rest into `act({t:'need', a:[≤64 ids]})` requests;
  - put the requested ids in `pending`, with a timestamp.
- **Host.** It serves an id only when **this table** references it: the
  id must be in `T.assetRefs()`, the set of asset ids used by the
  in-memory catalog (deck `imgs` and `backImg`; from Phase 2, box `imgs`).
  - Any other id is ignored with `console.warn`, and is not answered.
    **[DECISION]** The asset store is shared by every room this browser
    has hosted. Serving any held hash would let a guest probe for, or
    download, the images of the host's other tables.
  - A referenced id that the host no longer holds (evicted from
    IndexedDB, or never stored) is answered with one note,
    `{missing: [h…]}`, and `console.error`.
  - A referenced id that it holds, and has not sent to this peer in the
    last 60 s, is sent with `assetA.send(bytes, {target: peer}, {h, mime})`.
  - **Pacing:** at most `ASSET_INFLIGHT` (2) sends are in flight per peer,
    each one awaited before the next starts. Patches and notes are never
    queued behind assets, so play stays live during a large pull.
  - Each peer has a byte budget of 64 MB per 60 s. Beyond it, the host
    calls `console.warn` and sends the peer one note: "🚫 Too many image
    requests — slow down".
- **Guest receive.** The guest accepts an asset only when all of these hold:
  - `peerId === hostPeer`;
  - `h ∈ pending`;
  - `bytes.byteLength ≤ ASSET_MAX_BYTES` (2 MB);
  - `mime ∈ IMG_MIMES` and the magic bytes match;
  - the header passes `imageDims` (§1a: ≤ 4,096 px per side, ≤ 16 Mpx);
  - `sha256hex(bytes) === h`.

  Then it stores the asset (memory first, then IndexedDB) and re-renders
  the items whose face uses it (§1g, "late arrivals"). An asset that
  fails any check other than `h ∈ pending` is a mismatch (below). An
  asset nobody asked for is dropped with `console.warn` and no toast.
- **On a mismatch** the guest calls `console.error` and shows one toast
  ("A card image from the host was damaged in transit — retrying"). It
  re-requests once, then gives up with an error toast.
- **Timeouts and missing images.** A pending request that is not answered
  within `NEED_TIMEOUT_MS` (20 s) is re-requested once. When the retry
  also times out, or a `missing` note names the id, the guest stops
  waiting: the faces that use it render as `.face.missing` (a struck-out
  image icon on the card colour), it calls `console.error`, and it shows
  one toast per batch: "N card images are missing on the host — ask them
  to re-add the deck". The wait never lasts forever.
- **The host's own images** come from IndexedDB on demand. Until one is
  loaded, a face renders as `.face.loading`, as for a missing deck today.
  An id that IndexedDB does not hold renders as `.face.missing`.
- **The host's boot check.** After `becomeHost`, the host checks
  (`store.has`) every id in `T.assetRefs()`. If any are missing, it calls
  `console.error` and toasts once: "N card images of this table are
  missing from this browser's storage".
- **Guests uploading decks.** `addDeck` still carries data URLs. The
  uploading guest ingests its own deck locally first, so it already holds
  every asset by the time the host's `decks` message arrives: no image
  makes a round trip.

**1b.6 Version gate**

- `PROTO = 2` in Phase 1. Every later phase increments it (see §0.2).
- **On the host**, an action (knock included) whose `_v !== PROTO` is
  refused: `refuse(peer, 'This table runs a different version of Card
  Table — reload this page')`. The peer is not registered and receives no
  state.
- **On a guest**, a mismatched `v` is dropped with one toast.
- **[DECISION] A version gate, rather than silent incompatibility.**
  GitHub Pages caches for about 10 minutes, so mixed versions are real
  right after a deploy. Without the gate, an old guest would misread a
  patch as a whole state and show a broken table without a word.
- **Module skew inside one page.** Pages caches each file separately
  (`max-age=600`), so one page could run a new `app.js` with a stale
  `core.js`, and `PROTO` (which lives in `core.js`) could not see it.
  - Every import specifier carries `?v=MODULE_V` (§0.2), so a fresh
    `app.js` always fetches the matching modules.
  - At boot, `app.js` asserts that every imported module's `MODULE_V`
    equals its own. On a mismatch it does not start: `console.error`, and
    a full-width banner "Card Table was updated while this page loaded —
    reload this page".
  - The rules Worker checks `init.proto === PROTO && init.mv === MODULE_V`
    (§3f.2), and otherwise posts `evalError` "version mismatch"; the host
    toasts "Card Table was updated — reload this page to run rules".
  - **[DECISION]** A per-module version, checked at boot. Without it, skew
    shows up as arbitrary `TypeError`s far from their cause.

**1b.7 Snapshot requests and gaps (host)**

- `{t:'snap'}` sets `sync.get(peer).needSnap = true` and schedules a
  broadcast.
- **Rate limit.** Each peer is sent at most one requested snapshot per
  `SNAP_MIN_MS` (3 s), measured from `snapAt`, which is set on **every**
  snapshot sent to that peer. A request inside the window is not served
  early: it stays pending, and the host arms one timer that schedules a
  broadcast when the window ends. Extra requests are counted, and logged
  with `console.warn` once per window.
- **Anonymous knocks** (`hello` without `_pid`) set `needSnap` for their
  peer under the same limit. Today a knock triggers a full broadcast; a
  snapshot is now about 160 KB plus a signature, so unlimited knocks would
  be a cheap way to make the host sign and send megabytes.
- A new connection gets a snapshot automatically: its `sync` entry is
  missing.
- A peer whose `to` changes gets a snapshot automatically. That happens on
  registration, and it delivers the hand. Registration happens once per
  connection ("One seat per connection"), so it cannot be used to bypass
  the limit.

### 1c. Actions

| Action | Payload | Validation | Semantics | Log | Flood | Ruled |
|---|---|---|---|---|---|---|
| `snap` | `{}` | needs a registered player | `needSnap` for the sender's peer (rate-limited, 1b.7) | — | 1 token | no |
| `need` | `{a: AssetId[≤64]}` | each entry matches `ASSET_RE` (others dropped); needs a registered player | serve the ids this table references; answer `missing` for referenced ids the host lacks; ignore the rest (1b.5) | — | 1 token, plus the byte budget | no |
| `addDeck` | unchanged (data URLs) | synchronously, on receipt: `cleanDeckV1`, then (guests) the budget check on `JSON.stringify(cleanDeckV1(deck)).length`. Then `ingestDeck` runs in the preprocessing stage (below), outside the FIFO. On any failure: `notify(p, '🚫 Deck rejected: …')`, nothing queued | as today; the stored deck is v2; the budget uses `cost`, and is checked again at commit | unchanged | unchanged | yes (unchanged) |

Further rules for Phase 1:

- **The action whitelist.** Every guest action type MUST be in the exported
  `PUBLIC_ACTIONS` set; anything else is refused with `console.warn` and a
  notice. Types beginning with `_` are host-internal (Phase 3) and are
  never accepted from the wire. **[DECISION]** An explicit whitelist at the
  network boundary. Today an unknown type falls through to
  `default: console.warn`, which is too permissive once internal action
  types exist.
- **The host action queue.** Every state-changing action goes through one
  host-side FIFO, `queue`, rules or not. Each job is
  `{p, a, peer?, resolve}`.
  1. **Preprocessing** (asset ingestion for `addDeck`, and in Phase 4
     `addBox`) runs **before** the job enters the FIFO, in a separate
     stage: one chain per player, so each player has at most one ingestion
     running. The job is enqueued when its ingestion resolves. A failure
     resolves `{error}` with the notice, and nothing is enqueued.
  2. `T.apply(p, a)`: synchronous in Phases 1–2, and through the Worker
     from Phase 3.
  3. Commit: `seq++`, `scheduleBroadcast()`, `persist()`, then drain the
     side-effect queues.

  - **[DECISION] Ingestion runs outside the FIFO.** Decoding and hashing a
    24 MB deck takes seconds; inside the FIFO it would freeze every
    player's moves for that long. The cost is that a deck commits in the
    order its ingestion finishes, not in arrival order; nothing on the
    table can refer to a deck before it commits, so no action depends on
    that order. The guest budget is checked synchronously on receipt
    (before any decoding) and again at commit, since another guest's deck
    may commit in between.
  - A job on an empty FIFO runs synchronously in the same task. That keeps
    today's synchronous feel for the host's own clicks. `act()` on the host
    returns a Promise of `{ok, error?}`.
- **Delta-safe refusals.** Today a veto calls `bump()`, which re-broadcasts
  the whole state and so reverts the actor's optimistic drag. With deltas,
  that only happens if the refused action's items are re-sent. So whenever
  an action is **vetoed or refused** (rules veto, flood, and from Phase 2
  owner, lock and caps), core MUST:
  - `touch()` every still-existing item the action names (`id`, `pile`,
    `onto`, `ids[]`, `bag`);
  - `touchPlayer(p, {hand:true})` when the action involves the hand
    (`play`, `handPile`, `toHand`, `draw`, `answer`).

  The next patch then re-sends the true positions and the hand.
  `state.seq` still increments, because the veto's log line is a change.
  From Phase 3 the same touches also follow every **handled** action
  (§3f.4), because a script that handles a drop without moving the dragged
  item would otherwise leave the actor's optimistic position standing.

### 1d. Public view and hidden information

There is no change in **what** anyone sees. The shapes are today's
`publicItems` and `publicPlayers`, delivered incrementally:

| Item state | Everyone receives |
|---|---|
| card face up | `{k:'c', x, y, rot, z, d, i, up:true}` |
| card face down | `{k:'c', x, y, rot, z, d, up:false}` (no `i`) |
| pile | `{k:'p', x, y, rot, z, name, n, top}`, where `top` is `{d, i, up:true}` when face up and `{d, up:false}` when face down; a pile's `cards` never leave the host |
| player | `{name, color, online, handCount, seat}` |
| hand | per recipient only (`hand` in a snap or patch addressed to that `to`) |

- **The incremental view must equal the full one.**
  `T.pub.get(id)` MUST deep-equal `publicItems()[id]` for every id, at
  every commit.
- **A test asserts it.** The Node test runs a random 500-op sequence and,
  after each op, compares `T.pub` with a full recompute.

### 1e. Facade (`t`) additions

| Call | Returns | Notes |
|---|---|---|
| `t.item(id)` | a copy `{id, ...item}` (a pile's `cards` array copied), or `null` | O(1) apart from the copy. Replaces the `t.items().find(x => x.id === id)` idiom. |
| `t.find(q)` | an array of copies | `q = {kind?: 'card'\|'pile', name?: string (piles; exact, case-insensitive), up?: boolean}`. Uses `byKind`. An unknown filter key throws `TypeError("t.find: unknown filter 'zone' — known: kind, name, up")`; Phases 2 and 3 add keys. |
| `t.piles()` | unchanged result | Now iterates `byKind.get('p')` only. |
| `t.items()` | unchanged (a deep clone of all items, O(n)) | ENGINE.md documents the cost and recommends `t.item` and `t.find`. |

- Reads are not logged. Copies are plain, mutable and detached: changing
  one never changes the table.
- **[DECISION] Copies, not frozen proxies.** A script holding a reference
  across hooks must never see the table change under it.
- **The data-size guard.** It applies from Phase 1 but matters most from
  Phase 3. After each hook, `JSON.stringify(t.data).length` MUST be ≤
  `DATA_MAX_CHARS` (4e6). Otherwise the hook fails with
  `t.data is too large (N chars, max 4,000,000)`, and the rules disable
  loudly.

### 1f. Worker

Not in this phase. Phase 1 MUST however build the dirty-set and patch
machinery so that Phase 3 can reuse it: `takeDirty`, and
`applyStatePatch` (§3f.6).

### 1g. UI and interaction

- **No visible change**, apart from these:
  - faces wait for their assets with the existing `.face.loading` look,
    and a face whose asset is missing shows `.face.missing` (1b.5);
  - storage failures show toasts (1h);
  - a resync shows in the net-status tooltip.
- **Late arrivals.** Dirty-set rendering only redraws items whose public
  data changed, so data that arrives *after* the items needs its own path.
  - The client keeps `itemsByDeck: Map<deckId, Set<id>>` and
    `itemsByAsset: Map<AssetId, Set<id>>` (Phase 2 adds
    `itemsByBox: Map<boxId, Set<id>>`), updated in `renderItems` from each
    item's public face (a pile counts through its `top`).
  - When a deck, box or asset arrives (or an asset fails as missing), the
    client re-renders exactly those items, resets `handSig` (the hand may
    hold placeholders), and redraws an open zoom or peek overlay that shows
    it.
  - Today's NET-3 check in `t-sync-ui.js` (a deck that arrives after its
    cards) covers the deck case; `t-p1-assets.js` covers assets.
- **Dirty-set rendering.**
  - `renderItems(prev)` touches only the ids in `prev`, a
    `Map<id, previousPublicItem|undefined>` (undefined = new). Removed ids
    are in `prev`, and absent from `view.items`.
  - `renderItems(null)` is the full diff, used after a snapshot.
  - Motion detection (`motionSources`, `flyToSeat`, flips) reads `prev`
    instead of the `shown` map: piles that shrank and hands that shrank.
    The `shown` map is deleted.
  - `renderPlayers`, `renderHand`, `renderLog` and `renderRulesBtns` keep
    their signature caches.
  - `renderLog` SHOULD append the DOM for new entries. It rebuilds only
    when an entry was trimmed or names changed.
- **CSS.** Add `.item { contain: layout style; }`. Do not use `paint`
  containment: it would clip the selection outline and shadows.
- **A test hook, also used by tests in later phases.**
  - If `window.CARDTABLE_TEST` is truthy at boot (set by the harness's
    init script), `app.js` exposes
    `window.__ct = { act, view: () => view, hand: () => myHand, log: () => gameLog, perf }`.
  - `perf` holds counters and the last durations; see 1k.
  - It is never set in production.
  - **[DECISION]** Tests need to compare full views and to send many
    actions quickly. The hook only reaches the local player's own `act()`,
    which a user could already call from devtools, so it adds no
    capability.

### 1h. Persistence: IndexedDB

**The database** is `cardtable`, at version 1. All of it lives in
`store.js`.

| Store | Key | Indexes | Record |
|---|---|---|---|
| `saves` | `room` | — | `{room, ts, v, state: HostState}`, or `{room, ts, lost: string}` |
| `catalog` | `['room', 'id']` | `room` | `{room, id, kind: 'deck', deck: Deck}` (Phase 2 adds `kind: 'box', box: Box, src, by?`). Written once when the deck is added, and never changed during play. Only a migration (`MIGRATE[v]`, inside its one transaction) may rewrite catalog records. |
| `assets` | `h` | `used` | `{h, mime, size, data: ArrayBuffer, used}` |

- **What stays in localStorage:** `ct-pid*`, `ct-name`, `ct-hostkey-*`,
  `ct-sort`, `ct-handh`, and the new `ct-pending-<room>` (below).
  `ct-save-*` and `ct-decks-*` are only read, for migration.

**`store.js` API** (every function async; every failure logs with
`console.error` and then rejects with an `Error` whose message is readable):

```ts
open() -> Promise<void>                       // idempotent; rejects if IndexedDB is unavailable
loadSave(room) -> Promise<{state, decks} | {lost} | {newer: v} | null>   // includes the v1 localStorage migration
writeSave(room, state, newCatalog: {id, kind, deck|box}[]) -> Promise<void>   // ONE transaction over saves + catalog
putAsset(data: ArrayBuffer, mime) -> Promise<AssetId>   // verify (MIME, magic bytes, size), hash, store, memo; returns the id
getAssetURL(h) -> string | null               // synchronous memo lookup (object URL)
loadAsset(h) -> Promise<string | null>        // memo, else IndexedDB → object URL
has(h) -> Promise<boolean>
gc({keep: Set<AssetId>}) -> Promise<{deleted, bytes}>   // never deletes `keep`, nor anything used in the last hour
prune(exceptRoom, need) -> Promise<number>    // deletes other rooms' saves, oldest first (see below)
```

**The save flow (host)**

- `persist()` throttles to one save per second, as today, and (after the
  Phase 2 close-out review) never starts one sooner than 250 ms after the
  change that asked: out of that change's own burst of work (B6). A page's
  first save starts at once (it puts the table in storage).
- `doSave()` is async, with one write in flight; a request made during a
  write sets `again`.
- `state` is written as a structured clone. `put()` clones synchronously,
  so later mutations cannot leak into the stored copy.
- New catalog entries (decks not yet in `savedCatalog: Set`) go into the
  same transaction.
- **pagehide.** IndexedDB writes started in `pagehide` are not guaranteed
  to commit. So `pagehide`:
  1. synchronously sets `localStorage['ct-pending-<room>'] = String(seq)`;
  2. starts `doSave()`;
  3. a successful commit removes that key.
- **Boot.** If `ct-pending-<room>` holds a seq greater than the loaded
  save's `seq`, the host warns. It calls `console.warn` and shows a toast:
  "The last moment of play before the reload wasn't saved (the browser
  closed first)". It then removes the key.
- **[DECISION] The pending marker.** Today's synchronous localStorage save
  guaranteed no loss. This keeps any loss loud instead of silently resuming
  an older state (CLAUDE.md).

**The load flow and the role decision (boot).** Today `boot()` decides
the role from the synchronous localStorage save:
`hosting = !AS && (!m || saved)`. With saves in IndexedDB the decision
MUST wait for storage, or a reloading host whose `open()` fails would
become a guest of its own room, forever. For an invite link (`m` set),
before choosing the role:

1. `await store.open()`.
   - On failure (`idbFailed`): toast "This browser blocks storage
     (IndexedDB: …) — the table can't be saved; reloading the host tab
     will reset it". A host then runs unsaved, and `persist()` becomes a
     no-op that has warned once.
   - **No fallback to localStorage writes.** **[DECISION]** A fallback
     would be the silent masking CLAUDE.md forbids, and localStorage cannot
     hold a big table anyway.
2. `save = await loadSave(room)` (skipped when `idbFailed`):
   - read IndexedDB;
   - if there is no record, read the legacy `ct-save-<room>` and
     `ct-decks-<room>`, and **migrate** them (below). A legacy `{ts, lost}`
     marker migrates as a `{room, ts, lost}` record;
   - write the result to IndexedDB in one transaction;
   - **only after that transaction commits**, remove the legacy keys.

   If the migration fails, the legacy keys stay, and the host resumes from
   the migrated in-memory copy, with a toast "Couldn't move this table's
   save to the new storage: …".
3. **The role:**

   ```js
   hosting = !AS && (!m || save || lostMarker || (idbFailed && hasHostKey(room)))
   ```

   - `lostMarker`: the record is `{lost}`. The host resumes a fresh table
     loudly, as today.
   - `hasHostKey(room)`: `localStorage['ct-hostkey-<room>']` exists. A
     browser that holds the room's key but cannot read its storage is
     still the host; it resumes an empty table, loudly (the open-failure
     toast above).
   - The existing `useHostKey` check then runs as today.
   - **[DECISION]** The host key, not the save, is the fallback proof of
     ownership: it lives in localStorage, which a failed IndexedDB does not
     affect.
4. **A save from a newer version** (`v > STATE_V`, the newest `MIGRATE`
   target) is refused: `loadSave` returns `{newer: v}`, the tab still hosts
   (the save proves ownership), but it does **not** resume and never writes
   that room's save. It shows a persistent toast "This table was saved by a
   newer Card Table — reload this page", with `console.error`, and
   `persist()` stays a no-op until a reload. **[DECISION]** Mixed versions
   exist for about 10 minutes after a deploy; an old tab must never
   overwrite a newer save with a downgraded one.
5. Every `catalog` record goes through `cleanDeck`. A bad record is
   dropped with `console.error`, as `becomeHost` does today.

**Migration v1 → v2** (`MIGRATE[1]`, given `{state, decks}` in legacy form):

- `state.keys = {}`; for each player with `.key`, move it into
  `keys[pid]`, then delete `.key`.
- `state.zMax = max(z)`.
- `state.v = 2`.
- Older shapes are handled first, exactly as `becomeHost` does today:
  `log ||= []`, `size ||= 1300`, seats assigned, items clamped.
- Each deck goes through `await ingestDeck(deck)`. A deck that fails is
  dropped with `console.error` and one toast naming it.

**Quota handling.** This applies to any `QuotaExceededError` (a
`DOMException`) in `writeSave` or `putAsset`.

1. **Host save.** Prune the saves of other rooms, oldest first, with their
   catalog records (`prune(room, need)`).
   - Saves whose `ts` is under 30 s old are spared: another tab is hosting
     that room.
   - If the bytes of all candidates together are under `need`, nothing is
     pruned, as today (`need` ≈ the serialized size of this save plus its
     new catalog entries).
   - After each pruned room, run `gc` over the assets that no catalog
     record still references, then retry.
   - On success: toast "Browser storage was full — deleted N old table
     save(s) to keep this one".
2. **Still failing.**
   - Write `{room, ts, lost: 'browser storage is full'}`.
   - Show the toast once: "Can't save this table (browser storage is full)
     — reloading the host tab would reset it".
   - The next successful save rewrites the catalog. `savedCatalog` is
     cleared, because a lost marker means the catalog may be incomplete.
3. **`putAsset` on a guest.**
   - Run `gc` (least recently used first) over assets no catalog record
     references, then retry once.
   - On failure, keep the asset in memory only, with one toast: "Couldn't
     cache card images on this device (storage full) — they'll download
     again next time".

**Upkeep**

- **GC policy.** After boot, when idle (`requestIdleCallback`, or
  `setTimeout` 5 s), delete the assets that no `catalog` record references
  and that have not been used for 14 days. Separately, unreferenced assets
  (a guest's cache) are capped at 500 MB, least recently used first.
  - `keep` always includes `T.assetRefs()`, the ids referenced by the
    **in-memory** catalog (a deck added in the last second may not be in
    a catalog record yet), and on a guest, the ids of `pending`.
  - Assets used in the last hour are never deleted.
- **`used` timestamps.** One is bumped at most once a day per asset, in a
  batched transaction.
- **Persistence.** `navigator.storage.persist?.()` is called once, from
  inside the host's first upload gesture (a deck, or a box from Phase 4),
  never at boot, and the result is logged with `console.info`.
  **[DECISION]** Firefox shows a permission prompt for it; a prompt out of
  nowhere at boot would be confusing, while one right after an upload
  explains itself.
- **`onversionchange`.** `db.close()`, then a toast: "Card Table was
  updated in another tab — reload this tab to keep saving".

### 1i. CLI bridge

- No command changes in Phase 1. The snapshot fields keep their shape,
  because `cliSnapshot` reads `view`, which keeps its shape.
- `seq` is now the patch seq.
- The tab must keep pushing after every patch. `push()` runs on a 500 ms
  interval and compares JSON, so it already does.
- `cli.js`, `cli.py` and `cah-bot.py` need no change. The existing CLI
  suites must pass unmodified.

### 1j. Security

**Gates**

- Snapshots and patches are sealed and bound exactly like states today:
  - an unsigned body, or one signed with another key, is dropped
    (`unseal`);
  - a body with `tp ≠ selfId` is dropped;
  - a body with `to ≠ pid` is dropped.
- A patch whose `base` does not match is never applied, so a replayed old
  patch is inert.
- `asset` is unsigned by design. It is safe because of the pull model: a
  guest accepts only requested hashes, only from `hostPeer`, within the
  size cap, with the MIME and magic check, and with SHA-256 equality.
  Image bytes are only ever rendered through `<img src=blob:…>` with an
  image MIME.
- `need` and `snap` require a registered player, and are flood- and
  budget-limited.
- The `PUBLIC_ACTIONS` whitelist and the `_v` gate.
- IndexedDB only ever stores verified assets, and decks that passed
  `cleanDeck`.

**Attacker cases to test** (Mallory, a raw peer, as in `t-sec.js`; she
now sends `_v`):

1. A patch signed by Mallory's own key, and a correctly signed patch
   relayed with `tp` set to the victim: both dropped. The victim's view is
   unchanged.
2. Mallory sends an `asset` whose bytes do not match its `h`, and an asset
   nobody asked for: both ignored (`console.warn`, no toast). The mismatch
   case from the real host is covered by the guest-side check of a
   tampered transfer, which the test simulates by hooking the host's send.
3. 1,000 `need` requests: the budget holds, and the host stays responsive.
   A host-side main-thread long task stays under 50 ms.
4. 100 `snap` requests in 1 s: at most one snapshot per 3 s is sent.
5. 100 anonymous `hello` knocks in 1 s from one peer: at most one
   snapshot per 3 s is sent to it.
6. An action with `_v: 1`, or none: refused with the reload note, and no
   seat is created.
7. An action `{t:'_join'}` or `{t:'__proto__'}`: refused, with no state
   change.
8. Mallory sends `need` for the hash of an image that only another room of
   this host uses (planted in the host's asset store): nothing is sent,
   and no `missing` note either.
9. A decompression bomb: a 1 KB PNG whose `IHDR` declares 30,000 ×
   30,000 px, inside an `addDeck` from Mallory, and as an `asset` the test
   injects on a guest: refused by `imageDims` on both paths, and no peer
   decodes it.

### 1k. Performance budgets

The benchmark suite is `tests/t-p1-bench.js`, run alone (see 1l), plus the
Node file `tests/core-p1-bench.mjs`. Each budget is asserted; a regression
fails the suite.

| # | Budget | Setup | How it is measured |
|---|---|---|---|
| B1 | Wire bytes per `move`, per peer: **≤ 1,024 B** (sealed body) | Node: core with 1,000 loose cards, 8 recipients | `JSON.stringify(sealText(body)).length` for a single-item patch, using WebCrypto in Node (`crypto.webcrypto`). The whole sealed object is measured, because JSON-escaping the embedded `b` string inflates it. |
| B1' | The same, observed on the wire: **≤ 1.5 KB** per move | browser: host plus 2 guests, 1,000 cards | an init script wraps `RTCDataChannel.prototype.send` and sums `byteLength` (or `length`) per channel; 50 moves by one guest; average bytes per move received by the other guest, Trystero framing included |
| B2 | Host apply, patch build and seal enqueue: **≤ 5 ms p95** | Node: 1,000 items, 8 recipients, 200 moves | `performance.now()` around `T.apply`, `takeDirty`, `buildShared` and 8 `sealText` calls (the WebCrypto signing is awaited, but the budget counts only synchronous time before the first await) |
| B3 | Guest apply and render of a one-item patch: **≤ 4 ms p95** | browser guest, 1,000 cards | `__ct.perf.lastApplyMs`, recorded by the app around `applyPatch` and `renderItems(prev)` when `CARDTABLE_TEST` is set |
| B4 | Panning on an emulated phone: **no long task over 50 ms**, and **rAF interval p95 ≤ max(20 ms, 1.25 × empty-table p95)** | iPhone 13 device descriptor, CDP `Emulation.setCPUThrottlingRate {rate: 2}`, 1,000 cards | a 3 s scripted felt-drag pan; a PerformanceObserver for `longtask`; rAF timestamps collected in-page. The relative clause makes the budget robust on a loaded CI machine. |
| B5 | Snapshot at 1,000 items: **≤ 160 KB** JSON, built in **≤ 15 ms** | Node | `JSON.stringify(snapshotBody).length`; timing as for B2 |
| B6 | Host save main-thread time: **≤ 8 ms** at 1,000 items | browser host | `__ct.perf.lastSaveSyncMs`, around the synchronous part of `doSave` (the `put` call) |
| B7 | Indexed reads: 400 `t.item(id)` plus 50 `t.find({kind:'pile'})` in one hook: **≤ 20 ms** | Node, 1,000 items | timing around a synthetic hook |
| B8 | Rejoin with a warm cache: **0 asset bytes** re-sent | browser: a guest with a 40-image deck reloads | `asset` bytes counted by the B1' wrapper after the reload: 0 |

**[DECISION] How the budgets read TABLETOP's targets.**

- TABLETOP §8 asks for "steady 60 fps panning". B4 asserts no long task
  and a relative frame-interval bound instead, because an absolute 60 fps
  assertion on an emulated phone on a shared 4-CPU CI machine would fail
  for reasons unrelated to the code. The intent (panning cost independent
  of item count) is what B4 measures.
- TABLETOP's "under 1 KB per move" is B1, the sealed body. B1' measures
  the same move on the wire, including Trystero's framing and chunk
  headers, which the app does not control, so it allows 1.5 KB.

**How the 1,000-card table is built** (Phase 1 has no pieces):

- The harness enables a throwaway script whose `setup` calls
  `t.addStandardDeck()` 20 times and deals 1,000 cards face up in a grid
  with `t.deal(pile, {x, y, up: true})`.
- That needs a large table. The test sets the size to large (2400), and the
  grid stays inside `PLAY_R`.

### 1l. Test plan (Phase 1)

**Existing suites that must change**, for protocol and storage reasons
only. Their assertions keep their meaning; only the mechanism changes.

**Shared mechanisms** (in `tests/h.js` and `tests/final-lib.js`):

- **`_v` on every raw peer.** Every raw send (Mallory, spies, relays)
  carries `_v: PROTO`, read with `const {PROTO} = await import('../core.js')`,
  never hard-coded.
- **Bodies parsed by `kind`.** A helper `bodies(raw)` unseals and returns
  `{kind, items, players, log, …}` for both snapshots and patches; a helper
  `viewFrom(bodies)` folds them into a full view for "what did Mallory
  see" assertions.
- **An IndexedDB reader in page context.** `idb(page, store, key?)` runs
  `indexedDB.open('cardtable')` inside `page.evaluate` and returns plain
  JSON (assets as `{h, mime, size}`). It replaces every read of
  `ct-save-*` and `ct-decks-*`.
- **A quota stub.** An init script makes `IDBObjectStore.prototype.put`
  throw `new DOMException('…', 'QuotaExceededError')` for a chosen store
  while `window.__quota` is set. It replaces the stub on
  `Storage.prototype.setItem`.
- **Planting.** Planting a legacy `ct-save-<room>` / `ct-decks-<room>` in
  localStorage still works (it is migrated on boot); a planted v2 save goes
  through a `plantSave(page, room, state, decks)` helper that writes
  IndexedDB from an init script.

**The suites:**

| Suite | What changes |
|---|---|
| `t-sec.js` | `_v`; `statesSeen` uses `bodies()`; the listener on the retired `log` channel is removed, and log assertions read the `log` of snapshots and patches. |
| `final-lib.js` (every `t-final-*`) | Mallory sends `_v` on every action. Without it, every attack would be refused by the version gate before it reached the code under test, and the suites would pass vacuously. |
| `t-sync-relay.js` | The spy's raw `hello` carries `_v`. |
| `t-sync-net.js` | The save layout, quota, lost-marker and pruning checks use `idb()`, the `put` quota stub, and `{room, ts, lost}` records. |
| `t-engine.js` | Players planted through the legacy `ct-save-*` (migrated on boot) or `plantSave`; state bodies parsed with `bodies()`. |
| `t-final-sec.js`, `t-decks.js` | Reads of `ct-decks-*` and `ct-save-*` become `idb()` reads of `catalog` and `saves`. |
| `t-sync-hidden.js` | "A state with a 50-card pile stays under 1,200 bytes" now measures the **patch** that carries that change. A snapshot carries the whole log, so its size is no longer independent of history. The assertion's point (independent of pile size, SEC-11) is unchanged. |

Any other suite that fails for one of these reasons gets the same
mechanism, and is listed in the phase's PR description. No assertion is
deleted or weakened.

**New suites**

| Suite | Checks |
|---|---|
| `core-p1.test.mjs` (Node) | (1) `T.pub` equals the full `publicItems()` after each of 500 random ops: every Phase 1 action, plus rules ops through `T.api`. (2) Applying the per-tick patches to a copy of a snapshot reproduces the next snapshot exactly, for items, players, log and hands, including ticks where a peer is sent nothing (per-peer `base`). (3) `trimLog`: identical on both sides for 1,000 mixed entries, and one action that appends 250 `act` entries leaves the same 200 on both sides. (4) `zTop` is monotonic, and `zMax` is restored by `createTable`. (5) `t.item` and `t.find` return detached copies: mutating the result leaves the state untouched, and an unknown key throws. (6) `MIGRATE[1]` moves keys into `keys`, computes `zMax` and sets `v:2`. (7) A veto touches the named items and the hand (1c). (8) The body splice (1b.3) parses as JSON for an empty and a non-empty shared part, with and without a hand. (9) `imageDims` reads the size of PNG, JPEG (baseline and progressive), WebP (`VP8 `, `VP8L`, `VP8X`) and GIF fixtures, and refuses truncated headers. |
| `t-p1-delta.js` | (1) Host plus 2 guests; 500 random UI and `__ct.act` actions (moves, flips, deals, plays, chats, renames): each guest's `__ct.view()` items, players and log, and `__ct.hand()`, deep-equal the host's public view and that player's hand. (2) A dropped patch: an init-script hook drops one incoming `state` message on guest B (test-only, through a wrapped `onMessage`); B requests a snapshot within 3 s and converges. (3) The host reloads mid-game: guests accept the new `boot` snapshot and converge. (4) A guest reloads: it gets a snapshot, and its hand is intact. (5) A vetoed drag reverts on the guest with deltas: Turn order is enabled, an off-turn guest's `play` is blocked, and the card is not on the table on any screen. (6) The version gate: a raw peer sending `_v: 1` gets the reload note. (7) The log arrives inside patches: 250 actions, with the log trimmed to the same entries on host and guest. (8) **Private-only commits:** Turn order's `t.schedule` timers and a script that only writes `t.data` run 50 commits; the guests send **0** `snap` requests and stay converged. (9) Knock spam (1j case 5). |
| `t-p1-store.js` | (1) The host save goes to IndexedDB, and a reload resumes it with decks, log and rules. (2) Migration: a legacy `ct-save-<room>` and `ct-decks-<room>` (an image deck plus the standard deck), planted by an init script, resume after a reload with their images; the legacy keys are gone afterwards; a planted card face renders from a `blob:` URL. A planted legacy `{ts, lost}` marker migrates, and the tab hosts with the "couldn't resume" toast. (3) Quota: an init script makes `IDBObjectStore.prototype.put` throw `QuotaExceededError` for `saves` → another room's planted save is pruned, and the toast is shown; with nothing to prune, the lost marker is written, the toast is shown, and a reload resets loudly. (4) An IndexedDB open failure (`indexedDB.open` stubbed to fire `onerror`): the toast text is shown, and the table works unsaved. **On a reload with the same stub, the tab still hosts its room** (the host key), and guests reconnect to it. (5) The `ct-pending-<room>` warning appears when the planted pending seq is ahead of the save. (6) A planted save with `v: STATE_V + 1`: the newer-version toast is shown, and the record is byte-identical after 5 s of play. (7) Module skew: the test routes `core.js?v=…` to a copy whose `MODULE_V` differs; the page shows the "reload" banner and does not start. |
| `t-p1-assets.js` | (1) A guest joins and requests the image deck's assets; faces render. (2) The guest reloads: zero `asset` bytes (B8). (3) A tampered transfer (the host's send is wrapped to flip a byte): the guest shows the "damaged" toast, re-requests, and renders. (4) Mallory sends unsolicited and mismatched assets: ignored. (5) A guest uploads an image deck: no asset bytes from host to guest for it. (6) 1j cases 8 and 9 (another room's hash; the decompression bomb). (7) **Late arrival:** the host's `asset` sends are delayed 2 s by a wrapper; a card already in the guest's hand and on the table re-renders from `.face.loading` to its image, and an open zoom refreshes. (8) **Missing asset:** the host's copy of one asset is deleted from IndexedDB before the guest joins; the host toasts the boot check, the guest receives `missing`, renders `.face.missing` and toasts; with `missing` suppressed by a wrapper, the guest gives up after the 20 s timeout and one retry. (9) **Pacing:** during a 20 MB pull, moves by the host reach the pulling guest in ≤ 1 s each. |
| `t-p1-bench.js` | B1', B3, B4, B6 and B8 in the browser. B1, B2, B5 and B7 in `core-p1-bench.mjs`. **It runs serially**: `run-all.sh` gets a `SERIAL=t-p1-bench,…` list, run after the parallel batch, under the same flock. |

### 1m. Docs and module ownership

- **README.md**
  - "How it works": deltas, snapshots and gap recovery replace "full-state
    broadcast".
  - "Persistence": IndexedDB, the content-hash cache, quota behaviour,
    the pending-marker warning, and newer-version saves.
  - "Decks": assets are now cached by hash, with the image size limits.
  - "Honest limits": the asset cache can be probed. A host learns which
    images a guest already holds (the guest requests only what it lacks),
    so a host can tell whether a guest has seen a deck before.
  - "Testing": the new suites and the benchmark.
- **`tests/README.md`** (updated by every phase): the serial bench list,
  the fixtures, the shared helpers (`bodies`, `idb`, the quota stub,
  `plantSave`), and the minimum Node version (22.7).
- **ENGINE.md:** §2 gains `t.item` and `t.find`, plus the cost note on
  `t.items()`.
- **TABLETOP.md:** §7 marks Phase 1 done, with links to this spec's
  decisions.
- **Module ownership**
  - `core.js`: dirty sets, `takeDirty`, `T.pub`, `trimLog`, indexes,
    `zMax`, `MIGRATE[1]` (the synchronous part), `PUBLIC_ACTIONS`, `PROTO`,
    `STATE_V`, `MODULE_V`, `cleanDeck` v2 and `cleanDeckV1`,
    `T.assetRefs()`, `t.item` and `t.find`.
  - `store.js` (new): IndexedDB, `ingestDeck`, `imageDims`, hashing,
    quota, GC, and the legacy migration (the asynchronous part).
  - `app.js`: the boot role decision, the module-version assertion, the
    broadcast tick and per-peer `sync`, guest patch application and the
    gap logic, the asset pull, pacing and timeouts, dirty-set rendering
    and late-arrival indexes, the queue and its preprocessing stage,
    `__ct`.
  - `tests/`: the new suites, the serial bench runner and the RTC byte
    counter init script.

---

## 2. Phase 2: Pieces, dice and boards

**Goal:** the one piece model (`k:'g'`), plus supplies, bags, identical
stacks, dice, boards with drawn structure, lock and owner, rectangular
tables, named seats, hand-bar hiding, and free-table interactions.

**Demos:** draughts and backgammon, played by hand. Snapping and addresses
come in Phase 3; boards are only drawn here.

### 2a. Data model and state changes

**Host state, v3** (the changes from v2):

```ts
HostState = { ...v2,
  v: 3,
  table: { shape: 'round' | 'rect', w: int, h: int, felt?: Color },   // REPLACES `size`
  seats: SeatDef[] | null,       // named seats; null = automatic seating (as today)
  boardSeq: int,                 // boards get z = BOARD_Z0 + (++boardSeq) (see "Board z" below)
  lastSetup?: boxId,             // the box last laid out by loadBox/setup (Reset uses it, §4c)
}
Player = { name, color, online, hand: HandEntry[], seat: number | null, seatId?: string }
         // seat: table-space angle in degrees (90 = the bottom rim), as today; null = a watcher
HandEntry = { d, i } | { t: TypeRef, f: int, up?: false }
```

- **Round table:** `w = h ∈ {1300, 1800, 2400}`.
- **Rectangular table:** `w ∈ int[800..6000]`, `h ∈ int[600..4000]`.
  **[DECISION]** TABLETOP says "up to about 6000 × 4000"; these are the
  exact bounds. The minimum keeps two seats and a small board usable.
- **`felt`** goes through `safeColor`. The default is `#17603a`.

**The catalog** gains boxes. Like decks, they are never changed during
play, and live in `T.boxes`. Each catalog record also carries two fields
that **only host code** sets, outside the box: `src: 'host' | 'upload' |
'script'` (how the box arrived: the host's own `loadBox` or upload, a
guest's `addBox`, or `t.newBox`) and `by?: pid` (who added it).
`cleanBox` never reads or returns `src` or `by`. Whether a box is
**built in** is never stored: it is derived by content (§2j,
`isBuiltin`).

```ts
Box = {
  name: string(1..40),
  imgs: (AssetId | null)[],                 // ≤ 2000; Phase 2 boxes are built in and art-free, uploads come in P4
  types: { [typeId]: PieceType },           // 1..500
  backs: { [backId]: Back },                // ≤ 50
  table?: TableDef, seats?: SeatDef[],      // applied by loadBox
  players?: [int[1..99], int[1..99]],
  lockable?: 'anyone',                      // default: only the host toggles locks of this box's items
  setup?: SetupEntry[],                     // ≤ 2000 entries (grammar in 2c, loadBox)
  // Phase 4 adds: decks?, rules?, rulesState?, meta?
}
PieceType = {
  kind: 'token' | 'tile' | 'die' | 'board',  // 'card' is NOT a piece kind: cards stay decks (see below)
  name: string(1..40),
  w: int[8..6000], h: int[8..6000],         // h defaults to w when only w is given
  shape: 'rect' | 'round' | 'disc' | 'hex' | 'meeple' | 'pawn',
  faces: Face[],                            // 1..64 (die: 2..100)
  back?: backId,                            // has a hidden side; also lets it be flipped face down
  rotStep: 0 | 15 | 30 | 45 | 60 | 90,
  hand: boolean,                            // may be held in a hand
  stack: 'pile' | 'count' | 'none',
  meta?: JSON,                              // ≤ 2000 chars of JSON, for scripts (t.type); PUBLIC
  board?: BoardStructure,                   // kind 'board' only
}
Face = { img?: int /* index into box.imgs */, color?: Color, text?: string(≤300, CTRL_NL),
         label?: string(≤8 code points), pips?: int[0..9] | [int[0..9], int[0..9]] }
Back = { w, h, shape, rotStep, hand, stack, face: Face }
       // every type naming this back MUST have exactly its w/h/shape/rotStep/hand/stack;
       // cleanBox fills the back's from its first user, then checks every other user
BoardStructure = {
  primary?: true,                           // addresses on this board are shown bare (§3a)
  grid?: { type: 'square' | 'hex', cols: int[1..64], rows: int[1..64] /* cols*rows ≤ 4096 */,
           cell: number[8..400], x: number, y: number,      // origin, in board-local units
           hex?: 'pointy' | 'flat', snap?: 'cell' | 'point',
           labels?: 'chess' | 'go' | 'xy' | 'axial',
           draw?: 'checker' | 'lines' | 'cells' | 'none', colors?: [Color, Color],
           fills?: { [address]: Color } /* ≤ 4096 */,
           marks?: address[] /* ≤ 64: dots drawn at these grid points or cells, e.g. go's star points; never snap targets */ },
  spaces?: { id, x, y, r: number[4..400], mark?: 'dot' | 'ring' | 'tri' | 'rect' | 'none',
             w?: number, h?: number,
             dir?: 'up' | 'down' | 'left' | 'right',   // drawing: where a 'tri' points; P3: the fan direction (§3g)
             color?: Color, label?: string(≤12) }[],          // ≤ 1000
  zones?: { id, poly: [number, number][] /* 3..64 points */, owner?: 'board' | `seat:${string}`,
            private?: 'reveal' | 'keep', color?: Color, label?: string(≤24) }[],  // ≤ 100; semantics: P3, private: P5
  links?: [spaceId, spaceId][],                              // ≤ 4000; semantics: P3
}
TableDef = { shape: 'round' | 'rect', w, h, felt? }
SeatDef = { id, name: string(1..24), color?: Color,
            edge?: 'bottom' | 'top' | 'left' | 'right', at?: [number, number], angle?: number }   // ≤ 12; at most one placement key (default edge 'bottom')
```

**Defaults by kind** (`cleanBox` fills them in):

| kind | shape | w × h | stack | rotStep | hand | locked when spawned | faces |
|---|---|---|---|---|---|---|---|
| token | disc | 60 × 60 | count | 0 | false | no | required |
| tile | rect | 100 × 100 | pile | 90 | true | no | required |
| die | rect | 56 × 56 | none | 0 | false | no | `[1..6]` |
| board | rect | required | none | 90 | false | **yes** | `[{color:'#d6b98c'}]` |

**The `faces` shorthand** (expanded by `cleanBox`):

- a number `n` → `{label: String(n)}`;
- on a die, the numbers 1–6 → `{pips: n}`;
- a string `s` → `{label: s}`.

**[DECISION] Board structure is declared, and drawn, in Phase 2.** Its
*semantics* (snapping, addresses, zones, links) arrive in Phase 3.

- Reason: TABLETOP promises art-free classics ("a few KB of JSON"), and the
  Phase 2 demos need visible boards.
- Drawing them as an SVG that our own code generates from validated
  numbers needs no image assets and no peer-supplied markup.
- The same SVG layer later carries the Phase 3 hints.

**[DECISION] `pips` is a Face primitive.** It gives dice their dots, and
dominoes (`[a, b]`) their two halves, with no images and no font
dependency. Unicode die and domino glyphs render inconsistently on iOS.

**[DECISION] `card` is not a piece kind.** This deviates from TABLETOP's
"one piece model", where a card is a piece with two faces.

- Cards keep today's `k:'c'` items and decks, so saves, templates, the CLI
  and every suite keep working unchanged, as TABLETOP itself requires
  ("cards keep their current wire shape").
- What the one model was for is delivered anyway: owner, lock, hidden
  faces, logging, flood control and scripts apply to cards and pieces
  alike, and piles hold either.
- Unifying the two internally is a later refactor with no visible effect,
  outside phases 1–5.

**[DECISION] A back carries the behaviour flags.** `rotStep`, `hand` and
`stack` live on the `Back` too, and every type that uses the back must
match them, as for `w`, `h` and `shape`. A hidden piece exposes only its
back, yet the client needs those flags to rotate it, offer "Hand" and
split it; reading them from the hidden type would reveal it. Clients and
core use the **back's** flags for any item that is hidden from the viewer
or actor.

**[DECISION] `lockable` is set per box.** Whether players may lock pieces
is a property of the game (a wargame locks its terrain; a party game
doesn't care), so the box declares it once rather than per type.

**[DECISION] The grid adds `labels:'go'` and `snap:'point'`** to
TABLETOP's grid. Go is played on intersections with its own coordinate
letters (no I), and is one of the Phase 3 demos.

**Grid geometry** (board-local; `grid.js` MUST use exactly these formulas,
both for drawing and, in Phase 3, for snapping):

- **Square, `snap:'cell'`.** Cell `(c, r)` is the square from
  `(x + c·cell, y + r·cell)` with side `cell`. Its centre is
  `(x + (c+½)·cell, y + (r+½)·cell)`.
- **Square, `snap:'point'`.** Point `(c, r)` is at `(x + c·cell, y + r·cell)`.
  `cols` and `rows` count *points*. `draw:'lines'` joins them (a go board).
- **Hex, `hex:'pointy'`** (odd-r offset). The radius is `R = cell/√3`. The
  centre of `(c, r)` is `(x + cell·(c + ½·(r&1)) + cell/2, y + R + r·1.5R)`.
- **Hex, `hex:'flat'`** (odd-q offset). The radius is `R = cell/√3`. The
  centre of `(c, r)` is `(x + R + c·1.5R, y + cell·(r + ½·(c&1)) + cell/2)`.
- **Axial coordinates** (used by `labels:'axial'` and by the hex maths):
  - pointy: `q = c − (r − (r&1))/2`, with `r` kept;
  - flat: `q = c`, `r = row − (c − (c&1))/2`.

**The address grammar** (`grid.js`, from Phase 2). It is needed here,
because `cleanBox` parses `fills` and `marks` and must reject space ids
that look like addresses. Phase 3 adds snapping and the qualified forms
(§3a). An address is local to one board:

| Grid | `labels` | Address | Example |
|---|---|---|---|
| square | `'chess'` | file letter `a`… (cols ≤ 26), then the rank `1…rows` counted **from the bottom row** | `e4` |
| square | `'go'` | the letters `A…T` without `I` (cols ≤ 25), then the rank from the bottom | `D4` |
| square | `'xy'` (the default) | `c,r`, zero-based from the top-left | `3,4` |
| hex | `'axial'` (the only one) | axial coordinates `q,r` | `3,-1` |
| any | a space | its `id` | `bar` |

- `parseAddr(grid, s) → {c, r} | null` and `formatAddr(grid, c, r)`.
  Parsing ignores case; output is canonical (chess lower case, go upper
  case).
- A space id that `parseAddr` would accept for its board's grid is
  rejected by `cleanBox`. (The id regex of §0.2 already excludes `:`,
  `#` and `,`, which §3a's qualified forms and the `xy` and axial forms
  use.)

**Item kinds.** New kinds, plus `owner` and `lock` on every kind:

```ts
Card   = { k:'c', d, i, up, x, y, rot, z, owner?, lock? }
Pile   = { k:'p', name, cards: ({d, i, up} | {t, f, up})[], x, y, rot, z, owner?, lock? }   // all-card or all-piece, one size
Piece  = { k:'g', t: TypeRef, f: int, x, y, rot, z, up?: false, n?: int[2..999], owner?: Owner, lock?: true }
Supply = { k:'s', t: TypeRef, f: int, x, y, rot, z, up?: false, owner?: Owner, lock?: true }
Bag    = { k:'b', of: {t, f, up?: false}[] /* ≤ 1000 */, name: string(≤24), color?: Color,
           hand?: true /* fixed when the bag is made */, x, y, rot, z, owner?, lock? }
Owner  = pid | 'seat:<seatId>'
```

- **A bag's `hand` flag is fixed when the bag is made.** A setup or
  script bag gets `hand: true` iff every initial member type has `hand`
  (`t.newBag` takes `o.hand` to override, for an empty bag). It never
  changes afterwards, and `toBag` of a non-hand type into a hand bag is
  refused. **[DECISION]** A flag computed from the current contents would
  flip when the last non-hand piece is pulled face down, revealing that
  piece's class.

- **`up` is omitted when true.** `up: false` is only allowed when the type
  has a `back`.
- **`n` is omitted when 1.** It is only allowed on `stack:'count'` types.
- **Sizes:**
  - pieces and supplies take the type's `w × h`, or the back's when hidden;
  - bags are `BAG_W × BAG_H` = 90 × 100;
  - a pile of pieces takes its members' size.
- **Seat-bound ownership.** `owner: 'seat:<id>'` resolves to whoever sits
  in that seat now. A seat handover transfers ownership automatically.
  **[DECISION]** Chess pieces must follow the "White" seat, not the person
  who sat there first.

**Indexes and other core state**

- `byKind` covers `'c' | 'p' | 'g' | 's' | 'b'`.
- `byType: Map<TypeRef, Set<id>>` covers pieces and supplies.
- `byOwner: Map<Owner, Set<id>>`.
- `T.handy` counts the hand-holdable items on the table:
  - cards;
  - piles of cards;
  - pieces, supplies and piles whose type (or back, when hidden) has
    `hand: true`;
  - bags with `hand: true`.

  It is kept by `put` and `remove`, and goes into the public view as
  `handy = T.handy > 0`.

**Seats**

- **Seat angle → seat point.**
  - Round tables: the point is `centre + SEAT_R·(cos, sin)`, as today.
  - Rectangular tables: the ray from the centre at that angle meets the
    rectangle inset by 50 units.
  - A named seat with `at` uses its exact point; its angle is
    `atan2(at − centre)`.
- **Named-seat placement.**
  - On rectangular tables, the `m` seats on one edge sit at fractions
    `(k+1)/(m+1)` along it, in declaration order. Bottom and top edges run
    in increasing x; left and right in increasing y.
  - On round tables, `edge` maps to 90° (bottom), 180° (left), 270° (top)
    or 0° (right). The `m` seats on one edge spread out at
    `base + (k − (m−1)/2)·30°`.
  - `angle` sets the angle directly.
- **Automatic seating.**
  - Round tables work as today, by angle.
  - Rectangular tables use the same largest-gap rule along the
    **perimeter** (arc length), starting at the middle of the bottom edge,
    and convert back to an angle.
- **Joining with named seats.** `ensurePlayer(p)`, when `state.seats` is
  set:
  - a player whose `seatId` still exists keeps it;
  - otherwise they take the first **free** named seat, in declaration
    order (free = no player, online or offline, holds it);
  - otherwise they watch (`seat: null`, no `seatId`).
- **[DECISION] An offline player's named seat is not free.**
  - It is held for them, as their hand is. The host can free it from the
    seat menu (2g).
  - Otherwise a dropped chess player would come back to find their seat
    taken.
- **Setting the named seats** (by `loadBox`, by `t.setSeats` in Phase 3):
  - players are ordered online first, then offline, each group clockwise
    from the bottom: `(seat − 90 + 360) % 360`;
  - they take the named seats in that order, and the rest watch;
  - the log reads "Seats: White — Alice, Black — Bob · watching: Carol".
- **Clearing the named seats** (`seats → null`): every watcher gets
  `assignSeat()`, the others keep their angles, and `seatId` is removed.
- **Watchers under automatic seating** (moved there by the host) can sit
  down again at any time: `seat {sit: true}` gives them `assignSeat()`.

**Board z.** Boards live in a reserved band below every other item:
`z = BOARD_Z0 + (++state.boardSeq)`, with `BOARD_Z0 = −1,000,000`. Other
items keep `zTop()` (≥ 0). Moving a board never changes its z.

- **[DECISION] Newer boards sit above older ones.** A rack or player mat
  placed on a map must stay visible, and snapping picks the topmost board
  under a piece (§3a). A running *minimum* would put each new board under
  the older ones.
- `boardSeq` is persisted; `createTable` restores it as the largest board
  `z − BOARD_Z0`. `MAX_ITEMS` keeps it far below `−BOARD_Z0`.

### 2b. Wire protocol (PROTO 3)

**Snapshot.**

- `size` is replaced by `table: TableDef`.
- New fields: `seats: SeatDef[] | null` and `handy: boolean`.

**Patch.** It gains `table?`, `seats?` (`null` = cleared) and `handy?`,
each present iff changed. `size` is gone.

**New channel `boxes`**

- It is `signed`, and accepted from `hostPeer` only.
- Its content is a delta `{boxId: PublicBox}`, or the full box catalog for
  a new connection (sent right after `decks`).
- **`PublicBox`** is `Box` without `setup`. Phase 4 also strips `rules` and
  `rulesState`. It adds three display fields that the host fills in:
  `src`, `by?` and `builtin: boolean`. Guests only display them; no trust
  decision is ever taken on a guest.
  - **[DECISION]** Guests never need the setup. An exported position's
    setup (Phase 4) holds hidden information: bag contents, face-down
    pieces, hands.
- **Guests** pass each box through `cleanBox`. A failing box is dropped
  with `console.error` and **one toast** per box ("A game box from the
  host couldn't be read: {message}"), and its pieces render as
  placeholders. A good box's asset ids go into the asset pull (1b.5), and
  its items re-render (§1g, "late arrivals").

**`sizeOf(publicItem)` for renderers:**

- pieces and supplies: the type's `w, h`, or the back's when the public
  item carries `b`; a placeholder (`b: null`, or a missing box) is
  60 × 60;
- bags: 90 × 100;
- piles: their `top`'s size (piece or card).

The same rule gives every other per-type property a renderer needs
(`rotStep`, `hand`, `stack`, `shape`): from the type when shown, from the
back when hidden.

### 2c. Actions

**Shared checks.** These are core helpers. A failing check refuses the
action: a notice to the actor, the refusal touch (1c), no hooks.

- `mayHandle(p, it)`: `p === RULES`, or `it.owner` is unset, or
  `resolveOwner(it.owner) === p`.
  - Refusal: "🚫 That belongs to {name}" (a seat-bound owner reads "to
    White").
  - **The host is not exempt.** **[DECISION]** TABLETOP says the owner
    check is "enforced even on a free table". The host can reassign
    ownership with `owner` instead.
- `notLocked(it)`: `!it.lock || p === RULES`. Refusal: "🔒 That is locked
  in place".
- **Lock blocks** changing an item's position, rotation or face, and
  taking it as a whole: `move`, `rot`, `flip`, `face`, `del`, `toHand`,
  `split`, and the *moved* item of `join`, `stack`, `toPile`, `merge` and
  `toBag`.
- **Lock does not block** drawing from it (`draw`, `deal`, `take` from a
  locked supply, `pull` from a locked bag), `shuffle`, `peek`, `roll`, or
  being a drop *target*.
- **Which item each check applies to.** `mayHandle` applies to every item
  an action reads from or changes, targets included: an owned pile, supply
  or bag belongs to its owner, so Mallory cannot draw from, shuffle, peek
  at or drop onto Alice's owned deck. `notLocked` applies only as listed
  above.

  | Action | `mayHandle` | `notLocked` |
  |---|---|---|
  | `move`, `rot`, `flip`, `face`, `del`, `toHand` | the item | the item |
  | `split` | the stack, and `onto` when given | the stack |
  | `join`, `stack`, `toPile`, `merge` | the moved item and the target | the moved item |
  | `toBag` | the piece and the bag | the piece |
  | `draw`, `deal`, `shuffle`, `peek`, `handPile` | the pile | — |
  | `take` / `pull` | the supply / the bag | — |
  | `roll` | each die | — |
  | `hide` (P5), `group` (P4) | as the per-member action | as the per-member action |

- **Items hidden from the actor.** `hiddenFrom(p, it)` is `it.up === false`
  for a piece or supply in Phase 2 (Phase 5 adds `vis`, §5a). For such an
  item, every check that depends on its **type** would answer a question
  about the hidden identity: whether it is a die, whether two hidden
  stacks are the same type, whether it belongs to a supply. So:
  - `face`, `roll` and `join` (either side hidden from the actor) are
    refused **before any other check** with one uniform notice, "🚫 That
    piece is hidden", identical for every hidden type. (A piece's `vis`
    viewers are not "hidden from"; Phase 5 also lets a private piece's
    owner roll it and set its face, §5c.)
  - Every other check reads the **back's** flags (`w`, `h`, `shape`,
    `rotStep`, `hand`, `stack`), which every type sharing that back has
    too (§2a), so its outcome says nothing about the type.
  - **[DECISION]** Uniform refusals for hidden pieces. Without them,
    success versus refusal is an oracle on hidden types.
- `cap(k = 1)`: `items.size + k ≤ MAX_ITEMS` (5,000), else "🚫 The table is
  full (5,000 items)". It applies to **every** op that adds items, human or
  script: `play`, `split`, `take`, `pull`, `deal`, `addDeck` (its pile),
  `t.deal`, `t.newPile`, `t.spawn`, `t.take`, `t.pull`, and setups (which
  check their whole total before the first op). A script op at the cap
  returns `false` with `console.warn`. A save above the cap still loads
  (§0.2, Caps).
  - **[DECISION] `MAX_ITEMS` = 5,000**: five times TABLETOP's 1,000-piece
    target, which the budgets are measured at, and low enough that a flood
    of `take`s cannot make the host's DOM or snapshots unusable.
- **Labels** (`itemLabel`):
  - a shown piece: its face `label` if the face has one, else the type
    `name`, plus " ×N" when `n ≥ 2`;
  - a hidden piece: "a hidden piece", plus " ×N" when `n ≥ 2`;
  - a shown supply: "the {name} supply"; a hidden one: "a supply of hidden
    pieces";
  - a bag: "the bag {name}".
  - **Every log line that mentions an item uses `itemLabel`** (or a
    count), never the type's name directly. That covers `take` from a
    hidden supply ("took a hidden piece from a supply of hidden pieces"),
    `join` of hidden stacks, and every roll (below).

**Changed actions**

| Action | Payload | Change for Phase 2 |
|---|---|---|
| `move` | `{id, x, y}` | Every kind, through `place()` (§0.2). Checks `mayHandle` and `notLocked`. Clamping is per shape (`clampToTable(x, y, w, h)`: round keeps the item's centre within `PLAY_R`; rect keeps the centre inside `[60, W−60] × [60, H−60]`). z is `zTop()`, except for boards, which keep theirs. Log: "moved {label}". |
| `rot` | `{id, rot}` | Pieces snap to `rotStep` (the back's when hidden: `step ? round(rot/step)·step : rot`). Checks `mayHandle` and `notLocked`. |
| `flip` | `{id}` | A card: as today. A piece: (1) the type has a `back` → toggle `up` (log "turned {label} face down", labelled before the flip, / "turned over {label}", labelled after it: the face is public at that moment either way); (2) otherwise 2 faces → `f = 1 − f` ("flipped {label}"); (3) otherwise N > 2 faces, not a die → `f = (f+1) % N` ("turned {label} to {face label}"); (4) a die → refused, "🚫 Dice are rolled, not turned". A supply: like a piece without the die rule; it changes what the supply hands out. A bag: refused (console.warn). |
| `toHand` | `{id}` | Also pieces whose type (or back, when hidden) has `hand`. From a ×N stack it takes one (n−1 stays). Log as today; a hidden piece reads "took a hidden piece into hand". |
| `play` | `{idx, d, i, …}` or `{idx, t, f, x, y, up, rot}` | The hand entry is matched by identity (`handIdx` generalized: `d, i` or `t, f`). A piece entry creates a `k:'g'` item through `place()` (`up:false` only if the type has a `back`). Respects `cap()`. |
| `draw`, `deal`, `shuffle`, `flip`, `merge`, `peek` on piles; `stack {id, onto}`, `toPile {id, pile}`, `handPile` | as today | Also apply to **piles of pieces**: piles of `stack:'pile'` pieces of identical `w × h` (the pile-of-cards rules). `stack` turns two loose `pile`-type pieces into a pile. Mixing cards and pieces, or sizes, is refused: "🚫 Those don't stack together". On a pile of pieces: `flip` (reverse and toggle `up`) requires **every** member's type to have a `back` ("🚫 Some of those pieces have no hidden side"); `draw` and `handPile` require every member type to have `hand` ("🚫 Those pieces can't be held in a hand"); `deal` creates `k:'g'` pieces through `place()`, never `k:'c'`; `peek` at a hidden top answers `{peek: {t, f}}` (the note shape of §5b, introduced here). |
| `del` | `{id}` | Every kind. Checks `mayHandle` and `notLocked`. Log: "removed {label}", plus " (N pieces)" for a bag. |
| `size` | `{size}` | Still accepted: it becomes `table {shape:'round', w:size, h:size}`. |

**New actions** (all from guests are subject to `PUBLIC_ACTIONS`)

| Action | Payload and validation | Semantics | Log | Ruled |
|---|---|---|---|---|
| `roll` | `{ids: id[1..20]}`, unique; each must pass the hidden-item rule first, then be a `k:'g'` piece of `kind:'die'`, and pass `mayHandle`. Any extra fields (`f`, …) are **ignored**. | For each die, `f = randInt(faces.length)` (the crypto RNG), and an fx `{p, id, x, y, roll: 1}` goes out. | "rolled 5 · 2" (face labels in id order, joined with " · "); Phase 5 adds hidden dice (§5c) | yes |
| `face` | `{id, f}`; the hidden-item rule first; then a piece or supply, not a die; `f ∈ int[0, faces.length)`; `mayHandle` and `notLocked` | `it.f = f` | "turned {label} to {face label}" | yes |
| `split` | `{id, n?, x?, y?, onto?}`; a piece with `n ≥ 2`; `k = n ?? 1`, with `1 ≤ k < it.n`; `mayHandle`, `notLocked`, and `cap()` unless `onto` | `it.n −= k` (the field is dropped when it reaches 1). Without `onto`: a new piece takes the same `t, f, up, owner` and `n = k` (omitted when 1), placed through `place()` at `(x, y)`, with `zTop()`. With `onto`: the `k` pieces join `onto` instead, with the `join` (a) rules, **atomically** (no intermediate item; refused as a whole when the join would be). | "took {k} from {label}" / "moved {k} from {label} onto {label}" | yes |
| `join` | `{id, onto}`; the hidden-item rule first (either side). (a) Two `stack:'count'` pieces with equal `t, f, up, owner` and `n` + `n` ≤ 999. (b) `onto` is a supply with the same `t`: the piece goes back. `mayHandle` on both, `notLocked` on `id`. | (a) `onto.n += id.n ‖ 1`, and `id` is removed. (b) `id` is removed. | (a) "stacked {label} (×N)" (b) "returned {label} to {supply label}" | yes |
| `take` | `{id, x?, y?, hand?}`; a supply; `mayHandle(supply)`; `hand` requires the type's (or back's) `hand`; `cap()` unless `hand` | A new piece `{t, f, up}` of the supply's values, owned by the supply's owner if it has one. It is placed through `place()` at `(x, y)` (by default `dealSpot(supply)`), or goes into the hand as `{t, f, up?}`. | "took {label} from {supply label}" / "took {label} into hand" (labels as seen by everyone, so "a hidden piece" for a hidden supply) | yes |
| `pull` | `{id, x?, y?, hand?}`; a bag with members; `mayHandle(bag)`; `hand` requires the bag's fixed `hand` flag; `cap()` unless `hand` | Takes `of[randInt(of.length)]` out (from Phase 3 the index is drawn before the hooks, §3c). It is placed with its stored `up` through `place()` at `(x, y)` (by default `dealSpot(bag)`), or goes into the hand. | Face up on the table: "drew {label} from {bag}". Otherwise: "drew a piece from {bag}". | yes |
| `toBag` | `{id, bag}`; a piece; `mayHandle` and `notLocked` on the piece; `mayHandle` on the bag; `bag.of.length + (n ‖ 1) ≤ 1000`; a bag with `hand` refuses a piece whose type (or back) lacks `hand` | Pushes `n ‖ 1` copies of `{t, f, up?}`, then removes the piece. | "put {label} into {bag}" | yes |
| `lock` | `{id, on: boolean}`. Allowed for the host; or, when the item's box has `lockable:'anyone'` (pieces, supplies and bags of that box; cards and piles: host only), for anyone who passes `mayHandle` on it. | `on ? it.lock = true : delete it.lock` | "locked {label}" / "unlocked {label}" | yes |
| `owner` | `{id, to: pid \| 'seat:<id>' \| null}`. Allowed for: the host (to anyone, to a seat, or to null; boards included); the current resolved owner (to a pid, or null); anyone **claiming** an item for themselves (`to === p`) that is unowned, **not locked, and not a board**. `to` must name an existing player or seat. | Sets or deletes `it.owner`. | "claimed {label}" / "gave {label} to {name}" / "released {label}" | yes |
| `seat` | Exactly one of `{id: seatId}` (sit in that named seat), `{watch: true}` (stand up), `{sit: true}` (automatic seating only: sit down again); plus `p?: pid`, accepted only from the host (default: the actor). `id` is looked up with `state.seats.find(s => s.id === id)` and must be free. | Sets `seatId` and the `seat` angle; or sets `seat: null` and deletes `seatId`; or `assignSeat()`. | "sat down as {seat}" / "sat down" / "stood up to watch" / "moved {name} to {seat}" / "moved {name} to the watchers" | yes (never refused by `strict`; see §3) |
| `table` | `{shape, w, h, felt?}`; **host only**; bounds as in 2a | Items shift by `((w'−w)/2, (h'−h)/2)`, then clamp. Seat angles are kept, and named seats re-placed. (Phase 3: addresses are then recomputed, §3a.) | "set the table to round (large)" / "set the table to a 3200 × 2200 rectangle" | no |
| `loadBox` | `{box, setup?: boolean, clear?: boolean}`; **host only in Phase 2** (opened to guests in Phase 4 as `addBox`) | (1) `cleanBox(box)`, failing loudly. (2) **Deduplicate:** if the catalog holds a box with the same canonical content (`boxKey`, §2j), reuse its id; else mint a `boxId` and register it (`dirtyBoxes`, a catalog record with `src: 'host'`). (3) If `clear`, run `clear`. (4) If `box.table`, apply `table`. (5) Named seats := `box.seats ?? null`. (6) If `setup`, lay out `box.setup` (grammar below) and set `lastSetup = boxId`. Returns `boxId`. | "set up «{name}» ({N} pieces)", or "added the box «{name}»" | no |
| `clear` | `{}`; **host only** | Removes every item and empties every hand. | "cleared the table ({N} items, {M} cards from hands)" | no |

**Setup grammar (Phase 2 subset).** Phase 4 extends it.

```ts
SetupEntry =
  | { piece: typeId, at: Where, f?: int, n?: int[2..999], count?: int[1..200], spread?: [dx, dy],
      owner?: 'seat', lock?: boolean, up?: boolean, rot?: number }   // `count` separate items, each offset by `spread`
  | { supply: typeId, at: Where, f?: int, up?: boolean, lock?: boolean, owner?: 'seat' }
  | { bag: (typeId | { t: typeId, f?: int, n?: int[1..999], up?: boolean })[], name?: string, at: Where,
      owner?: 'seat', hand?: boolean }
  | { forEachSeat: SetupEntry[] }     // runs its entries once per named seat (or per seated player when automatic)
  | { group: SetupEntry[], shuffle?: true }   // shuffle: permute positions among its hidden pieces that share a back
Where = [x, y]                       // the item's TOP-LEFT, table coordinates (the §0.2 rule)
      | 'center'                      // the item's centre on the table centre
      | 'seat' | { seat: [dx, dy] }   // only inside forEachSeat: the item's centre at an offset in that seat's
                                      // frame (dx to the seat's right, dy toward the table centre, from the
                                      // seat point); 'seat' = { seat: [0, SEAT_INSET] }, SEAT_INSET = 120
                                      // Phase 3 adds addresses: 'e4' | 'bar' | { board: typeId, at: 'e4' }
```

- `owner: 'seat'` resolves to `'seat:<id>'` for named seats, and to the
  seated player's pid otherwise.
- At most 3,000 items may be spawned in total, checked (with `cap()`)
  before the first op; beyond that, `loadBox` fails loudly ("setup places
  too many items").
- `typeId`s refer to the same box.
- Every item is placed through `place()`.
- **Hidden pieces carry no creation order.** Within one entry that spawns
  hidden pieces (`up: false`), their z values are assigned in a random
  order (`randInt`). A `group` with `shuffle: true` lays out its entries,
  then randomly permutes `(x, y, z)` among the spawned hidden pieces that
  share a back. Item ids are random (`uid()`), and §0.2 serializes items
  in sorted-id order. **[DECISION]** Without this, a setup that declares
  the "Banner" first would give it the lowest z and the first key, and an
  attacker could map hidden units to their declaration order.

**The flood cost** is 1 token per action for every action above. There are
no other changes.

**RULED_ACTIONS in Phase 2:** today's set, plus `roll`, `face`, `split`,
`join`, `take`, `pull`, `toBag`, `lock`, `owner` and `seat`. `table`,
`loadBox` and `clear` are host-only and not ruled, like `size` and
`setRules`.

### 2d. Public view and hidden information

**What each viewer receives, for every item state:**

| Item state | Every viewer receives |
|---|---|
| card / pile | as in Phase 1, plus `owner?` and `lock?` |
| piece, shown (no `up:false`) | `{k:'g', t, f, x, y, rot, z, n?, owner?, lock?}` |
| piece, hidden (`up:false`) | `{k:'g', b: '<boxId>/<backId>', x, y, rot, z, n?, owner?, lock?}`: **no `t`, no `f`, no `up`** |
| supply, shown | `{k:'s', t, f, x, y, rot, z, owner?, lock?}` |
| supply, hidden | `{k:'s', b, x, y, rot, z, owner?, lock?}` |
| bag | `{k:'b', name, n: of.length, hand?: true, color?, x, y, rot, z, owner?, lock?}`: **never `of`**; `hand` is the flag fixed at creation (2a) |
| pile of pieces | `{k:'p', name, n, top, x, y, rot, z, owner?, lock?}`, where `top = {t, f, up:true}` if shown, else `{b, up:false}` |
| die | like a piece; `f` (the result) is public |
| piece or supply whose box is missing from the catalog | shown: as above (`t`, `f`); hidden: `{k:'g'\|'s', b: null, x, y, rot, z, n?, owner?, lock?}`. A hidden item **never** falls back to `{t, f}`, whatever fails. |

**Other parts of the view**

- **Players:** `{name, color, online, handCount, seat: number|null, seatId?}`.
- **Table level:** `table`, `seats`, `handy`.
- **The catalog** (`boxes`) is public, like decks today, including box
  and type `meta`. A hidden piece reveals nothing, because the back is
  shared by every type that uses it, and so are its size, shape,
  `rotStep`, `hand` and `stack` (2a).
- **Hands** go per recipient only. A piece entry is `{t, f, up?}`.
- **The log never names a hidden piece**: `itemLabel` returns "a hidden
  piece".
- **Order reveals nothing.** Item ids are random, every `items` object is
  built in sorted-id order (§0.2), and hidden setup pieces get random z
  (2c). Neither key order nor z correlates with how a setup declared its
  pieces.

### 2e. Facade (`t`) additions and changes

| Call | Signature, returns, errors | Log |
|---|---|---|
| `t.roll(id)` | → the new face index, or `false` (not a die, or vanished) | "📜 Rules rolled {face label}"; a die hidden from anyone: "📜 Rules rolled a hidden die" (no value) |
| `t.random()` | → a float in `[0, 1)` from the crypto RNG | aggregated: one "used randomness (N draws)" line per action, see §3e |
| `t.type(ref)` | `ref` = a `'box/type'` string, or `{t}` from an item → a copy `{kind, name, w, h, shape, faces, back?, rotStep, hand, stack, meta, box: boxName}`, or `null` | — |
| `t.geom()` | → `{shape, w, h, size, cx, cy, r}`; `size = w`; for rect, `r = min(w,h)/2 − 110` (as for round) | — |
| `t.players(o?)` | each entry gains `seatId?`. **Watchers are excluded** (as entries with `seat == null` are today); `t.players({all:true})` includes them with `seat: null`. **[DECISION]** Every shipped template iterates `t.players()` to deal and to take turns; a watcher must not be dealt in, so the default stays "the people at the table". | — |
| `t.item`, `t.items`, `t.find`, `t.hand` | include the new kinds and piece hand entries. `t.find` gains `type` (a `'box/type'`, or a bare `typeId` matched in any box), `owner` (a pid matches both `pid` and `'seat:<that player's seat>'` owners), and the kinds `'piece' \| 'supply' \| 'bag' \| 'token' \| 'tile' \| 'die' \| 'board'` | — |
| `t.move`, `t.rot`, `t.flip`, `t.remove`, `t.toHand`, `t.playFromHand`, `t.newPile` | work on the new kinds (with the 2c semantics, without the owner and lock checks); `t.flip(die)` returns `false` with `console.warn` | as their human counterparts |

- **Components from code** come in Phase 3, as TABLETOP plans: `t.newBox`,
  `t.spawn`, `t.setFace`, `t.setCount`, `t.lock`, `t.setOwner`,
  `t.setSeats`, `t.setTable`.
- **[DECISION] `t.roll` and `t.random` ship in Phase 2.** They come with
  the human `roll` action (the ENGINE principle: anything a human can do,
  a script can do).

### 2f. Worker

Not in this phase.

### 2g. UI and interaction

**Rendering** (`pieces.js`, imported by `app.js`; DOM only, no state):

- **Pieces.**
  - A piece renders as `.item.piece.shape-{shape}`, sized `w × h`:
    - rect: border-radius 8%;
    - round and disc: 50%; a disc adds a 3 px rim and an inset shadow;
    - hex, meeple and pawn: a `clip-path` polygon.
  - The face is drawn in layers: the `color` background (`safeColor`),
    then an `<img>` (`getAssetURL`; `.face.loading` while missing), then
    the `label`, centred at `0.55·min(w,h)` in `contrastFor(color)`, then
    the `text` (small, line-clamped), then the `pips`. Pips are a CSS grid
    of dots; `[a, b]` draws two fields split by a line along the long
    side.
  - A hidden piece draws its back face instead.
  - A piece whose box or back is missing (`b: null`, or an unknown `t`)
    renders as a 60 × 60 "?" placeholder.
- **Badges.**
  - "×N" pill when `n ≥ 2`;
  - "∞" on supplies;
  - a pile's count and name, ×N, ∞, 🔒 and a bag's drawing turn against
    the view and the item's `rot`, so they read upright on every screen
    (D91); a pile's name sits under its pile on every screen (D97); while
    two fingers move the view they keep their turn and size, take the
    view's exact size when the fingers rest (300 ms; a hesitation is
    shorter) if it differs from theirs by over 25% and the zoom's size at
    the fit the fingers landed on does too (so a twist alone never resizes
    them), and settle when they lift (D96, D102, D103);
  - an owner dot in the owner's colour (a seat-bound owner uses the seat's
    colour), only while the item is selected or under a hovering pointer
    (D90: thirty seat-bound men would carry thirty dots);
  - 🔒 only while the item is selected (boards are locked by default and
    must not be cluttered);
  - badges (🔒 included) and selection rings grow on a table drawn small,
    up to 3× (D97).
- **Dice.** A `fx.roll` plays a 450 ms tumble: rotate plus a scale pulse,
  on every screen. With reduced motion, the face just changes.
- **Bags** render as `.item.bag`: a drawn pouch, 90 × 100, with the name
  and the count.
- **Boards** render as `.item.board`.
  - On top of the face sits one inline `<svg viewBox="0 0 w h">` overlay,
    built by `boardSVG(type)`, **only from numbers**: rects, paths,
    polygons and circles.
  - Text nodes are our own coordinate labels (a–h, 1–8, A–T without I),
    plus the `label` of spaces, set with `textContent` (or `esc` in a
    string build).
  - Each coordinate turns about its own centre against the view and the
    board's `rot`, so it reads upright on every screen, and grows with the
    badges on a table drawn small (at most 1.6×, and no more than its
    margin holds: D97); a space's or zone's
    label turns by the nearest half turn, so it is never upside down and
    stays along its space (D91); the SVG string is the same for every
    viewer.
  - The SVG string is cached per type ref.
  - `pointer-events: none`.
  - Board z values are in the negative band (2a) and render under
    everything, newer boards above older ones.
- **Piles of pieces** render their top piece (or back) with the existing
  `.multi` shadow and the count.

**Free-table interactions** (desktop):

| Gesture | token / tile | die | supply | bag | board |
|---|---|---|---|---|---|
| drag | moves it; from a ×N stack, **takes one** (`split` k=1 at the drop; onto a matching stack, `split {onto}`); Shift+drag moves the whole stack | moves | Shift+drag moves the supply; a plain drag spawns a piece (`take`) | moves | **pans the view** while locked (the default); once the host unlocks it, a drag moves it |
| double-click | `flip` | `roll` of the die **and its handful** (below) | `take` next to it | `pull` next to it (into the hand if the bag has `hand`) | — |
| drop onto… | same type, face and owner ×N stack → `join`; its supply → `join` (return); same-size `pile` piece → `stack`; a piece pile → `toPile`; a bag → `toBag`; the hand bar (hand type) → `toHand`; anything else → `move` | as a token | — | — | — |

- **Items the player may not handle pan.** A drag that starts on an item
  that is locked, or owned by someone else (both resolved from the public
  view), pans the view exactly as a drag on empty felt does. A tap still
  selects it and shows its bar. The client never sends an action it knows
  will be refused, so no "🔒 locked" notices are spammed.
  **[DECISION]** A locked board covers most of the felt; if a drag on it
  started an item drag, panning would be impossible on a board game.
- **A handful of dice.** Double-click, Space or the bar's 🎲 Roll on a die
  rolls that die together with every die the player may handle that lies
  within one die-width of it, transitively (dice touching or nearly
  touching form one handful), up to 20, in one `roll {ids}`.
  **[DECISION]** TABLETOP asks for rolling several dice together, and
  multi-select only arrives in Phase 4. Keeping dice side by side is what
  players do physically; backgammon's two dice start adjacent. To roll
  one die of a pair, drag it away first.

**The action bar** (the buttons are built from public data only):

- **Pieces:**
  - Flip (when flippable);
  - 🎲 Roll (dice: the handful);
  - ⟲ / ⟳ by `rotStep` (45 for free rotation; hidden for dice, and for a
    circular — round or disc, as wide as high — piece whose shown side is
    a plain colour, D92);
  - ✂ Take 1, and a ✥ "Move all" toggle (×N stacks);
  - ✋ Hand (hand types);
  - 🔒 / 🔓 (host; or `lockable` and the player may handle it);
  - 👤 Claim (unowned, unlocked, not a board) / Release, and for the host
    "Give ▸" with a player list;
  - 🗑.
  - Every flag above is read from the back when the piece is hidden
    (2a).
- **Supplies:** Take 1, ✋, 🔒, 🗑.
- **Bags:** Draw, Draw to hand (with `hand`), 🔒, 🗑.

**Keyboard** (outside inputs): R and Shift+R rotate by the step, F flips,
Space rolls a die, Delete removes, Esc deselects.

**Touch**

- A drag from a ×N stack takes one.
- "Move all" arms a whole-stack drag for 5 s. **[DECISION]** Touch has no
  Shift key, and a long-press is already used for zoom.
- A long-press on a piece whose face has an `img`, `text` or `label` opens
  the zoom overlay with that face (`showZoom` generalized).

**The rectangular table**

- `#table.rect` has a 24 px corner radius and no `::before` ring. Its felt
  is a solid `safeColor(felt)` with an inset shadow.
- **`layout()`** fits the rotated bounding box:
  `scale = min(W_s / (|w·cosθ| + |h·sinθ|), H_s / (|w·sinθ| + |h·cosθ|)) · zoom`.
  - A round table keeps today's formula, so a circle still never refits on
    rotation.
  - The pan limit is per axis.
- **Zoom max** = `4 · max(w, h) / 1300`, so 40-unit tokens stay usable on
  a 6000-unit map.
- **`applySeatView()`** on a rect table rotates to the multiple of 90°
  that puts the seat's nearest edge at the bottom.
- **The size selector (`#size-sel`, host only)** on a rect table shows an
  extra, selected, disabled option "▭ {w} × {h}". Choosing one of the round
  sizes asks "Switch to a round table? Items outside it are pulled in.",
  then sends `table {shape:'round', w: size, h: size}`. On a round table
  the selector works as today.

**Named seats and the seat menu**

- Empty named seats render as ghost labels (`.seat.ghost`, dashed border
  in the seat's colour): "White — empty".
- A click or tap on a seat label opens a small screen-space menu:

  | Label clicked | Menu entries |
  |---|---|
  | your own named seat | "Stand up (watch)" |
  | a free ghost seat | "Sit here"; the host also gets "Seat ▸ {players}" |
  | another player's label (host only) | "Move to watchers" |

- With automatic seating, the menu only offers the host's "Move to
  watchers".
- Watchers appear in a `#watchers` chip at the top right: "👀 Carol, Dan".
  A watching player sees "👀 You are watching — tap a free seat to sit"
  with named seats while one is free ("👀 You are watching — every seat
  is taken" while none is), and a **Sit down** button (`seat {sit: true}`)
  with automatic seating, so a watcher can always rejoin play. On a short
  screen (`max-height: 500px`, a phone in landscape, where the table fills
  the height) both are compact chips, "👀 2" and "👀 Watching", that a tap
  opens; another tap, any touch on the table or `WATCH_OPEN_MS` (6 s)
  close them. Opened beside a felt that leaves wide margins (`.gutters`),
  the box wraps in the right margin (D101).
- A named seat's colour is used for its label border. A player's log
  colour stays their own.

**The hand bar hides** (`body.nohand` → `#hand-bar {display: none}`) iff
`!view.handy && myHand.length === 0`. It comes back on the patch that
makes `handy` true. `ResizeObserver` refits the table either way.

**The 🎲 picker** gains "box games":

- Entries: `{k:'draughts', emoji:'⛀', title:'Draughts', box:'draughts', …}`
  and `{k:'backgammon', emoji:'🎲', title:'Backgammon', box:'backgammon', …}`.
- `pickGame` for a box game:
  1. confirms, if the table has items or rules state: "Clear the table and
     set up Draughts? The current game is discarded.";
  2. disables the rules (`setRules {enabled:false}`, if they are enabled);
  3. sends `act({t:'loadBox', box: BOXES.draughts, setup: true, clear: true})`.

**The built-in boxes** live in `templates.js`, under `BOXES`. Their
coordinates are computed by small generator functions in the same file.

- **Draughts.**
  - A rect table, 1400 × 1200.
  - Seats: `light` (edge bottom, `#f5f5f4`) and `dark` (edge top,
    `#1c1917`).
  - The board is 840 × 840, with an 8 × 8 grid, `cell` 100, origin (20, 20),
    `draw:'checker'`, colours `['#f0d9b5', '#b58863']`, `labels:'chess'`.
  - Men are tokens: disc, 80 × 80, `stack:'none'`. Face 0 is the plain man;
    face 1 adds the label "♛" (crowning = flip).
  - There are 12 men per side, on the dark squares, owned by
    `'seat:light'` and `'seat:dark'`.
- **Backgammon.**
  - A rect table, 1800 × 1300. Seats: `light` (bottom) and `dark` (top).
  - The board is 1400 × 1000. It has 24 `spaces` marked `tri`: 100 wide,
    420 tall, alternating two colours, pointing inward. It also has `bar`
    (`rect`) and the `off-light` and `off-dark` trays (`rect`).
  - Checkers: 15 per side, tokens, disc, 80 × 80, `stack:'none'`.
  - Two d6 dice, set up side by side (one handful, 2g).
  - The doubling cube is a **token** with 6 faces, labels
    `['64', '2', '4', '8', '16', '32']`, set with `face`. A cube is
    turned, not rolled. **[DECISION]** A die would invite rolling it, and
    `roll` is the only way to change a die's face; a token's `face` is the
    deliberate "turn it to 4".
  - The standard starting position. Owners are seat-bound.
  - In Phase 3 the checkers sit on the spaces and fan along each space's
    `dir` (§3g); this box's setup and spaces are written so that it plays
    correctly both free-form (P2) and snapped (P3).

### 2h. Persistence

- **The catalog** records `{room, id, kind:'box', box, src, by?}`. They go
  through `cleanBox` on load; a bad box is dropped, and its pieces render
  as placeholders, with `console.error`. `src` and `by` are read from the
  record (written by host code), never from the box.
- **Migration v2 → v3** (`MIGRATE[2]`):
  - `table = {shape:'round', w: size, h: size}`, then delete `size`;
  - `seats = null`;
  - `boardSeq = 0` (there were no boards before);
  - `v = 3`.
  - Players keep their seat angles. Items need no change: cards and piles
    gain nothing, and there were no pieces before.
- **Load order.** On boot, built-in boxes are **not** pre-registered. They
  enter the catalog only when they are loaded. The load order is: the
  boxes of the catalog, then `cleanBox`, then the items.
  - A piece whose box is missing stays in the state, renders as a "?"
    placeholder, and is logged with `console.error`.
  - **[DECISION]** It is not deleted: data must never vanish silently.

### 2i. CLI bridge (`cli.js` and `cli.py`, kept in parity)

**Snapshot additions** (`cliSnapshot`):

```jsonc
"table": { "shape": "rect", "w": 1400, "h": 1200 },
"seats": [ { "id": "light", "name": "Light", "player": "<pid>|null" } ] | null,
"me": { "seat": 90, "seatId": "light" },
"players": [ { …, "seatId": "light" }, { …, "watching": true } ],
"items": [
  { "id", "kind": "token|tile|die|board", "type": "Light man", "typeRef": "ab12cd34/light",
    "face": 1, "label": "♛", "text"?, "n"?, "owner"?, "locked"?, "x", "y" },
  { "id", "kind": "hidden", "n"?, "owner"?, "x", "y" },
  { "id", "kind": "supply", "type", "typeRef", "face", "label"?, "x", "y" },
  { "id", "kind": "bag", "name", "count", "x", "y" },
  { "id", "kind": "pile", …, "top": { "type", "label" } }       // piece piles too
],
"hand": [ …, { "idx", "key": "t:<typeRef>:<f>", "kind": "piece", "name", "label"? } ]
```

**New REPL commands** (both REPLs, with help text, and `cliExec` in the
tab):

| Command | Sends |
|---|---|
| `roll <id…>` \| `roll all` | `{t:'roll', ids}`. `all` = every die the player may handle. |
| `face <id> <f>` | `{t:'face', id, f}` |
| `take <supply> [x y] [--hand]` | `{t:'take', …}` |
| `pull <bag> [x y] [--hand]` | `{t:'pull', …}` |
| `split <id> [n] [x y]` | `{t:'split', …}` |
| `bag <id> <bag>` | `{t:'toBag', …}` |
| `lock <id>` / `unlock <id>` | `{t:'lock', id, on}` |
| `claim <id>` / `release <id>` | `{t:'owner', id, to: me \| null}` |
| `seat <seatId>` \| `seat -` \| `seat +` | `{t:'seat', id}` / `{t:'seat', watch: true}` / `{t:'seat', sit: true}` |

- **`table` prints the new kinds** (both REPLs, same text). Every line
  keeps today's `  [id] … @x,y` frame, so existing parsers still split
  it; suffixes are added in this order, each only when present:

  ```text
    [ab12cd34] ♛ Light man (token) ×3 @412,620 owner:Alice 🔒
    [cd34ef56] hidden piece ×2 @80,90 owner:White
    [ef56ab12] supply Gold (token) ∞ @200,200
    [0a1b2c3d] bag "Tiles" ×42 @300,300
    [1a2b3c4d] pile "stack" ×5 top: hidden piece @500,500
    [2b3c4d5e] board Chessboard (board) @0,0 🔒
  ```

  A face's `label` (or else the type name) comes first, then the type name
  and kind in brackets. Labels, names and type names go through the same
  control-character stripping as today's table text.
- **`players`** marks watchers with "(watching)" and shows `seatId` when
  there are named seats.
- `cliItem` also resolves bag names, and type names for supplies.
- **Bridge API** (both languages): `roll(*ids)`,
  `take(supply, x=None, y=None, hand=False)`, `seat(id)`.

### 2j. Security

**The `cleanBox(b)` gate** (core, synchronous). It is the only gate,
applied to built-ins, scripts (Phase 3), uploads (Phase 4), saves and the
wire.

- **Whitelisting.** It whitelists every field of 2a, with these checks:
  - the types are right;
  - numbers pass `num()` and are clamped to their bounds;
  - strings go through `str()` with `CTRL` (`CTRL_NL` for `text`);
  - colours pass `COLOR_RE`;
  - every id matches its regex and goes through `own()`.
- **References.**
  - `img` indexes a non-null `imgs` entry;
  - `back` names a back with an equal `w`, `h`, `shape`, `rotStep`, `hand`
    and `stack`;
  - setup `typeId`s exist;
  - `links` name spaces that exist;
  - zone polygons are finite;
  - `fills` keys and `marks` parse as addresses of their grid (2a);
  - a space id that parses as a grid address (2a grammar) is rejected.
- **Host-only fields are never read.** `src`, `by`, and any other field
  not in 2a, are dropped. Trust markers live in the catalog record, written
  by host code (2a).
- **`boxKey(box)`** = a 53-bit hash (`cyrb53`) of `canon(box)`, the
  cleaned box serialized with sorted keys. It indexes the catalog for
  deduplication; equality is always confirmed by comparing `canon`
  strings, so a hash collision can never merge two different boxes.
- **`isBuiltin(box)`** is true iff `canon(box)` equals `canon` of a
  cleaned `BOXES` entry. **[DECISION]** "Built in" is derived from
  content, never stored or sent: a guest's `addBox` cannot claim it, and
  a migration cannot grant it by name (§4h).
- **Caps:**

  | Field | Cap |
  |---|---|
  | types | 500 |
  | backs | 50 |
  | faces per type | 64 (die: 100) |
  | grid cells | 4096 |
  | spaces | 1000 |
  | zones | 100 |
  | points per zone polygon | 64 |
  | links | 4000 |
  | fills | 4096 |
  | setup entries | 2000 |
  | items spawned by a setup | 3000 |
  | seats | 12 |
  | `meta` | 2000 chars |
  | `name` | 40 |

- **Failure.** It throws an `Error` naming the field: `pieces[3].faces[0]:
  label is too long (max 8)`.

**Other gates**

- **Host-only actions.** `table`, `loadBox` and `clear` from a guest are
  refused with `console.warn` and the notice "🚫 Only the host can do that".
- **No forged results.**
  - `roll` takes no result from the payload.
  - `face` cannot target dice.
  - Counts only change in ways that conserve them (`split`, `join`), or
    through `take` (n = 1) and `toBag` (removal).
  - There is no human action that sets `n`.
- **Every human op is checked**: owner, lock, `cap()`, the bag cap, the
  count cap, and roll ≤ 20 unique ids.
- **Hidden information.** The reduction in 2d is computed in core, and the
  catalog never contains per-item state.
- **Rendering.**
  - Faces come only from `cleanBox`ed data, through `esc` and `safeColor`.
  - Images come only from blob URLs of verified assets.
  - SVG is built from `num()`-checked coordinates, with no peer string
    except our own labels and `esc`'d space labels.

**Attacker cases to test** (Mallory, in `t-p2-hidden.js`)

1. A face-down tile or a hidden unit: no body she receives (snapshot or
   patch) contains its `t` or `f`, in any field. Checked by a recursive
   scan of every received body for the type ref string and the face
   label.
2. A bag holding three known types: no received body contains `of`, or
   any of those type refs outside the catalog.
3. `roll` with `f: 6` and `ids: [die, die, …×50]`: the result is random,
   and the oversized `ids` is refused.
4. `face` on a die, `split` with `n: -3` or `n: 1e9`, `join` across types
   or owners, `take` with `n: 50`: each refused or ignored, with no state
   change.
5. `move`, `del` and `toHand` on a piece owned by the host, and on a
   locked board: refused, with the notice, and the position re-sent
   (refusal touch).
6. `table`, `loadBox` and `clear` as a guest: refused.
7. `seat` taking the host's seat, or `p` set to someone else: refused.
8. 6,000 `take`s: the table stops at 5,000 items, and the host stays
   responsive.
9. `__proto__` as an id, a type ref or a seat id: no prototype pollution.
10. **Refusal oracles.** Mallory sends `roll` and `face` at a hidden die
    and at a hidden token, and `join` across two hidden stacks of the
    same type and of different types: every refusal she receives is the
    same "🚫 That piece is hidden", byte for byte.
11. **The bag flag.** A hand bag of tiles plus one hidden non-hand token
    is created with `hand` unset; Mallory pulls pieces face down until the
    token is the last: the public `hand` flag never changes. `toBag` of a
    non-hand piece into a hand bag is refused.
12. **Log lines.** `take` from a hidden supply, `join` and `split` of
    hidden stacks, and `t.roll` of a hidden die: the recursive scan of
    every received body (log entries included) finds no type name, face
    label or value.
13. **A missing box.** A hidden piece whose box record is deleted from the
    host's catalog before a reload: its public form is `{k:'g', b: null,
    …}`, with no `t` or `f`.
14. **Claims.** Mallory claims an unowned locked board, and an unowned
    unlocked board: both refused. With `lockable:'anyone'`, she locks a
    piece owned by Alice: refused.

### 2k. Performance budgets

Re-run B1–B8 with **1,000 pieces**, using a test-generated `bench` box
loaded with `__ct.act({t:'loadBox', box, setup:true, clear:true})` on the
host. The bench box holds:

- 1 board, 40 × 25 square grid, `draw:'lines'`;
- 600 tokens;
- 250 tiles;
- 50 dice;
- 60 supplies;
- 39 bags.

The budgets are unchanged, with these additions:

| # | Budget | How it is measured |
|---|---|---|
| B9 | `roll` of 20 dice: host apply ≤ 2 ms; patch ≤ 3 KB per peer | Node, in core |
| B10 | Guest render of a 1,000-piece snapshot: ≤ 400 ms on desktop; ≤ 1,500 ms with iPhone 13 emulation and 2× CPU throttle | `__ct.perf.lastSnapRenderMs` |
| B11 | `boardSVG` for a 64 × 64 grid: ≤ 30 ms (cached afterwards) | Node, or the page |
| B4 (twist) | A two-finger twist on the B4 phone (half a turn in 3 s) over 1,000 ×3 stacks, from the fit at its seat, after one twist not measured: **no long task over 50 ms** while the fingers move, **rAF interval p95** within the pan's bound (max(20 ms, 1.25 × empty-table p95)), and **no settle task over 150 ms** once they lift (D96). On the 6000 × 4000 bench table, and on 1800 × 1200, a rectangle whose fit — and the badges' exact size — changes by over 25% as it turns | synthetic touch pointers driven once per frame under CDP CPU throttling × 2; `longtask` entries split at the lift; the badges' `--view` then equals the view's angle |
| B4 (pinch) | A pinch on the B4 phone from the fit to 12× in 3 s over the same stacks (6000 × 4000), after one not measured: the same three budgets (D96) | as B4 (twist); the badges' `--bz` then equals the zoom's |
| B4 (paused pinch) | The same pinch in four legs, the fingers hesitating 200 ms between them (shorter than a rest, `PINCH_REST_MS`), after one not measured: **no resize**, no task over 150 ms while the fingers are down (a hesitation alone can let the browser raster the layer again, which the next move waits for: 50–65 ms), no settle task over 150 ms (D102) | as B4 (pinch); `--bz`, read from its rule at the end of each pause, never changes |
| B4 (rested pinch) | The same pinch in four legs, the fingers resting `PINCH_REST_MS` + 50 ms between them — the badges resize at a rest, and the fingers move on 50 ms later — after one not measured: **no task over 150 ms** while the fingers are down, nor once they lift (D102) | as B4 (pinch); at each rest `--bz` takes the zoom's size if it differs from it by over 25%, and keeps its own otherwise |

### 2l. Test plan (Phase 2)

**`core-p2.test.mjs`** (Node):

1. `cleanBox`:
   - defaults, including `h` defaulting to `w`;
   - the shorthand faces;
   - every cap (n + 1 → throws, with the field named);
   - back equality (size, shape, `rotStep`, `hand`, `stack`);
   - `fills` and `marks` addresses, and address-like space ids refused;
   - `src` and `by` in the input are dropped;
   - bad colours and labels;
   - a fuzz of 2,000 random mutations of a valid box: never throws
     anything but `Error`, and never yields an invalid field.
   - `boxKey` and `canon`: key order does not matter; `isBuiltin` is true
     for each `BOXES` entry and false after any one-field change.
2. Every new action's semantics, and its refusals (owner, lock, cap, dice),
   including: the per-action `mayHandle` / `notLocked` table of 2c; `cap`
   on `deal`, `addDeck`, `t.deal`, `t.newPile` and setups; `split {onto}`
   atomicity; piece piles (`flip` needs backs, `draw` and `handPile` need
   `hand`, `deal` makes `k:'g'`, `peek` answers `{t, f}`); the hidden-item
   rule (identical refusal objects for hidden dice, tokens and stacks);
   the fixed bag `hand` flag; claim and lock limits.
3. Setup order: over 20 seeds, the z order and the key order of a
   setup's hidden pieces are uncorrelated with declaration order (a
   rank-correlation test), and `group {shuffle}` permutes positions.
4. The public reduction:
   - a hidden piece has no `t` or `f`, also when its box is missing;
   - a bag has no `of`;
   - `handy` counts correctly through put and remove;
   - `T.pub` equals a full recompute after 500 random piece ops.
5. Seats:
   - named-seat placement on round and rect tables;
   - automatic perimeter seating on rect tables;
   - joining takes the first free seat, then watches;
   - setting and clearing the seats;
   - a seat-bound owner follows the seat;
   - `seat {sit: true}` for a watcher under automatic seating.
6. `MIGRATE[2]`, and the board z band (newer boards above older ones,
   `boardSeq` restored).
7. `randInt` has no modulo bias: a χ² test on 60,000 draws of `randInt(6)`
   stays under the 99.9 % critical value.

**`t-p2-pieces.js`**

- It runs once with a desktop viewport and once with the iPhone 13 device
  descriptor.
- Host plus 1 guest, a test box with every kind. Each check is verified
  from **both** players' points of view, through `__ct.view()`, the
  DOM and the log:
  1. stack, split one, split one onto another stack, shift-drag all
     (desktop), "Move all" (touch);
  2. flip with a back, flip with 2 faces, turn with N faces;
  3. rotate by `rotStep`;
  4. roll one die alone, and a handful of three adjacent dice by one
     double-click (the tumble class appears; one log line; the faces agree
     on both screens);
  5. lock, and the refusal for a guest;
  6. the owner refusal, claim, release and give;
  7. a supply take by drag and by double-click, and returning by drop;
  8. a bag pull to the table and into the hand, `toBag`, and the counts;
  9. a tile pile: stack, draw, deal (the dealt items are `k:'g'`), flip,
     peek at a hidden top, and shuffle;
  10. a piece in the hand: drag to the table, face down when it has a back;
  11. a drag that starts on a locked board, or on a piece Alice owns (from
      Bob's screen), pans the view; no action is sent and no notice
      appears; a tap selects it.

**`t-p2-hidden.js`**: attacker cases 1–14 of 2j.

**`t-p2-tables.js`**

1. A rect table: the fit at each 90° seat view, the pan limits and the
   zoom max.
2. A box with named seats:
   - the guest gets the second seat;
   - a third player watches (the chip);
   - "Stand up" and "Sit here";
   - the host's "Move to watchers";
   - `t.players()` excludes watchers (through a tiny test script);
   - with automatic seating, a watcher moved by the host taps **Sit
     down** and gets a seat.
3. A seat-bound owner moves with a seat change.
4. Hand-bar hiding:
   - load draughts (no hand types, empty hand) → the bar is hidden on both
     screens;
   - add a deck → it shows;
   - remove it → it hides.
5. An old v2 save (`size: 1800`) migrates to a round `table`.
6. The size selector on a rect table shows "▭ w × h"; choosing a round
   size asks, then switches.
7. Every existing seat and layout suite passes unchanged on round tables.

**`t-p2-demos.js`**

- **Draughts by hand:** pick it from 🎲; there are 24 men; the light seat
  moves a light man; the dark player's attempt on a light man is refused;
  a capture is made by deleting the man; crowning by double-click shows ♛
  on both screens.
- **Backgammon:**
  - the start position (15 + 15);
  - double-clicking one of the two adjacent dice rolls both and logs
    "rolled a · b";
  - the cube's `face` reads 2;
  - a checker moves to the bar.
- **Screenshots** are saved for review (desktop and iPhone) and are not
  asserted pixel by pixel.

**`t-p1-bench.js`** is extended with the 1,000-piece variant (2k).

### 2m. Docs and module ownership

- **README.md:**
  - the "Pieces, dice and boards" section (the free-table interactions);
  - rect tables, named seats and watchers;
  - hand-bar hiding;
  - draughts and backgammon in the game list;
  - box and type `meta` are public (anyone at the table can read them).
- **ENGINE.md:** §2 gains `t.roll`, `t.random`, `t.type` and the extended
  `t.find` and `t.players`; the piece semantics of the existing ops; a
  note that `t.type(…).meta` is public data, never a place for secrets.
- **TABLETOP.md:** §7 marks Phase 2 done, and records the decisions made
  here.
- **index.html:** the help dialog gains the piece gestures.
- **Module ownership**
  - `core.js`: the item kinds, `cleanBox`, `canon`, `boxKey`,
    `isBuiltin`, `place()`, the hidden-item rule, the setup interpreter
    (Phase 2 subset), seats (named and automatic, plus the perimeter
    maths), owner and lock, `handy`, the board z band, indexes, the public
    reduction, `MIGRATE[2]`, the new actions and the facade additions.
  - `grid.js` (new): grid geometry for drawing, and the address grammar
    (`parseAddr`, `formatAddr`).
  - `pieces.js` (new): piece, supply, bag and board DOM, `boardSVG`, dice,
    badges.
  - `templates.js`: `BOXES.draughts`, `BOXES.backgammon`, and the new
    `GAMES` entries.
  - `app.js`: the table shape, layout and fit, the size selector on rect
    tables, the seat menu and watchers, drag and drop rules (panning on
    items the player may not handle, the dice handful), the action bar,
    `nohand`, the `boxes` channel and `itemsByBox`, the CLI additions.
  - `cli.js` and `cli.py`: the commands and help.

---

## 3. Phase 3: Space, and full-rules scripting in a Worker

**Goal:**

- grids, spaces, zones, links and snapping, with addresses in the log;
- rules that run in a Web Worker, with a watchdog and atomic hooks;
- `handle`, `strict`, `t.ask` / `onAnswer`, `onSelect` / `t.hint` and
  `t.secret`;
- components from code, and the spatial helpers.

**Demos:**

- chess with full rules (TABLETOP §6);
- go, 9 × 9 and 19 × 19 (up to 361 stones: the scale test);
- reversi.

### 3a. Data model and state changes

**Host state, v4** (the changes from v3):

```ts
Piece = { ...v3, at?: string }       // canonical QUALIFIED address "<boardItemId>:<local>", set when snapped
Rules = { code, name, enabled,
          data,                       // engine key: _timers (as today), validated (below)
          public,
          asks: { [pid]: Ask[] },     // NEW: t.ask; persisted; every entry passed cleanAsk
          secret: { [pid]: JSON },    // NEW: t.secret; persisted
          hints?: { [pid]: Hint } }   // NEW: t.hint; NOT persisted (stripped on save, cleared on resume)
Ask  = { id, prompt: string(≤200), options?: { label: string(≤30), value: JSON }[] /* ≤ 20 */,
         pick?: 'item' | 'space' | 'hand' | 'number', among?: string[] /* ≤ 200 */,
         count?: int[1..20], min?: int, max?: int }
Hint = { items?: id[], spaces?: string[] }   // ≤ 500 entries in total
```

- **Exactly one form per ask:** `options` (with no `pick`), or `pick`.
- **[DECISION] Where per-player script state lives.**
  - Asks live in `rules.asks`, not in `t.data`: they are engine-owned,
    so a script can neither corrupt them by writing `t.data` nor smuggle
    an unvalidated ask in through an imported game state. They persist,
    which keeps TABLETOP's "a host reload resumes them".
  - `t.secret` lives in `rules.secret`, beside `public`, and persists.
  - Hints are not persisted. They are a response to a selection, and a
    reload would show stale highlights for a selection the player no
    longer has.
- **Engine-state gates** (core, synchronous). They run on every write by
  the facade, on every save load, and on every import (`setRules.state`,
  §4c):
  - `cleanAsk(spec)`: the shape above, every cap of §10.4, ids matching
    the id regex; anything else throws `TypeError` (script) or drops the
    entry with `console.error` (load and import).
  - `data._timers`: an array of ≤ 1,000 entries `{at: finite number, tag:
    string(≤100)}`; anything else is dropped with `console.error`.
  - `secret`: keys match `PID_RE` and go through `own()` (`__proto__` and
    friends are rejected); each value is JSON of ≤ 8,000 chars.
- **The address grammar** is the one of §2a (`grid.js`, since Phase 2).
- **Qualified and display forms.**
  - Inside core, an address is qualified as `<boardItemId>:<local>`.
    This is what `at` and the indexes store.
  - **The primary board** is the structured board item whose type has
    `primary: true` (the oldest such, by `boardSeq`); else the oldest
    board with a `grid`; else the oldest board with `spaces`. Boards that
    only have `zones` (racks, screens, mats) never count.
  - **The display form**, used in the public view, the log and every
    script-facing return value, is the bare `<local>` on the primary
    board, and `<typeId>:<local>` on any other board, or
    `<typeId>#<n>:<local>` when several boards of that type are on the
    table (`n` counts them in `boardSeq` order, from 1).
  - **Every address-taking API** accepts the display forms and the
    qualified one. A bare address resolves against the primary board
    first, then against the one other board that has it (a space id that
    only the bar board has, say). If several non-primary boards have it,
    it is ambiguous: a script gets `TypeError("t.move: address 'bar' is
    ambiguous — use 'tray:bar' or 'tray#2:bar'")`, and a human action is
    refused with "🚫 Which board? Say 'tray:bar'".
  - **[DECISION] Primary-board addresses.** The earlier "bare only while
    one board is on the table" made `e4` turn into `<id>:e4` the moment a
    rack or a second map appeared, which broke scripts that store
    addresses and made the log unreadable. A stable primary board keeps
    "e4" meaning e4 all game. Renumbering of `#n` when an older instance
    of the same type is removed is the one remaining instability, and is
    documented.
- **Structured boards may only be rotated by 0, 90, 180 or 270°.**
  `cleanBox` forces `rotStep: 90` on any board type with a `board`
  structure.

**New indexes** (core, derived, rebuilt on load):

- `byAt: Map<qualifiedAddr, Set<id>>`;
- `byZone: Map<'<boardId>:<zoneId>', Set<id>>`.

Both are computed when a piece is placed. **[DECISION] Only pieces
(`k:'g'`) snap and get addresses.** Cards, piles, supplies and bags stay
free-form, and boards never snap. Card-driven board games still work
free-form. This is the smallest surface that covers every demo.

**When a board moves, nothing else moves.**

- A `move`, `rot` or `del` of a structured board, a `table` resize (which
  shifts every item), and a `group` that includes a board, move only the
  board (or shift everything uniformly).
- Afterwards core recomputes, **by containment, without moving anything**,
  the `at` and zones of every piece: a piece whose centre is now on a spot
  of some board (within reach, as in snapping) gets that address, and
  every other piece loses its `at`. `byAt` and `byZone` are rebuilt for
  the affected boards (all boards for `table`).
- Phase 5's private-zone effects fire **only** when a piece is placed,
  never because a board moved under it or away from it.
- **[DECISION]** Carrying the pieces along would make a board drag a mass
  move that rules would have to validate piece by piece; boards are locked
  by default, so a board move is a deliberate rearrangement of the table.

**Snapping** (core, `snapPiece(it, x, y) → {x, y, at | null}`; `grid.js`
does the maths):

1. Take the piece's centre `c = (x + w/2, y + h/2)`, with the size of the
   type, or of the back when hidden.
2. Among the structured board items whose rectangle contains `c`, pick the
   one with the highest z (the newest board, §2a), and convert `c` into
   its local coordinates (the inverse of the rotation about the board's
   centre). Which board is primary plays no part here: snapping is
   geometric, and the display form is computed afterwards.
3. **Spaces first.** Take the nearest space with `dist ≤ r`.
4. **Then the grid.**
   - square, `cell`: the cell that contains the point, if in bounds;
   - square, `point`: the nearest point within `cell/2`;
   - hex: the nearest centre within `R`, found by the pixel → axial →
     cube-round conversion.
5. Return the top-left that centres the piece on that spot, and its
   qualified address. With no spot in reach, keep `(x, y)` and return
   `at: null`.

**When snapping runs: in `place()`, on every placement of a piece**
(§0.2). The callers are, exhaustively:

- human: `move`, `take`, `pull`, `split`, `play` (a piece), `deal` from a
  piece pile, and every member of a `group` move (§4c);
- script: `t.move`, `t.spawn`, `t.take`, `t.pull`, `t.playFromHand`,
  `t.deal` (pieces), `t.layout`;
- setups (`loadBox`, `setup`, `reset`).

Scripts may pass `{x, y, free: true}` to skip snapping. Any new op that
places a piece MUST call `place()`.

### 3b. Wire protocol (PROTO 4)

- **The public piece** gains `at?: string`, in its display form.
- **The rules meta** in snapshots and patches becomes
  `{name, enabled, public, wants?: ('select')[], strict?: true}`.
  - `wants` lists the interaction hooks the script defines. Clients send
    `select` only when it contains `'select'`.
- **Per-recipient parts** live in snapshots and patches, beside `hand`, and
  are bound by the same `to`/`tp`:
  - `ask?: Ask[] | null` (`options` sent as labels only:
    `options: string[]`);
  - `hint?: Hint | null`;
  - `sec?: JSON | null` (that player's `t.secret` entry).

  In a snapshot each is present when non-empty. In a patch each is present
  when it changed for that recipient (`null` = cleared).
- **The host decides which parts changed per recipient.** `takeDirty()`
  gains `dirty.asks: Set<pid>`, `dirty.hints: Set<pid>` and
  `dirty.secret: Set<pid>`. They are computed by comparing JSON per pid
  for `rules.secret` and `rules.asks` (both small), and by marking for
  hints. These feed `mine(d, to)` in the broadcast tick (§1b.3), so a
  change that only concerns one player's ask, hint or secret is sent to
  that player alone, and nobody else's patch base moves.
- **Live drags** are `fx` entries `{p, id, x, y, live: 1}` or, for a
  group, `{p, ids, dx, dy, live: 1}` (3c, `drag`). They carry no state.

### 3c. Actions

**New and changed actions**

| Action | Payload and validation | Semantics | Log | Flood | Ruled |
|---|---|---|---|---|---|
| `move` (and the piece placements of `take`, `pull`, `split`, `play`) | the payload may carry `to` (advisory; **overwritten** by the host) | the host snaps (3a), sets `a.to` (the new display address or undefined) and `a.from` (the previous one), **before** hooks see the action. For `take`, `split` and `play`, `a.to` is where the **prospective** new piece would snap, using its type's size (the back's when hidden). For `pull`, core first draws the member, `a.pick = randInt(of.length)`, and snaps that member; the default effect then takes `of[a.pick]`. | "moved {label} {from} → {to}", or "moved {label} to {to}" / "moved {label} from {from}" | 1 | yes |
| `drag` | `{id, x, y}`, or for a group `{ids: id[1..200], dx, dy}`. Every coordinate goes through `num()`, and the resulting positions through `clampToTable`. Each id must exist and pass `mayHandle` and `notLocked`; failing ids are dropped with `console.warn` (no notice: live traffic), and so is a drag with none left. | **No state change.** The host pushes one fx, `{p, id, x, y, live: 1}` or `{p, ids, dx, dy, live: 1}` (the surviving ids), into the next broadcast. A commit that touches an item in the same tick drops that item from the tick's queued live fx, so a stale glide never overrides a committed position. The host's own drags SHOULD do the same. | none | 1 (for any number of ids) | no (never reaches the queue or the Worker) |
| `select` | `{id}`; the item exists and is **not hidden from this player** (§2c); rules enabled and `wants` includes `select`; at most 5 per second per player. Anything else is dropped with `console.warn`. | queued; the Worker runs `onSelect(t, p, id)` | none | 1 | no |
| `answer` | `{id, v}`; an ask with that `id` must be pending for **this** player; `v` must have been offered (table below) | removes that ask, then runs `onAnswer(t, p, id, value)` and then `onAction` | "{name} answered" (**never the value**) | 1 | no (checked by the engine) |

**[DECISION] `pull` draws its member before the hooks.** `a.to` must be
known to `handle` and `validate`, and it depends on the drawn member's
size. A veto discards the draw (the bag is unchanged); scripts already see
every bag's contents, so `a.pick` reveals nothing new to them.

**[DECISION] `select` is limited to 5 per second and refused on hidden
items.** Selection is cheap UI traffic, but each one runs a hook in the
Worker; 5 per second is faster than anyone clicks. On a piece hidden from
the player, a naive `onSelect` would hint its legal moves, and its
mobility would reveal its rank.

**[DECISION] Group drags are one `drag`.** One message per member would
be about 330 actions a second for a 200-item group, far past `flood()`,
and the drop that follows would be refused.

**[DECISION] Live drag positions travel as `drag`, not `move`.**

- Today a guest's drag sends a throttled `move` 16 times a second, and
  each one mutates state, saves, and is validated.
- Under `handle` and `strict`, every intermediate position would count as
  an attempted move ("Illegal move" notices while dragging).
- With `drag`, the drop is the only `move`.
- Other players still see the glide: they render the live fx position
  until the next committed update for that item, or for 1.5 s.

**Answer validation** (on the host, in core, before any hook):

| Ask form | The `v` that is accepted | The `value` passed to `onAnswer` |
|---|---|---|
| `options` | an integer index into `options` | `options[v].value` (default: the label) |
| `pick:'item'` | an item id in `among` that still exists | the id |
| `pick:'space'` | an address in `among` (either form) | its display form |
| `pick:'hand'` | an array of exactly `count` distinct `{idx, d, i}` or `{idx, t, f}`, each matched in the hand (`handIdx`) | an array of `{d, i}` or `{t, f}` (the cards stay in the hand) |
| `pick:'number'` | an integer in `[min, max]` | the integer |

- Anything else is refused: "🚫 That answer wasn't offered", with
  `console.warn`. No hook runs and the ask stays.

**The `strict` and `allow` scope.**

- `STRICT_ACTIONS` = `RULED_ACTIONS` minus `seat`.
- Under `strict: true`, such an action is refused ("🚫 Not a move in this
  game") when `handle` does not return `true` and `a.t ∉ script.allow`.
- **[DECISION] `allow`.** A strict script that wants the default effect
  for, say, `rot` or `peek` lists them in `allow: ['rot', 'peek']`. Without
  this, strict mode could not keep any default effect, since `handle`
  returning `undefined` is exactly what strict refuses.
- **[DECISION] `seat` is never refused by `strict`.** Players must always
  be able to sit down. `validate` and `handle` may still veto it.

**Internal actions.** These are host-created only. Their names begin with
`_`, they are never in `PUBLIC_ACTIONS`, and they are refused from the wire.

| Internal | Created when | Core semantics |
|---|---|---|
| `_join {p, name}` | the first keyed action of a player who is not online (today's `back`) | `ensurePlayer`, the "joined the table" / "is back at the table" log, then `onJoin` |
| `_leave {p}` | `onPeerLeave`, when the player has no other connection | `online = false`, the "left the table" log, then `onLeave` |
| `_tick {}` | the 700 ms host interval finds a due timer in `state.rules.data._timers` and no `_tick` is queued | fire the due timers (by `env.now()`), running `onTimer(t, tag)` for each, then `buttons` |
| `_rulesOff {reason}` | the watchdog, a Worker crash, or `setRules {enabled:false}` | `rules.enabled = false`, and the log "rules disabled — {reason}" |
| `_name {p, name}` | the rename sync on a new connection (today's `apply(p, {t:'name'})` in `actA.onMessage`) | the same as `name` |

- **A queued `_join`.** Until its `_join` commits, a newly keyed player
  has no `state.players` entry. The broadcast tick addresses that peer's
  bodies to `to = null` until it does (§1b.3), so no body is ever addressed
  to a player who doesn't exist yet.

### 3d. Public view and hidden information

- **The public piece** gains `at` (display form). It is public even for a
  hidden piece: a position is public.
- **What only the recipient receives:**
  - `ask`, `hint` and `sec` go only to `to`, from `rules.asks[to]`,
    `rules.hints[to]` and `rules.secret[to]`;
  - a peer that is not registered receives none of them;
  - no other peer receives them, in any body.
- **Asks and the log.** An ask's `among`, `options` and `prompt` are seen
  by that player only. The log only says "answered".
- **Hints are private.** A hint can reveal a script's knowledge of hidden
  state (legal targets). That is the script author's choice, and it goes
  only to the hinted player. The engine refuses `select` on a piece hidden
  from the selecting player (3c), so a script never hints the mobility of
  a hidden opponent piece because of a selection.
- **What the Worker sees.** It holds the full private state, keys
  excepted. It is host-side, and inside the host's trust boundary.

### 3e. Facade (`t`) and hook additions

**Hooks** (all optional; `this` is the script object, as today):

| Hook or flag | Signature | Semantics |
|---|---|---|
| `handle` | `handle(t, a)` → `undefined` \| `string` \| `true` | Runs for every **ruled** action, before `validate`. `undefined`: continue (validate, then the default effect, or the `strict` refusal). `string`: a veto (its ops are **rolled back**). `true`: handled (its ops are kept, and the default effect is skipped). A **thenable** (an `async` hook, or a returned Promise) is an error, and fails closed (3f.4). Any other return is treated as `undefined`. |
| `strict` | `true` | See 3c. |
| `allow` | `string[]` | Action types whose default effect `strict` keeps. |
| `onAnswer` | `onAnswer(t, pid, id, value)` | After an accepted `answer`. |
| `onSelect` | `onSelect(t, pid, id)` | After a `select`. Typically calls `t.hint`. |

- **`a` is frozen.** Hooks receive `a` as a frozen deep copy: `{...a, p,
  to?, from?, handled?}`. A script can therefore never change the action
  that core goes on to apply.
- **`onAction`** also runs after **handled** actions, with
  `a.handled = true`. **[DECISION]** That keeps one place for "after every
  move" bookkeeping, and a script that doesn't want it checks `a.handled`.
- **`onAction` also runs after** `chat`, `rulesBtn` and `answer`, as it
  does today for the first two.
- **No hook may be asynchronous.** Any hook (or `validate`) that returns a
  thenable is treated as a throw from that hook (3f.4): `handle` and
  `validate` then fail **closed**. Today an `async validate` returns a
  Promise, which is not a veto string, so it would fail *open*.
- **State on the script object is not journaled.** `this.x = …` (the
  script object's own properties) survives a rollback and is lost on a
  host reload or Worker restart. ENGINE.md says to keep game state in
  `t.data`, which is journaled and persisted.

**Facade additions** (every call throws `TypeError` on a malformed
argument, and returns `false` when a referenced item has vanished):

| Call | Returns | Notes | Log (Rules) |
|---|---|---|---|
| `t.ask(pid, spec)` | `undefined` | Validates the spec through `cleanAsk` (3a; for `item` and `space`, `among` is required; for `number`, `min ≤ max` with `max − min ≤ 1e6`; `id` matches the id regex). `options` entries may be plain strings, as in TABLETOP's example: `'♕'` means `{label: '♕', value: '♕'}`. It replaces a pending ask with the same `id`. At most 8 pending per player. Stored in `rules.asks[pid]`. | none (asks are private) |
| `t.cancelAsk(pid, id?)` | `boolean` | Removes one ask, or all of that player's asks. | none |
| `t.asks(pid)` | `Ask[]` copies | | |
| `t.hint(pid, h \| null)` | `undefined` | `h = {items?, spaces?}`, at most 500 entries. Cleared automatically when that player's next ruled action starts. The clear is journaled, so a **vetoed** action restores the hint (the player can try again with the highlights still shown); an applied or handled one leaves it cleared. | none |
| `t.secret` | an object, `{[pid]: JSON}` | Assign `t.secret[pid] = {...}`; `delete` it to clear. Checked at commit: every key must match `PID_RE` and pass `own()` (no `__proto__`), and every value must be JSON of at most 8,000 chars; otherwise the hook fails. The engine renders `.text` (≤ 1,000 chars); the CLI gets the whole object. | none |
| `t.newBox(def)` | `boxId` | `def = {name?, pieces, backs?, decks?}` in the `game.json` format of §4a (with the faces shorthand). **No images**: any `img` throws. `decks` are `deck.json`-style text decks (TABLETOP's `t.newBox({pieces, decks})`), registered as ordinary decks; `t.box(id).decks` maps their names to deck ids. The box goes through `cleanBox` and is **deduplicated** by content (`boxKey`, §2j): defining the same box again, as a reset that re-runs `setup` does, returns the existing id. Otherwise it is registered (`src: 'script'`) and broadcast on `boxes`. | "defined the box «{name}» ({N} piece types)" (nothing when deduplicated) |
| `t.spawn(type, o?)` | `id`, or `false` at the item cap | `type` is `'box/type'`. `o = {at?: Address \| 'center' \| {x, y, free?}, f?, n?, owner?, up?, rot?, lock?, as?: 'piece' \| 'supply'}`. The defaults come from the kind (boards are locked). | aggregated "placed N pieces" |
| `t.newBag(contents, o?)` | `id` | `contents = [{t, f?, up?, n?}]` (≤ 1000 in total). `o = {at, name?, owner?, hand?}`; `hand` defaults as in 2a and is then fixed. | "made the bag {name} ({N} pieces)" |
| `t.take(supplyId, o?)` | `id`, `{hand: true, t, f}`, or `false` | `o = {at?, to?: pid}`. `to` puts the piece into that hand. | "took {label} from {supply label}" |
| `t.pull(bagId, o?)` | `id`, `{hand: true, t, f}`, or `false` | random, with the crypto RNG | as the human `pull` |
| `t.setFace(id, f)` | `boolean` | Any piece, dice included. `f` is in range, or it throws. | aggregated "turned N pieces" |
| `t.setCount(id, n)` | `boolean` | `n ∈ int[0..999]`; 0 removes the piece; n ≥ 2 needs a `count` type. | aggregated |
| `t.lock(id, on)` | `boolean` | | aggregated |
| `t.setOwner(id, owner \| null)` | `boolean` | `owner` is a pid or `'seat:<id>'` | aggregated |
| `t.setSeats(defs \| null)` | `undefined` | The `SeatDef[]` rules of 2a, including re-seating. | "set the seats: White — Alice, Black — Bob" |
| `t.setTable(def)` | `undefined` | `TableDef` (2a) | as the `table` action |
| `t.move(id, at)` | `boolean` | Also accepts an address string, or `{x, y, free?}`. `t.move(id, x, y)` still works. | as today, with addresses |
| `t.where(id)` | the display address, or `null` | | |
| `t.at(addr)` | item copies, sorted by z | from `byAt` | |
| `t.find(q)` | | gains `zone` (a zone id, or a qualified one) and `at` | |
| `t.zones(id)` | `string[]` | the zones containing the piece | |
| `t.spot(addr)` | `{x, y}` | the centre, in table coordinates | |
| `t.neighbors(addr, o?)` | addresses | square: 4, or 8 with `{diag: true}`; hex: 6; in bounds only; a space returns its links | |
| `t.distance(a, b, o?)` | `int`, or `null` | square: `o.metric` is `'chebyshev'` (the default) or `'manhattan'`; hex: cube distance; `null` across boards or for spaces | |
| `t.line(a, b)` | addresses strictly between `a` and `b`, or `null` | square: only on a rank, file or diagonal (else `null`); hex: a cube-lerp line | |
| `t.linked(space)` | space ids | from `links`, undirected | |

**Aggregating Rules log lines.** **[DECISION]** In one action, a run of 4
or more consecutive Rules log lines of the same *aggregating* op merges
into one line.

- The aggregating ops are: placed, removed, turned, counted, locked,
  owner, used randomness.
- Example: "📜 Rules removed 30 pieces: D4, E4, D5, …" (the first 8
  addresses or labels).
- Reason: TABLETOP wants every script effect "on the record", and a go
  capture or a setup would otherwise flush the 200-line action log.
- It is implemented as a per-action buffer, flushed at commit, in core.

**Persistence.**

- `_timers` (as today) is the one engine key in `t.data`. Scripts MUST NOT
  write it, ENGINE.md documents it, and it is validated (3a).
- Asks live in `rules.asks`, and `secret` in `rules.secret`, beside
  `public`.
- Hints are never persisted.
- `setRules` with *Reset game state* clears `data`, `public`, `asks` and
  `secret`.

### 3f. The Worker

#### 3f.1 Architecture

```text
        guests ──act──▶ app.js (host main thread) ──────────────────────────────▶ broadcast (patches)
                         │  auth, _v, PUBLIC_ACTIONS, flood, ingest (assets)            ▲
                         ▼                                                              │
                      queue (FIFO, one job in flight)                                  │
                         │ rules disabled → T.apply(p, a) (host core)  ───────────────┤
                         │ rules enabled  → worker.postMessage({type:'act', …})        │
                         ▼                                                              │
                rules-worker.js: core.js mirror + the script ─▶ {type:'done', patch, out} ─▶ T.applyStatePatch(patch)
```

- **The host state stays authoritative.** The Worker's mirror is
  speculative: it is the state the host will hold *after* applying the
  returned patch.
- **The one invariant:** while the rules are enabled, **every** host-state
  mutation comes from a Worker patch. While they are disabled, no Worker
  exists.
- The invariant is enforced in `app.js`: with a live Worker, the queue
  never calls `T.apply` directly, except for `_rulesOff` after the Worker
  is terminated.
- In test builds (`CARDTABLE_TEST`) a debug assertion checks it.
- **[DECISION] The Worker is the only writer; the mirror is not synced
  through public patches.** TABLETOP says the mirror is "kept current with
  the same patches that sync the guests". Those patches are *public*
  views: they carry no hidden identities, pile contents or hands, so they
  cannot keep a *private* mirror current. Instead every mutation is made
  by the Worker itself and shipped to the host as a private `StatePatch`,
  so mirror and host agree by construction (3f.3).
- **Demotion stops the Worker.** When the host demotes itself to a guest
  (the rival-host branch of `handleState`), it terminates the Worker,
  rejects every queued job (`{error: 'this tab is no longer the host'}`),
  clears `sync`, cancels the save throttle and the pending marker, and
  stops persisting. Nothing the old Worker might still post is applied.

#### 3f.2 Message protocol (structured clone; no functions)

**Host → Worker**

```ts
{ type: 'init', proto: PROTO, mv: MODULE_V, hostId: pid, code: string,
  globals: { CAH_CARDS?: object },           // see 3f.7
  state: HostState /* WITHOUT keys */, decks: {…}, boxes: {…}, now: ms }
{ type: 'act', id: int, p: pid | 'RULES', a: Action /* sanitized; internal ones too */, now: ms }
```

**Worker → Host**

```ts
{ type: 'ready', name: string, wants: string[], strict: boolean }
{ type: 'evalError', message: string }       // the code failed to evaluate, or isn't an ({…}) object,
                                             // or init.proto / init.mv differ from the Worker's ("version mismatch")
{ type: 'done', id: int, patch: StatePatch, out: Out, ms: number /* worker-side time */ }
{ type: 'fatal', message: string }           // uncaught error or unhandled rejection outside the action protocol
StatePatch = {
  items?: { [id]: Item | null },             // full PRIVATE items; null = removed
  players?: { [pid]: Player },               // full private players (hands included)
  decks?: { [deckId]: Deck }, boxes?: { [boxId]: Box },          // new catalog entries
  rules?: Partial<{ code, name, enabled, data, public, asks, secret, hints, box }>,
  table?: TableDef, seats?: SeatDef[] | null,
  log?: LogEntry[],                          // to append (then trimLog)
  zMax?: int, boardSeq?: int, guestDeckChars?: int, lastSetup?: boxId,
  refresh?: id[], refreshHands?: pid[],      // the refusal touches (no state change)
}
Out = { fx: Fx[], ann: string[], notes: { p, msg }[], peeks: { p, card }[],
        error?: { hook: string, message: string } }   // a hook failed: the rules are now disabled (it's in the patch)
```

#### 3f.3 Keeping the mirror in sync

- **At init**, the host clones its whole state into the Worker. Keys stay
  behind. Decks and boxes are small, because images are asset ids since
  Phase 1.
- **After init** there is no separate sync channel. Every mutation goes
  through the Worker in queue order, so after each `done` the mirror and
  the host state are equal by construction.
- **Proving it.** `T.digest()` is a cheap structural hash (seq-free, over
  items, players and rules).
  - Tests compare it on both sides after a random 300-action run, with
    `__ct.workerDigest()`.
  - In test builds the host compares it every 50 actions, and a mismatch is
    a loud `console.error`.

#### 3f.4 The ruled-action pipeline (in the Worker, `core.apply` with the script interface)

```text
guard()                                              // 3f.7: data/public/asks/secret JSON === last committed, else post fatal
T.begin()                                            // journal: pre-images on first touch; JSON snapshots of data/public/asks/secret
if a is internal / not ruled:                        // _join/_leave/_tick/chat/rulesBtn/answer/select/name/table/loadBox/clear/…
    default effect; checkpoint; the hook(s) the action implies (onJoin/onLeave/onTimer/onChat/onButton/onAnswer/onSelect); onAction where 3e says
else:
    clear hints[p]                                   // journaled: a veto restores it
    prepare(a)                                       // snap → a.to/a.from; pull → a.pick (3c)
    if script.handle:
        r = handle(A)            · throws or thenable → rollback(); FAIL_CLOSED('handle')
                                 · string  → rollback(); VETO(r)
                                 · true    → handled = true
    if !handled:
        if strict && a.t ∈ STRICT_ACTIONS && a.t ∉ allow → rollback(); VETO('Not a move in this game')
        if script.validate: r = validate(A) · throws or thenable → rollback(); FAIL_CLOSED('validate') · string → rollback(); VETO(r)
        default effect (the core op switch); took = (fx grew)
    else:
        refresh touches (1c) for every item and hand the action names
    checkpoint()                                     // what we keep even if a later hook throws
    if took || handled: onAction(A)   · throws or thenable → revert to checkpoint; FAIL('onAction')
buttons()                            · throws or thenable → revert to checkpoint; FAIL('buttons')
size and gate checks (data ≤ 4e6; secret keys and ≤ 8e3 per pid; asks via cleanAsk) · fail → revert to checkpoint; FAIL('size')
flush the aggregated Rules log; patch = T.commit()
await drain()                                        // 3f.7: let stray microtasks run, then re-check; then post done

VETO(r):        log "blocked {name}: {r}" as RULES; notes += {p, '🚫 ' + r}; refresh touches (1c); commit
FAIL_CLOSED(h): rules.enabled = false; log "rules disabled — script error in {h}()"; notes += {p, '🚫 rules script error'};
                refresh touches; out.error = {hook: h, message}; commit           (the action does NOT apply)
FAIL(h):        rules.enabled = false; log as above; out.error; commit the checkpoint's patch plus those lines
```

- **A handled action refreshes.** When `handle` returns `true`, the
  items and hands the action names (`id`, `pile`, `onto`, `ids`, `bag`;
  the hand for hand actions) are refresh-touched, exactly as after a
  refusal. A script that handles a drop without moving the dragged item
  would otherwise leave the actor's optimistic position on screen until
  the 1.5 s live-drag hold expired; with the touch, the next patch puts
  it where the script left it.

**Atomicity, as a contract** (core tests cover each case):

| A hook throws, or vetoes | The table afterwards |
|---|---|
| `handle` vetoes after doing ops | none of its ops; the veto line; the refresh; the hint restored |
| `handle` or `validate` throws, or returns a thenable | none of its ops; the action not applied; the rules disabled |
| `onAction`, `onChat`, `onButton`, `onAnswer`, `onSelect`, `onJoin`, `onLeave`, `onTimer` or `setup` throws, or returns a thenable | the action's own default effect (or registration, chat line, timer removal) is **kept**; the hook's partial ops are **discarded**; the rules disabled |
| `buttons()` throws | as above (`public.buttons` keeps its last value) |
| one member of a `group` is vetoed (§4c) | only that member's ops are rolled back (`rollbackTo` its savepoint); the other members apply |

- **The journal.** `begin()` snapshots the JSON of `rules.data`,
  `rules.public`, `rules.asks` and `rules.secret`.
  - Every `put`, `remove`, `touch`, `touchPlayer`, catalog add,
    `table`/`seats` set, hint change and log push records a pre-image the
    first time it touches a key.
  - `rollback()` restores those pre-images.
  - `checkpoint()` serializes the patch so far, and starts a new journal
    segment.
  - `savepoint() → token` and `rollbackTo(token)` nest inside a segment:
    `rollbackTo` restores only the pre-images recorded after the token
    (and the `data`/`public`/`asks`/`secret` JSON taken at the token). The
    `group` expansion uses them per member (§4c).
  - **Not journaled:** properties of the script object itself (`this`,
    3e), and anything outside the state (the script's own closures).
  - **The cost** is O(touched + |data|) per action. **[DECISION]** It is
    what makes "a script that throws halfway leaves no half-applied moves"
    true. Comparing `data` JSON is also how changes to `data` are found.

#### 3f.5 Queue, ordering and the watchdog

- **One FIFO** on the host, for every state-changing job, rules on or off.
  Only one job is in flight to the Worker at a time.
- **The FIFO is blocked while a Worker initializes** (Enable, re-enable,
  or a resume): jobs wait in the queue until `ready` or `evalError`
  (3f.8), and the `init` watchdog (10 s) bounds the wait.
- **`MAX_QUEUE` = 500.**
  - Beyond it, guest actions are refused: "🚫 The table is busy — try
    again", with `console.warn`.
  - Internal jobs are always accepted. They are bounded by peers and the
    timer.
- **The watchdog.**
  - Each `act` has a budget of `RULES_TIMEOUT_MS = 4000`, plus
    `10 ms × members` for a `group` (§4c) and `10 ms × items` for a setup
    or reset (the number of items it lays out). `init` has 10,000.
  - **It counts visible time only.** Phones freeze or throttle a hidden
    tab, and a frozen tab resumes with the timer already overdue, possibly
    before the queued `done` has been handled. That must never kill
    healthy rules.
    - The budget is measured with `performance.now()`.
    - On `visibilitychange` to hidden (or the `freeze` event), the timer
      is paused; on visible (or `resume`), it is re-armed for the remaining
      budget plus a 1 s grace.
    - When the timer fires, if `performance.now()` shows it fired more
      than 1 s late (the page or the machine was stalled), it is re-armed
      once for 1 s.
    - The Worker is terminated only after a full budget of visible,
      on-time waiting.
  - When it does fire, `worker.terminate()`, then on the main thread:
    1. `T.apply(_rulesOff {reason: 'the script took longer than 4 s (stopped)'})`;
    2. `lastRulesError` is set;
    3. a toast: "Rules stopped — the script didn't answer within 4
       seconds";
    4. the in-flight actor is notified: "🚫 The rules stopped responding —
       your action was not applied", with the refusal touches computed by
       host core (`T.refreshFor(a)`).
  - The queue then continues on the free table.
  - **The in-flight action is dropped** (fail closed). The table itself is
    untouched, because no patch was applied.
  - **[DECISION]** A scaled, visible-time watchdog. A fixed 4 s would
    misfire on a phone host that was backgrounded mid-action, and on a
    200-member group or a 3,000-item setup that legitimately takes longer
    on a slow phone.
- **A Worker crash** (`error`, `messageerror`, or `{type:'fatal'}`) is
  handled the same way, with the reason "the script crashed: {message}".
- **Re-enabling** spawns a fresh Worker from the host's current state.

#### 3f.6 How the host applies a patch

`T.applyStatePatch(patch, out, job)`, in core, run on the host:

0. **The checks** (D142, D144, D145, D148–D150, D152: `checkPatch`), in
   the host's realm, before anything applies: every field as the engine
   writes it — the patch's and the rules' keys known; the catalog only
   grows (new ids, `cleanDeck`, `cleanBox`, a box's `src` and `by`); items
   `itemProblem` (finite x, y, rot and z, |z| ≤ `Z_MAX`; an address text of
   at most 100 characters; a pile's cards and a bag's members cards or
   pieces; MAX_ITEMS in all; a new one under a fresh id) and players
   `playerProblem` (a name, a colour, online, a hand, a seat); the rules'
   fields through the engine's gates (asks kept as `cleanAsk` leaves
   them); the table and seats cleaned; log lines with `logEvent`'s fields,
   at most LOG_TXT_MAX, no bucket over its cap; the counters only growing,
   within bounds (`zMax` ≤ `Z_MAX`); the effects rebuilt from the fields
   the engine writes (a marker `{p, id, x, y, roll?}`, a notice `{p,
   msg}`…: only those copies are carried out, D149) — and against `job`
   ({p, a}): a player appears only in their own `_join`; a name changes
   only by their `name` / `_name` or their `_join` filling an empty one, to
   the very name the engine gives (`cleanName(a.name)`, `joinName(a.name)`:
   one expression each, shared, D152); a colour never; `online` only by
   their `_join` or `_leave`; the rules' `code` and `name` only in the
   host's enabling `setRules` (that code); `enabled` on only there, off
   only with `out.error`, a Disable or `_rulesOff`; `guestDeckChars` only
   by a guest's `addDeck`; in an `addDeck` whose line names its player, the
   deck and that line exactly as `cleanDeck(a.deck)` makes them in the
   host's realm (D148); every log line and name bulb `job.p`'s or RULES', a
   chat line only `job.p`'s own message in their `chat`, a frozen name once
   on their rename, a line on the record (`k`) and a peek's answer only in
   their `peek`. A failure throws with nothing applied; the app ends the
   rules with the job in flight (a registration kept, an action dropped
   aloud).
1. **Items.** `null` → `remove(id)`; otherwise `put(id, item)`. This
   updates the indexes, `T.pub` and the dirty sets.
2. **Players.** Each entry is replaced, with `touchPlayer(p)`. Mark
   `hands` when the hand's JSON changed. Keys are untouched, because they
   are not in `players`.
3. **The catalog.** The decks and boxes step 0 cleaned (`cleanDeck`,
   `cleanBox`). Then the catalog add (`dirtyDecks` and `dirtyBoxes`, and
   the catalog record at the next save).
4. **Rules fields** are replaced; `dirty.rules`, `asks`, `secret` and
   `hints` are marked per pid. A change of `code` marks `rulesCodeDirty`.
5. **Table and seats** are replaced, with dirty marks. A table or board
   change recomputes `at` and zones by containment (§3a).
6. **The log** is appended and trimmed (`dirty.log`). **Counters** are
   set.
7. **Refresh touches** (`touch` / `touchPlayer` without a change).
8. **Then the app** runs `state.seq++` (if anything changed or refreshed),
   `scheduleBroadcast()` and `persist()`, and drains `out`:
   - `notes` → `notify` (flood-limited as today);
   - `peeks` → private notes;
   - `ann` and `fx` → the broadcast queues;
   - `out.error` → `lastRulesError`, plus a toast "Rules disabled — error
     in {hook}(): {message}". On error the Worker is also terminated.

#### 3f.7 Script evaluation, window globals and hardening

- **The module.** `rules-worker.js` is a module Worker:
  `new Worker(new URL('./rules-worker.js', import.meta.url), {type: 'module'})`.
  It imports `./core.js`.
- **The version check.** The first thing `init` does is compare
  `init.proto` and `init.mv` with the Worker's own `PROTO` and `MODULE_V`;
  on a mismatch it posts `evalError` "version mismatch — reload this
  page" and evaluates nothing (§1b.6).
- **Hardening.** Before it evaluates anything, it captures
  `const post = postMessage.bind(self)`, its message listener, the real
  `setTimeout` (for `drain()`, below) and `performance.now` (a platform
  object a script may change). It reads only trusted messages (D140); a
  message's `data` getter and `Promise` are frozen built-ins by the time
  any script runs (the lockdown, below: D148 drops the copies D144 took).
  Then (D145):
  - **An allowlist.** Every name on `self` and its prototypes (up to
    `Object.prototype`) that is neither the language's (`BUILTINS`) nor on
    a reviewed platform list (`PLATFORM`: `self`, `globalThis`,
    `location`, `performance`, `TextEncoder` / `TextDecoder`, `URL`,
    `atob` / `btoa`, the event classes, the event-listener methods…) is
    deleted: the network, storage, other Workers and channels, its own
    `postMessage`, notifications, devices, the site's service workers
    (Safari and Firefox expose `navigator.serviceWorker` in a Worker), a
    real timer (`scheduler`), and whatever a browser adds next.
    `navigator` becomes a frozen plain object of `userAgent`, `language`,
    `languages`, `hardwareConcurrency` and `onLine`. `close` and the
    timers become throwing stubs; `scheduler.postTask` throws the timers'
    message. A name a browser won't let go is said (`console.error`) and
    the Worker goes on (D131).
  - **The lockdown.** Every built-in in `BUILTINS` (the language's, plus
    `console`, `crypto`, `structuredClone` and the event classes the
    Worker's own code reads), the intrinsics the syntax reaches
    without a name (the iterators `for…of` and spread use, the generator,
    async and async-generator functions and their prototypes, `%TypedArray%`,
    the iterator helpers), and every export of the engine's own modules —
    `core.js`, `grid.js`, `templates.js`, which a script can `import()` by
    the same URLs and so reach the very instances the engine runs (D148) —
    is frozen all the way down: prototypes, property values, getters and
    setters. A global or sticky regex (`CTRL`, `CTRL_NL`: `lastIndex` must
    stay writable) only takes no new property. The engine exports no `Set`,
    `Map`, `Date` or typed array, whose contents no freeze holds (its lists
    are frozen arrays; core-p3 checks every export). Each built-in's global
    name is then fixed (neither writable nor configurable). The properties
    a script commonly sets on its own objects (every data property of
    `Object.prototype` — a tally keyed by what players type may meet
    `__lookupGetter__` —; `Function.prototype`'s `toString`, `call`,
    `apply`, `bind`; an error prototype's `name`, `message`;
    `Promise.prototype.constructor`) become accessors that read as before
    and, set on an object that inherits them, define that object's own
    property — the override mistake, worked around as SES does. The engine
    therefore runs on built-ins and modules no script can change; the host
    still checks each patch in its own realm (3f.6 step 0).

  **[DECISION] This is defence in depth, not a sandbox.**
  - A rules script sees all hidden information and can reveal it in game
    (`t.tell`), so enabling one is an act of trust, as ENGINE.md already
    says.
  - Removing the network APIs stops casual exfiltration outside the table.
  - Dynamic `import()` cannot be removed without a CSP, and GitHub Pages
    cannot set the headers a Worker would need. That limit is documented in
    the README's honest limits.
- **Evaluation:**

  ```js
  new Function('setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
    `"use strict"; return (\n${code}\n);`)(...STUBS)
  ```

  Each stub throws "{name} is not available to rules scripts — use
  t.schedule(seconds, tag)". An ordinary hook throw then fails loudly
  through the 3f.4 path.
- **Page APIs explain themselves.** Saved user scripts that worked on the
  page may touch `document`, `alert`, `localStorage` or `sessionStorage`.
  In the Worker each is a value on `self` (so `window.x` too) whose every
  use — a property read or write, a call — throws "{name} is not
  available: rules now run in a Worker, away from the page (see ENGINE.md,
  'Running in a Worker')" (a Proxy over a throwing function: D147). The
  rules then disable with that message instead of a bare `ReferenceError`.
- **Window globals.**
  - `self.window = self`, then `Object.assign(self, init.globals)`.
  - The page sends `globals = { CAH_CARDS: window.CAH_CARDS }`, the one
    window global any template reads, so `window.CAH_CARDS` keeps
    resolving inside the Worker.
  - The list lives in `app.js` as `WORKER_GLOBALS = ['CAH_CARDS']`.
  - **[DECISION]** The page passes the data. `importScripts` does not exist
    in module Workers, and `cah-cards.js` is a classic script whose global
    the page already holds. Copying it costs about 50 KB once per Worker
    start.
- **No async code.** Three guards, because a `Promise` cannot be removed:
  - The facade is live only while a hook runs (`T.inHook`). Any `t.*` call
    outside a hook throws "t.{name} was called outside a hook — rules
    hooks must be synchronous". In a stray promise that throw becomes an
    unhandled rejection; the Worker's handler posts `fatal`, and the host
    disables the rules loudly.
  - A hook that **returns a thenable** is treated as a throw (3f.4), so an
    `async validate` fails closed instead of open.
  - A stray continuation can still mutate `t.data` directly
    (`Promise.resolve().then(() => { t.data.x = 1 })`), with no `t.*`
    call. So after commit and before posting `done`, the Worker runs
    `drain()`: it awaits one real `setTimeout(0)` (captured before
    hardening), by which time every microtask the hook queued has run, and
    then compares `JSON.stringify({data, public, asks, secret})` with the
    JSON it just committed. At the start of every job, `guard()` makes the
    same comparison against the last committed JSON, then the value gate
    (functions included, D146). A mismatch posts `fatal` ("the script
    changed t.data outside a hook"), and the host disables the rules: its
    `message` is the engine's fixed words, which the public log carries;
    which value, under which of the script's keys, travels as `detail`, for
    the host's toast and 📜 dialog alone (D145). Without these checks the mirror would silently
    diverge from the host until some later job happened to send `data`.
  - **[DECISION]** These guards make "hooks must be synchronous" an
    enforced rule rather than advice.
- **Errors.** The Worker registers `error` and `unhandledrejection`
  handlers, which forward to the host as `fatal` (CLAUDE.md). A
  `console.log` from a script stays in the Worker's console, which devtools
  shows.

#### 3f.8 Enabling, disabling and resuming

- **`setRules {enabled: true, code, reset}`.** When it reaches the head of
  the queue:
  1. Spawn a candidate Worker W′, and send it `init` with the current state
     and `code`.
  2. On `evalError`, discard W′. The running rules (W, if any) keep
     running. `act()` resolves `{error}`, and the dialog stays open showing
     it, with the toast "Rules error: … — the running rules are unchanged".
  3. On `ready`, terminate W (if any), make W′ the Worker, and send it the
     `setRules` action. Its core does today's keep-or-reset logic, logs
     "«{name}» enabled by {host}", runs `setup` (atomically: a throw
     discards setup's partial ops and disables the rules), then `buttons`.
- **`setRules {enabled: false}`.** At the head of the queue: terminate W,
  then `T.apply(_rulesOff {reason: 'by {host}'})` on the host. The log line
  stays "rules disabled by {host}".
- **The rules dialog.** The host's Enable button shows "Starting…" while
  it awaits `act()`. It closes on `{ok}`, and shows `lastRulesError` on
  `{error}`.
- **Host resume with `rules.enabled`.**
  1. `becomeHost` resumes the state (players offline, hints cleared,
     "resumed the table").
  2. It spawns W with `init`, without running `setup`, exactly as today's
     resume re-evaluates without calling setup.
  3. If `evalError`: `T.apply(_rulesOff {reason: 'the saved script failed
     to load: …'})` and the toast "Saved rules failed to load: …".
  4. Actions that arrive before `ready` wait in the queue (3f.5): the
     FIFO is blocked while any Worker initializes, for Enable as well as
     for a resume.
  5. A version mismatch (`evalError` "version mismatch") disables the
     rules as in step 3, with the toast "Card Table was updated — reload
     this page to run rules".
- **Timers.** The 700 ms interval only *enqueues* `_tick`. The Worker reads
  `env.now()` from the message's `now`. Timers survive a reload through
  `data._timers`, as today.

#### 3f.9 Backward compatibility of every existing template

Each template MUST run **unmodified**. The existing suites (`t-rules`,
`t-engine`, `t-holdem`, `t-holdem-logic`, `t-cah`, `t-fun-games`,
`t-final-games`, `t-final-logic`, …) are the proof.

| Template | What it relies on | How the Worker preserves it |
|---|---|---|
| `blank` | the hook skeleton | — |
| `turns` | `onJoin`, `onLeave` and `onTimer` with `t.schedule`; `t.nextSeat` reading `online` | `_join`, `_leave` and `_tick` internal actions, in order |
| `holdem` | `Date.now()` (the abandon arm), `buttons`, `onChat`, `t.tell`, `t.items` and `t.piles` clones, `t.schedule` | `Date.now` exists in Workers; everything else goes through the facade |
| `bridge` | the `host` flag in `t.players()`, a chat auction, a fixed rotation | `hostId` comes from `init` |
| `cah` | `window.CAH_CARDS`; `Math.random` in `shuf` (into `t.data`); three `t.newDeck` calls of about 1,600 cards; `t.card().meta.pick` | `globals`; `data` changes travel in the patch; the new decks go in `patch.decks` (about 150 KB, once) |
| `dealer` | `buttons`, `onButton`, `t.dealToAll` | — |

**Behaviour that differs, by design:**

1. **Hooks are atomic.** A template that threw mid-hook used to leave
   partial ops behind. None of the shipped ones relies on that.
2. **Script evaluation and `setup` are asynchronous** from the dialog's
   point of view.
3. **Live drags are no longer validated.** Only the drop is.
4. **A runaway loop no longer freezes the host's tab.** It disables the
   rules after 4 s.
5. **Rules log lines aggregate** (3e). CAH's `clearRound` removes four or
   more items in one action, so its run of "📜 Rules removed …" lines
   becomes one "📜 Rules removed N cards: …" line. `cah-bot.py` reads only
   the "answer with N card" and "judges — press" announcements, which do
   not aggregate, and `t-cah.js` asserts nothing about the removal lines
   (checked at `c0e2f28`). Any suite found to depend on them is updated to
   the aggregated text and listed in the Phase 3 PR.
6. **Saved user scripts that touch the page now fail.** A script that
   used `document`, `alert`, `localStorage` or `setTimeout` worked on the
   page; in the Worker it disables the rules with the explanatory message
   above. README and ENGINE.md carry a migration note: use `t.say` /
   `t.tell` instead of `alert`, `t.data` instead of `localStorage`, and
   `t.schedule` instead of `setTimeout`.

README's and ENGINE.md's "honest limits" are updated accordingly.

### 3g. UI and interaction

- **The snap preview.** While dragging a piece over a structured board,
  `.snap-ghost` outlines the snapped spot (computed client-side by
  `grid.js` from the public catalog and the board items), and a small chip
  near the pointer shows its address (for example "f3"). The drop sends the
  snapped `x, y` and an advisory `to`.
- **Stacking on a space.** Pieces that share an `at` are fanned at
  render time (the state keeps them all centred on the spot), in z order:
  - on a space with a `dir`, along that direction, by the piece's size
    (`h` for up and down, `w` for left and right), compressed to
    `min(size, (L − size) / (k − 1))` when `k` pieces would overflow the
    space's length `L` (its `h` or `w`): backgammon's 15 checkers on one
    point stay inside the triangle;
  - elsewhere, by 6 table units per member.
  - The top one carries a "×k" badge, distinct from a stack's `n`.
  - Hit-testing uses the rendered (fanned) positions.
  - A tap on a crowded spot selects the top piece. The member list is the
    stack inspector of Phase 4.
  - **[DECISION]** A space's `dir` is the fan direction. Without it, a
    snapped backgammon point would pile 15 checkers 6 units apart, which
    the Phase 2 demo would no longer survive.
- **Hints.**
  - Items get `.hint` (a dashed cyan outline).
  - Cells and spaces are drawn as translucent discs in a per-board
    `.hint-layer` SVG (separate from the cached structure SVG).
  - They are rendered only from this player's `hint`, and cleared when it
    becomes null (D156). A tap, or a drag's start, sends `select` (D154).
- **Asks.** A panel, `#ask`, works as a bottom sheet above the hand bar on
  phones, and as a centred card on desktop — both in a room of their own
  between the table and the hand bar, never over the table (D155). It is
  minimizable to a "❓ Rules ask" chip, and is **not** dismissible.

  | Ask form | What the player does |
  |---|---|
  | `options` | taps one of the option buttons (labels escaped; at least 44 px targets on touch) |
  | `pick:'item'` | taps one of the `among` items, which are highlighted while the ask is open; any other tap shows "Pick one of the highlighted pieces" |
  | `pick:'space'` | taps the board; the nearest offered address within reach answers |
  | `pick:'hand'` | hand cards become toggleable (selected outline); "Confirm (k/count)" enables at exactly `count` |
  | `pick:'number'` | uses a stepper from `min` to `max`, then OK |

  - With several asks pending, the first one shows, with "1 of N".
- **`t.secret`.** A card, `#secret` ("🔒 For you"), shows `sec.text` as
  `pre-wrap` text through `textContent`. It sits by the rules-button row,
  and is hidden when absent. In a short room it gives way first, down to
  its head; then the buttons scroll (D172, D174).
- **Rules dialog.** Enable is asynchronous ("Starting…"), and the error
  line shows the evaluation error. The 📜 button's title notes "strict"
  when `view.rules.strict`.
- **Live drags.** The client sends `drag` every 60 ms while dragging (one
  `drag {ids, dx, dy}` for a group, §4g), and `move` on drop. Others render
  `fx.live` positions (3c).
- **Drag starts stay checked client-side**, as since Phase 2 (§2g): a drag
  on an item the player may not handle pans the view.

**The demos** (rules templates in `templates.js`, plus `GAMES` entries with
`clear: true`, so that `pickGame` confirms, then sends `clear` and then
`setRules`; the 📜 dialog likewise for a text named as one of them that
would start afresh, D169, D173):

- **Chess** (`chess`, `strict: true`). As built: D160–D166; after review D167, D169, D171, D173, D175.
  - **Setup:** `setup` builds its box with `t.newBox`:
    - a board: 8 × 8 checker, `cell` 100, chess labels;
    - 12 piece types, glyph labels ♔…♟, round 88 × 88 tokens,
      `stack:'none'`.
    - It sets the table to a 1300 × 1300 rect (as built 1000 × 1360: D162), sets the seats to
      `white` (bottom) and `black` (top), and spawns the 32 pieces with
      seat-bound owners, guarded by `t.data.ready`.
  - **Moves:** `onSelect` hints the legal targets. `handle` enforces:
    - the turn and legality, including check;
    - captures (`t.remove`);
    - castling (moving the rook as well);
    - en passant;
    - promotion through `t.ask(p, {id:'promo', options: ['♕', '♖', '♗', '♘']})`
      and `onAnswer` (remove the pawn, spawn the chosen piece).
  - **End of game:** `endTurn` detects checkmate (`t.win`) and stalemate
    (an announced draw). It flips `t.public.turn` to the next seat's
    occupant.
  - **Draws** **[DECISION]**, all enforced automatically by `endTurn`, with
    an announcement and the game over:
    - **threefold repetition**: the same position (pieces, side to move,
      castling and en-passant rights) for the third time, tracked as a
      count per position key in `t.data`;
    - **the fifty-move rule**: 100 half-moves with no capture and no pawn
      move;
    - **insufficient material**: K v K, K+B v K, K+N v K, and K+B v K+B
      with both bishops on the same colour.
    - Automatic rather than claimable, because a casual table has no
      arbiter, and a claim button would be one more thing to explain.
  - **Buttons:** **Offer draw** (the opponent gets `t.ask` "Accept a
    draw?" with the options Accept / Decline; an offer lapses when the
    offerer moves — both players told, D175) and **Resign** (the other
    seat's occupant wins).
  - **Allowed by `strict`:** `rot` stays refused; `allow: ['peek']` is
    unnecessary (nothing is hidden).
- **Go**, generated as `goTemplate(9)` and `goTemplate(19)` (deterministic
  strings, so `currentGame()` still recognizes them).
  - **Setup:** a point grid with `draw:'lines'`, go labels, and
    `marks` = the star points. `cell` is 100 for 9 × 9 and 60 for 19 × 19.
    There are two supplies, bowls owned by `seat:black` and `seat:white`.
  - **Moves:** `handle` takes `take` actions with `a.to`. It checks the
    turn, that the point is empty, suicide and ko (positional, against the
    previous board's hash in `data`), then removes the captured groups.
  - **Buttons:** Pass, Resign, and Count after two passes. Count uses area
    scoring with komi 6.5, then `t.win`. There is no dead-stone marking:
    players capture dead stones first, and the README says so.
- **Reversi** (the 19th-century public-domain game; the demo never uses
  a trademarked name).
  - **Setup:** an 8 × 8 board, `draw:'cells'`, green. Discs are tokens with
    two faces (dark and light). Each seat has a supply with its own face.
  - **The starting position** **[DECISION]**: the four centre discs
    pre-placed crosswise (light on d4 and e5, dark on d5 and e4), with
    dark to move. The original rules let players place the first four
    discs freely; the fixed start is what most players expect today.
  - **Moves:** `handle` takes `take` actions: it checks legality, flips the
    bracketed discs with `t.setFace`, and passes automatically when a
    player has no move. At the end it counts, then `t.win`.

### 3h. Persistence

- **Migration v3 → v4** (`MIGRATE[3]`):
  - `rules.secret ||= {}` and `rules.asks ||= {}`;
  - delete `rules.hints`;
  - run the 3a gates over `data._timers` (a bad entry is dropped with
    `console.error`);
  - recompute each piece's `at` by containment only (no moves);
  - `v = 4`.
- **Saving.** `doSave` strips `rules.hints` from the clone it saves.
- **Loading a save** runs the same gates (`cleanAsk`, `_timers`,
  `secret`), so a hand-edited or corrupted save cannot plant engine
  state.
- **What persists:** `rules.asks` and `rules.secret`. A host reload in the
  middle of an ask re-sends it in the next snapshot.
- **The catalog** gains the boxes created by scripts (`t.newBox`), as
  catalog records with `src: 'script'`, deduplicated by content. Like
  decks, they never change during play.

### 3i. CLI bridge

**Snapshot additions:**

- `asks: [{id, prompt, options?: string[], pick?, among?, count?, min?, max?}]`;
- `hint: {items, spaces} | null`;
- `secret: JSON | null`;
- `at` on items (the display form);
- `strict: boolean`, a new **top-level** field. `rules` keeps today's
  shape, the running script's name or `null`: `cah-bot.py` tests
  `s.get('rules') != 'Cards Against Humanity'`, and changing the shape
  would silently stop the bot.

**Commands** (in both REPLs and in `cliExec`):

| Command | What it does |
|---|---|
| `place <ref> <addr>` | `ref` = an item id → `move`, with the `x, y` the tab computes from `addr` through `grid.js` (centred) and an advisory `to`. `ref` = a supply id or type name → `take` at that address. Fails loudly ("no such address") when the address isn't on any board. |
| `answer <id> <value>` | The tab converts `value` per the ask: `options` → an index, or a label (case-insensitive) → its index; `item` → an id; `space` → an address; `hand` → `"0,3"` (hand indices) → `[{idx, d, i} \| {idx, t, f}]`; `number` → an integer. |
| `select <id>` | Sends `select`; the hint arrives in the next snapshot. |
| `asks` | Prints the pending asks, for example "❓ promo: Promote to [0] ♕ [1] ♖ [2] ♗ [3] ♘" (the tab writes the text: D158). |

- **The REPL prints new asks automatically** when they arrive.
- **Bridge API** (both languages): `place(ref, addr)`,
  `answer(id, value)`, `select(id)`.
- **Bots** can play board games the way `cah-bot.py` plays CAH. A tiny
  example, `chess-bot.py`, is **not** required; `cah-bot.py` stays the
  example.

### 3j. Security

**Gates**

- **Scripts never run on the page.** `evalRules` is deleted from `app.js`.
  The Worker hardening is in 3f.7.
- **`answer`:** only the asked player, only a pending id, only an offered
  value. **`select`:** rate-limited, refused on pieces hidden from the
  player, and it causes no state change except through the script.
  **`drag`:** it carries no state; its coordinates go through `num()` and
  `clampToTable`, and each id passes the owner and lock checks before it
  is relayed.
- **Engine state.** `t.secret` keys and asks are gated at every commit
  (3a), so a script bug cannot plant a `__proto__` key or an oversized
  ask.
- **Internal action names never come from the wire.** `PUBLIC_ACTIONS`
  excludes `_*`.
- **Per-recipient parts are bound to `to`.** A peer that is not registered
  gets none of them.
- **Patches from the Worker.** Every field is checked again on the host,
  in its realm, and against who acted (3f.6 step 0, D145): a patch that
  fails is refused whole, and the rules end.

**Attacker cases** (in `t-p3-space.js`, `t-p3-chess.js` and
`t-p3-worker.js`):

1. Mallory answers another player's ask id; answers an unoffered option
   index, a non-`among` space, or the wrong number of hand cards: each
   refused, and no hook runs.
2. Mallory floods `select` (100 a second): at most 5 a second are
   processed, and the host stays responsive.
3. Mallory sends `{t: '_tick'}`, `{t: '_rulesOff'}` or `{t: '_join'}`:
   refused.
4. Mallory `drag`s a piece she doesn't own: nothing is relayed.
5. Mallory never receives another player's `ask`, `hint` or `sec`, in any
   body: a recursive scan for the prompt text, the hinted ids and the
   secret's text.
6. A script calls `fetch('https://example.com')`: it throws ("fetch is not
   defined"), and the rules disable loudly.
7. Mallory sends `drag` with `x: 1e308`, `NaN` and a string, and a group
   `drag` with 500 ids: the relayed fx (if any) carries clamped finite
   numbers, at most 200 ids, and only ids she may handle.
8. Mallory sends `select` on Alice's hidden piece: dropped; `onSelect`
   does not run (a test script that would hint it records no call).
9. A script assigns `t.secret['__proto__'] = {}` and `t.secret.bob = 'x'`:
   the hook fails, the rules disable, and no prototype is touched.

### 3k. Performance budgets

| # | Budget | How it is measured |
|---|---|---|
| B12 | Worker round trip for a `move` with `validate`, at 1,000 items: **≤ 3 ms median, ≤ 8 ms p95** | `__ct.perf.lastRulesRoundtripMs` (host, from post to `done` processed), on an otherwise idle host: each move paced past a frame. A `done` that lands behind a guest's move, its broadcast and sealing, or a burst, waits for the main thread (14–23 ms p95 in the 3B review's probe) while the Worker's share stays ≤ 0.5 ms (`done.ms`) |
| B13 | Go 19 × 19: placing stone #300 (with capture and ko checks) in `handle` takes **≤ 10 ms** of Worker time | `done.ms` |
| B14 | Watchdog: an infinite loop in `onAction` disables the rules within **4 s + 1 s**; during the hang, a host UI click (opening the log panel) is handled in **< 100 ms** | wall clock; a click timestamp against the DOM change |
| B15 | Worker init with 1,000 items and the CAH decks: **≤ 300 ms** to `ready` | host timing |
| B16 | A go capture of 30 stones writes **1** log line (and of any N: D167) | assertion |
| B17 | Snapshot size with 361 stones: **≤ 70 KB** | Node |

### 3l. Test plan (Phase 3)

**`core-p3.test.mjs`** (Node)

1. **`grid.js`**:
   - parse and format round trips, for every label system and the cell
     extremes;
   - cell centres equal the drawing formulas of 2a;
   - snapping inside and outside reach;
   - square `point` mode;
   - rotated boards at 90, 180 and 270°;
   - hex pointy and flat, 20 × 14: every cell's centre → pixel → axial
     round trip;
   - `neighbors` at corners, edges and the interior (4, 8 or 6);
   - `distance` (chebyshev, manhattan, hex);
   - `line` along ranks, files and diagonals, and an unaligned pair →
     `null`;
   - hex lines;
   - point-in-polygon at zone edges;
   - `linked`.
2. **The journal**: `begin`, `rollback`, `checkpoint`, `savepoint` /
   `rollbackTo` and `commit` for every mutation helper. `data`, `asks`,
   `secret` and hints are restored on rollback.
3. **The pipeline with a fake script**: every row of the 3f.4 atomicity
   table; `strict` with and without `allow`; `seat` under strict; `handle`
   before `validate`; `onAction` after handled actions (`a.handled`); `a`
   frozen; an `async validate` and a `handle` returning a Promise fail
   **closed**; a handled action that leaves the dragged item alone
   refresh-touches it; a vetoed action restores the hint it cleared.
4. **Ask validation**, for each form (accepted and refused), plain-string
   options, and `cleanAsk`, `_timers` and `secret` gates on load.
5. **Aggregation of Rules log lines.**
6. **`MIGRATE[3]`.**
7. **`T.digest()`** is equal across `applyStatePatch` after 300 random
   actions.
8. **Addresses:** with a primary chess board plus two racks and a second
   map, `e4` stays bare in the log and in `t.where`; the second map shows
   `map:c3`, two instances `tray#1:bar` / `tray#2:bar`; a bare address
   only one non-primary board has resolves to it; an ambiguous one throws
   `TypeError`; racks (zones only) never become primary.
9. **Board moves:** moving and rotating a structured board, deleting it,
   and a `table` resize leave every other item in place and recompute
   `at`, `byAt` and `byZone` by containment.
10. **`pull` under rules:** `handle` sees `a.to` and `a.pick` for a pull
    onto a board, and the default effect takes exactly `of[a.pick]`; a
    veto leaves the bag unchanged. `take`, `split` and `play` snap the
    prospective piece by its type's size.
11. **Chess logic** (in Node, against the template): threefold
    repetition, the fifty-move rule, and each insufficient-material case
    end the game as a draw; K+B v K+B on opposite colours does not.

**`t-p3-worker.js`**

1. Every shipped template, enabled from 🎲, plays a short scripted
   sequence:
   - Hold'em: a hand to the flop;
   - CAH: one round, which requires `window.CAH_CARDS` in the Worker;
   - Bridge: a deal;
   - turns and dealer.
2. The infinite loop of B14:
   - the log line, the toast and the error in the dialog;
   - the next action works on the free table;
   - re-enabling works.
3. `handle` throws after `t.move` → the piece has not moved; `onAction`
   throws after `t.flip` → the action's own effect is kept, the flip is
   discarded.
4. `setTimeout` in a hook → the stub's message is in `lastRulesError`.
5. `Promise.resolve().then(() => t.say('x'))` → the rules are disabled,
   "outside a hook". `Promise.resolve().then(() => { t.data.x = 1 })` →
   disabled with "changed t.data outside a hook" before the next job
   commits, and the host digest never diverges. An `async validate` that
   would veto → the action is refused (fail closed), not applied.
6. A syntax error on Enable → the dialog shows it, and the running rules
   still work.
7. A host reload with the rules enabled → the Worker re-inits, timers
   resume, and no `setup` re-run is logged.
8. `__ct.workerDigest()` equals the host digest after 300 actions.
9. **Page APIs:** a script using `document.title`, `alert('x')`,
   `localStorage.x` or `globalThis.setTimeout` → each disables the rules
   with the explanatory "rules now run in a Worker" (or `t.schedule`)
   message in `lastRulesError`.
10. **The watchdog on a backgrounded host:** a hook that takes 3 s, with
    the host page hidden (CDP `Page.setWebLifecycleState frozen`) for 6 s
    in the middle, then resumed → the rules stay enabled and the action
    applies. A genuine infinite loop with the page visible still stops in
    4 s + 1 s.
11. **Demotion:** a second tab of the host opens the same room and wins
    the rival-host tie-break → the first tab's Worker is terminated (a
    `CARDTABLE_TEST` counter), its queued jobs resolve with an error, and
    it writes no further saves.
12. **Module skew:** `rules-worker.js` routed to a copy with a different
    `MODULE_V` → Enable fails with the "reload" toast, and the table works
    without rules.

**`t-p3-space.js`**

1. Snapping on square cells, square points, hex pointy and flat, and
   spaces, observed from both points of view (`at` in the view, and the
   log text "a → b").
2. `onAction` sees `a.to` and `a.from` (the script echoes them with
   `t.say`).
3. `onSelect` → hint: the selecting player's DOM has `.hint`, the other's
   has none, and Mallory's bodies have none.
4. `t.ask`, for every form, through the UI (desktop and iPhone 13).
   Answer validation. A host reload mid-ask brings the prompt back.
5. `strict` refuses `del` and `flip`, allows the `allow` types and
   `seat`.
6. `t.secret` is shown to its player only.
7. A live drag does not change the host state until the drop. The drag of
   a locked piece is not relayed.
8. Several boards: the primary board's addresses stay bare when a rack
   and a second map are added; the second map's read `map:c3`; and
   `t.move(id, 'map:c3')` works.
9. A script whose `handle` returns `true` for a drop without moving the
   piece: on the dropping guest's screen, the piece is back at the
   script's position within one patch (not after 1.5 s).
10. Moving a board: the pieces on it stay put, and their `at` and the log
    addresses update by containment.
11. **Backgammon under snapping:** the whole `t-p2-demos.js` backgammon
    script is re-run with Phase 3; checkers snap to points and fan along
    `dir` inside the triangle (15 on one point stay inside it).
12. Attacker cases 1–9 of 3j.

**`t-p3-chess.js`**

- Opening moves by drag on both screens.
- Illegal moves are refused with a toast and snap back: off turn, a
  blocked path, a move into check, moving an opponent's piece.
- Castling on both sides moves the rook. Castling out of, or through,
  check is refused.
- En passant.
- Promotion through the ask, choosing ♘. A host reload while the
  promotion is pending resumes the prompt.
- Fool's mate → 🏆 and confetti.
- A stalemate position, reached through a scripted sequence → a draw
  announcement.
- A threefold repetition (knights out and back twice) → an automatic
  draw. Offer draw → the opponent's ask → Accept ends the game; Resign
  gives the other seat 🏆.
- A 3rd player joins as a watcher.
- A guest with `__ct.act({t:'del', id})` → "Not a move in this game".

**`t-p3-go.js`**

- **9 × 9:**
  - taking from the bowl onto a point;
  - single and group captures;
  - suicide refused;
  - ko refused, then allowed after a move elsewhere;
  - pass, pass, Count → the score and the winner.
- **19 × 19:** a scripted fill of 361 alternating legal placements (the
  test drives `__ct.act` as both players). Budgets B13 and B17 hold, and
  both screens agree.

**`t-p3-reversi.js`**

- The starting position: light on d4 and e5, dark on d5 and e4, dark to
  move.
- A legal placement flips the bracketed lines (both screens).
- An illegal placement is refused.
- A forced pass is announced.
- A full game from a near-end position (planted with a test script) ends
  with `t.win`.

**The bench**: B12 and B15 are added to `t-p1-bench.js`.

### 3m. Docs and module ownership

- **ENGINE.md.**
  - New sections: "Running in a Worker" (atomicity, the watchdog, no async
    code and the guards that enforce it, globals, state on `this` not
    being journaled); `handle`, `strict` and `allow`; `t.ask` and
    `onAnswer`; `onSelect` and `t.hint`; `t.secret`; components from code;
    spatial helpers and addresses (the primary board, display forms);
    the engine `data` key (`_timers`) and where asks live.
  - **A migration note** for saved scripts written for the page: no
    `document`, `alert`, `localStorage` or `setTimeout`; use `t.say` /
    `t.tell`, `t.data` and `t.schedule`.
  - Remove "No loop protection in v1". Update "What it deliberately does
    NOT do".
- **README.md.**
  - The rules section: the Worker, the watchdog, live drags not being
    validated, and the same migration note for saved scripts.
  - The demos: chess, go and reversi.
  - Honest limits: script trust, dynamic `import()`, and no dead-stone
    marking in go.
- **TABLETOP.md:** mark Phase 3 done.
- **Module ownership**
  - `core.js`: snapping, the primary board and display forms, `byAt` and
    `byZone` and their recompute on board moves, the journal (with
    savepoints), the pipeline (`handle`, `strict`, `allow`, `validate`,
    the default effect, `onAction`, checkpoints, handled-action refresh),
    internal actions, `cleanAsk` and the engine-state gates, the facade
    additions, aggregation, `applyStatePatch`, `digest`, `MIGRATE[3]`.
  - `grid.js`: snapping, neighbours, distance, line, point-in-polygon
    (the address grammar is already there from Phase 2).
  - `rules-worker.js` (new): init and the version check, evaluation,
    hardening and the page-API getters, `guard()` and `drain()`, the
    protocol, the error forwarding.
  - `app.js`:
    - the queue to the Worker and the visible-time watchdog, demotion
      teardown, `setRules` orchestration, `WORKER_GLOBALS`;
    - `drag` relay and live rendering, the snap preview;
    - the ask panel, hint layer and secret card;
    - per-recipient parts, the CLI additions.
  - `pieces.js`: the hint layer and the space fan-out.
  - `templates.js`: `chess`, `goTemplate(n)`, `reversi`, and their `GAMES`
    entries.

---

## 4. Phase 4: Game boxes

**Goal:**

- `game.json` plus images, or a `.zip`, uploaded in the browser;
- declarative setup and reset;
- export with the current position;
- multi-select and the stack inspector;
- a 📦 box picker next to 🎲 Games.

**Demo:** a generated hex-map strategy skeleton, "Hexfront": one map, 400
counters in ×N stacks, dice, a deck of cards and a turn script.

### 4a. Data model

**The `game.json` authoring format.** This is what `boxio.js` reads, and
README documents it. It is a superset of TABLETOP §4: every field of
TABLETOP's example means the same here, including `"at": "seat"` and a
piece given only a `w` (its `h` defaults to its `w`, §2a).

```jsonc
{
  "name": "My Game",                                   // required, ≤ 40
  "id": "ab12cd34",                                    // optional; written by export, reused on import when free
  "players": [2, 4],
  "table": { "shape": "rect", "w": 3200, "h": 2200, "felt": "#2c3e2f" },
  "seats": [ { "id": "white", "name": "White", "edge": "bottom", "color": "#f8fafc" } ],
  "lockable": "anyone",
  "backs": [ { "id": "unit", "img": "unit-back.png" } ],   // or "color"/"label"; w/h/shape/rotStep/hand/stack default from its first user
  "pieces": [
    { "id": "board", "kind": "board", "img": "map.jpg", "w": 2000, "h": 1400,    // "img" = one-face shorthand
      "primary": true,                                                           // optional (§3a)
      "grid": { "type": "hex", "hex": "pointy", "cols": 20, "rows": 14, "cell": 100, "x": 0, "y": 0 },
      "spaces": [ … ], "zones": [ … ], "links": [ … ] },         // board structure sits on the piece (TABLETOP §4)
    { "id": "inf", "kind": "token", "shape": "rect", "w": 60, "h": 60, "stack": "count", "back": "unit",
      "faces": [ { "img": "inf.png" }, { "img": "inf-reduced.png" } ], "meta": { "atk": 4 } },
    { "id": "d6", "kind": "die", "faces": [1, 2, 3, 4, 5, 6] },
    { "id": "gold", "kind": "token", "shape": "disc", "w": 40, "faces": [ { "color": "#eab308", "label": "1" } ] }
  ],
  "decks": [ { "name": "Events", "id": "cd34ef56", "back": "event-back.png", "cards": [ /* deck.json entries */ ] } ],
  "setup": [ /* SetupEntry, see below */ ],
  "rules": "rules.js",                                 // a file name in the upload or zip, or inline code
  "rulesState": { "data": {}, "public": {}, "asks": {}, "secret": {} },   // written only by export (see 4g)
  "meta": { }                                          // ≤ 8 KB of JSON, for scripts (t.box); PUBLIC
}
```

**The stored `Box`** (the changes from Phase 2):

```ts
Box = { ...P2,
  decks?: { [deckName]: deckId },   // the box's decks, registered as ordinary decks (cleanDeck) on import
  rules?: string,                   // ≤ 200,000 chars
  rulesState?: { data, public, asks, secret },   // pids appear as "@#k" placeholders (below)
  meta?: JSON,                      // ≤ 8 KB
}
// the catalog record keeps src: 'host' | 'upload' | 'script' and by?: pid beside the box (§2a);
// "built in" is derived by content (isBuiltin, §2j), never stored
```

**Host state, v5:** `rules.box?: boxId` (the box whose rules are running,
set by `setup {rules: true}`). `lastSetup` (§2a) now also follows `setup`
and `reset`.

**The full setup grammar** (Phase 4 extends the Phase 2 subset):

```ts
SetupEntry =
  | P2 entries (piece, supply, bag, forEachSeat, group)
        // owner?: 'seat' | `seat:${id}` | '#k'   (NEW: an explicit seat, or the k-th seated player)
        // id?: itemId                            (NEW: only on an entry that places exactly one item)
  | { deck: deckName, at: Where, shuffle?: boolean, up?: boolean, name?: string,
      rot?: number, owner?, lock?: boolean, id? }                                    // a pile of the whole deck
  | { pile: ({ deck: deckName, i: int, up?: boolean } | { piece: typeId, f?: int, up?: boolean })[],
      at: Where, name?: string, rot?: number, owner?, lock?: boolean, id? }
  | { card: { deck: deckName, i: int }, at: Where, up?: boolean, rot?: number, owner?, lock?: boolean, id? }
  | { hands: { [seatRef: string]: ({ deck: deckName, i: int } | { piece: typeId, f?: int, up?: boolean })[] } }
        // seatRef = a named seat id, or "#k" = the k-th seated player in clockwise seat order
Where = 'center' | [x, y] | 'seat' | { seat: [dx, dy] } | address | { board: typeId, at: address }
        // address forms from §3a, resolved against the FIRST board item of that type placed by this setup
```

- **`#k`** counts seated players clockwise from the bottom of the table
  (`(seat − 90 + 360) % 360`), from 1. A setup that names a `#k` beyond
  the number of seated players fails loudly before any op ("this game
  needs 3 seated players").
- **Exports use `id`, `#k` and `@#k`** so that a game resumes (4c, "Ids
  and players on import").

### 4b. Wire protocol (PROTO 5)

- **`boxes` channel.** It carries `PublicBox` = `Box` without `setup`,
  `rules` or `rulesState`, plus the display fields of 2b. Guests read the
  running rules through the `rules` channel, as today.
- **New actions:** `addBox`, `setup`, `reset` and `group` (4c). The live
  `drag` gains its group form in Phase 3 already (§3c). There is no new
  host→guest message.

### 4c. Actions

| Action | Payload and validation | Semantics | Log | Flood | Ruled |
|---|---|---|---|---|---|
| `addBox` | `{box: TransportBox}`, where `TransportBox` = the parsed `game.json` with every `img` already replaced by an index into `imgs: dataURL[]`, `rules` inlined, and deck images inlined as in `addDeck`. From anyone. **Synchronously, on receipt:** `cost = JSON.stringify(box).length` must fit the guest budget (guests: `guestDeckChars + cost ≤ 1.5e6`, shared with decks; over it, "🚫 Box rejected: this table's budget for guests is full (N kB left) — ask the host to add it"), and every box must fit `MAX_BOX_CHARS` (64 M chars). Then the preprocessing stage (§1c, outside the FIFO) ingests the images (the Phase 1 checks, `imageDims` included) and the decks; the sum of image bytes must be ≤ `MAX_BOX_BYTES` (48 MB). `cleanBox` failure: "🚫 Box rejected: {message}". | **Deduplicated** by content (`boxKey`): an identical box already in the catalog is not registered twice, and the actor gets "That box is already on this table". Otherwise it registers the box (record `src: 'upload'` from a guest or `'host'`, `by: p`) and its decks, reusing the box's and the decks' exported `id`s when they are free. **Nothing is laid out.** The budget is checked again at commit. | "added the box «{name}» ({N} piece types)" | 1 | yes (like `addDeck`) |
| `setup` | `{box: boxId, clear?: boolean = true, rules?: boolean, shuffle?: boolean}`. **Host only.** `rules: true` requires `box.rules`. `shuffle` defaults to **true** for a box added by a guest, false otherwise. | Everything is validated before the first op (deck and type names, `#k` seat refs, the item total). Then: `clear` (if set) → `table` → seats → lay out `box.setup` (the full grammar), reusing exported item ids (below); with `shuffle`, every face-down `deck` and `pile` entry is shuffled → `lastSetup = box` → if `rules`, enqueue `setRules {enabled: true, code: box.rules, reset: true, state?: box.rulesState}`, and that job sets `rules.box = box`. | "set up «{name}» ({N} items)" (+ ", face-down piles shuffled") | — | no |
| `reset` | `{}` (or `{box}` for compatibility, which must equal `lastSetup`). **Host only.** Requires `lastSetup`. | The same as `setup` of `lastSetup` with `clear: true`, `shuffle` as that box's default, and `rules: true` when `rules.enabled && rules.box === lastSetup`. Works after a host reload, because both fields are persisted. | "reset «{name}»" | — | no |
| `group` | `{op: 'move' \| 'rot' \| 'flip' \| 'roll' \| 'lock' \| 'del' \| 'toBag' \| 'hide', ids: id[1..200] (unique), dx?, dy?, rot?, on?, bag?}`. Each member must exist. `hide` arrives in Phase 5. | Expanded in core into one sub-action per member: `{t: op, id, x: it.x + dx, y: it.y + dy, rot: it.rot + rot, on, bag, group: N}`; `rot` is a **delta** applied to each member, then snapped to that member's `rotStep`. `roll` is one sub-action `roll {ids}` for the dice among the members. Each member runs the full checks (owner, lock, the hidden-item rule) **and** the ruled pipeline (`handle` / `validate`) inside **one** atomic job, under a `savepoint()`: a veto or a refusal calls `rollbackTo` for **that member only**, which is then skipped; the rest apply. A `handle` or `validate` **throw** fails the whole job closed (3f.4), as for a single action. One aggregated notice goes to the actor: "{k} of {N} were skipped: {first reason}". Pieces snap individually (`place()`). | one summary line: "moved 8 items", "rolled 4 dice: 3 · 5 · 1 · 6", "removed 5 items" (the per-member lines are suppressed). Labels follow `itemLabel`, so a hidden die's value never appears (Phase 5: "rolled 4 dice (2 hidden): 3 · 5"). | 1 + ⌊N / 20⌋ | yes (per member) |

- **`setRules`** gains `state?: {data, public, asks, secret}`. It is
  **host only**. With `reset: true`, it seeds the rules state from
  `state`, after the gates of §3a (`cleanAsk`, `_timers`, `secret`
  keys), so an exported game resumes mid-play. A failing gate drops that
  entry with `console.error` and one toast ("Some saved game state was
  invalid and was dropped").
- **[DECISION] The `group` flood cost is 1 + ⌊N/20⌋.** One gesture is one
  action, but a 200-item group does the work of many; 20 members per
  token keeps a flood of group deletes as costly as a flood of single
  ones, while a normal selection stays at 1–2 tokens.
- **The watchdog** budget for a `group` is `4000 + 10 ms × N`, and for a
  setup or reset `4000 + 10 ms × items` (3f.5).

**Ids and players on import.** **[DECISION]** An exported game must
resume, and scripts store ids: chess keeps its box id in `t.data.box`, and
CAH and Hold'em keep pile ids. So:

- **Item, box and deck ids are preserved when free.** Export writes each
  item's `id` (and the box's and decks' ids). A setup (clearing or not)
  uses an entry's `id` when no item holds it; registration does the same
  for box and deck ids. An id that is taken is re-minted, recorded in a
  remap table, and reported once: `console.warn` and a toast "N ids had to
  change; a running script that stored them may misbehave".
- **Remapped ids are substituted** in `rulesState` (`data`, `public`,
  `asks`, `secret`): every object key or string value exactly equal to an
  old id becomes the new one. Ids are random 8-hex strings, so an
  accidental match is negligible.
- **Players travel as `@#k`.** Export replaces every key or string value
  in `rulesState` that equals the pid of a seated player with `"@#k"` (k
  as in 4a), and writes pid owners as `owner: '#k'` (Phase 5: `vis` too).
  Import maps `@#k` back to the pid of the k-th seated player in the new
  room. Pids of players who are not seated cannot be mapped: engine-keyed
  entries for them (asks, `secret`) are dropped, other occurrences are
  left unchanged, and the host gets one toast "Some saved state referred
  to players who weren't seated; it was dropped".
- **Tests:** export chess and Hold'em mid-game, import into a fresh room
  with two new players, set up, and keep playing legal moves (4l).

**Trust and the uploader.**

- **[DECISION] A guest's box only registers.**
  - A box's setup replaces the table, which is the host's call, as is
    choosing the game.
  - Guests can still contribute a box. The host then sets it up from 📦.
- **[DECISION] A box's rules never run without the host's explicit
  click.** The trust dialog is in 4g.
  - A script sees every hand and hidden piece, and can reveal them in game.
  - That applies to uploads by the host too, since a box may come from
    anywhere.
  - The only exception: boxes for which `isBuiltin` holds (content equal
    to a `BOXES` entry, §2j) skip the warning. No field a peer can send,
    and no migration, can make a box built in.
- **[DECISION] A guest's box shuffles its face-down piles by default.**
  The guest who wrote or uploaded a box knows the order of its
  unshuffled face-down `deck` and `pile` entries, and which `hands` go to
  which seat. Set up therefore shuffles face-down `deck` and `pile`
  entries of a guest's box unless the host unticks "Shuffle face-down
  piles", and the confirm names the uploader (4g).

### 4d. Public view and hidden information

- The item views are unchanged.
- **`PublicBox` strips `setup`, `rules` and `rulesState`.** An exported
  position's setup contains:
  - the order of bag contents;
  - the identities of face-down pieces and cards;
  - the hands;
  - the script's hidden `data`.
- **Export is host only.** **[DECISION]** It serializes hidden
  information. A guest-side "export what I can see" is not part of
  phases 1–5.

### 4e. Facade (`t`) additions

| Call | Returns | Notes | Log |
|---|---|---|---|
| `t.boxes()` | `[{id, name, src, builtin, types: n}]` | `builtin` is `isBuiltin` (§2j) | — |
| `t.box(id)` | a copy of `PublicBox`, plus `decks`, or `null` | for `meta` and the type lists | — |
| `t.layout(boxId, entries?)` | the number of items placed | Lays out `entries`, or the box's `setup`, as the 📜 Rules actor. The same interpreter as `setup`; nothing is cleared. A script's "Reset" button calls `t.layout` after `t.remove`. | aggregated "placed N pieces" |

### 4f. Worker

There is no change to the protocol.

- `setup` and `reset` are queued to the Worker when the rules are enabled,
  like every mutation (3f.1), with the scaled watchdog budget (3f.5).
- A `group` runs as one job in the Worker, with a savepoint per member
  (3f.4).
- The `setRules` that a `setup` with `rules: true` enqueues follows 3f.8.
  It runs **after** the setup job commits.

### 4g. UI and interaction

**The 📦 box picker.** A toolbar button next to 🎲, visible to everyone,
opens a dialog `#box-dialog` with three sections:

1. **On this table:** every box in the catalog. Each entry shows its name,
   the number of piece types, "by {name}", and a 📜 badge when it has
   rules.
   - Host: **Set up**, with a confirm when the table has items: "Set up
     «X»? This clears the table." It also offers a checkbox "Enable its
     rules", ticked by default (see the trust dialog below), and, for a
     box a guest added, a checkbox "Shuffle face-down piles", ticked by
     default, under the line "{Bob} added this box and knows its starting
     layout."
   - Host: **Reset**, when this box is `lastSetup` (also after a reload).
   - Guests: a read-only view.
2. **Built-in:** `BOXES` (draughts, backgammon, Hexfront, and in Phase 5
   dominoes and Veiled Ranks). Host: **Set up**.
3. **Upload a game…** opens a file input (`accept=".json,.zip,image/*,.js"`,
   multiple). It is available to anyone, and guests are subject to the
   budget.
   - It shows progress ("Reading map.jpg (3/41)…").
   - A failure ends in a toast plus an inline error in the dialog naming
     the field or file.
   - The host gets a checkbox "Set up now" (on by default).

The host also gets **Export…**:

- options: "Include the rules" and "Include the game state (scores,
  hidden script data)";
- it produces `<name>.zip` when any image is involved, else
  `<name>.json`;
- the download goes through an object URL and `<a download>`. A failure
  ends in a toast and `console.error`.

**The trust dialog.** It appears on Set up with "Enable its rules" ticked,
for every box where `isBuiltin` is false, whatever its record says: "«X»
comes with rules written by its author{, added by Bob}. A rules script
sees every hand and hidden piece and can reveal them. Enable the rules?"
The buttons are **Enable rules**, **Set up without rules** and
**Cancel**.

**The "+ Deck" dialog** gains a line: "A whole game (board, pieces, decks)?
Use 📦".

**Multi-select**

| | Desktop | Touch |
|---|---|---|
| start a rubber band | Shift+drag on empty felt (a plain drag still pans) | the floating ⬚ toggle (bottom-left of the table) turns on select mode; a one-finger drag on the felt draws a band |
| add or remove one item | Shift+click | in select mode, a tap toggles it |
| clear the selection | Esc, or a click on empty felt | ⬚ off, or ✕ |

- **Selection rules.**
  - Members are only items the player may handle (owner and lock, resolved
    from the public view).
  - Others are skipped, with a hint chip: "3 not selectable (locked or
    someone else's)".
  - Boards are never rubber-band selected. A locked board counts as
    felt: a Shift+drag that starts on it draws a band, and a plain drag on
    it pans (§2g).
- **Dragging a member moves the whole group.**
  - Members get `.selected`.
  - The group follows the pointer by its offset.
  - The drop sends one `group {op: 'move', ids, dx, dy}`.
  - Live positions are relayed as **one** `drag {ids, dx, dy}` every
    60 ms (§3c): one flood token per send, whatever the group's size, so
    the dragger is never throttled and the drop is never refused.
- **The group bar** (in place of the action bar): ⟲ ⟳ (by the largest
  `rotStep` among the members, else 90), Flip, 🎲 Roll (all dice), 🔒 / 🔓,
  👜 Into bag ▸ (bags on the table), 🗑, ✕. Each sends one `group`.
- **Keyboard:** R, F, Space and Delete apply to the group.

**The stack inspector** (`#inspector`, a screen-space popover anchored at
the stack):

- It opens:
  - on a tap of a ×N badge;
  - on a long-press of a ×N stack (touch; it replaces the zoom for
    stacks);
  - on a tap of the "×k" fan badge of a crowded space (3g);
  - from "⋯ Inspect" in the action bar.
- **For a ×N stack:** the count, a stepper "Take [k]" (1 … N−1), **Take**
  (`split {n: k}` next to the stack, snapped), and **Take all** (arms a
  whole-stack drag). Hidden stacks show the back.
- **For a crowded space:** a list of the members (a face thumbnail, or the
  back if hidden, its label, the owner dot).
  - A tap selects that piece and shows its action bar.
  - A drag out of the list starts a drag of that piece.
- It closes on Esc, on an outside tap, or when the stack changes under it.
  When the stack changes, it re-renders if the stack still exists.

### 4h. Persistence

- **The catalog** stores the full `Box`, with `setup`, `rules` and
  `rulesState`, plus its decks as ordinary catalog decks.
- **Box images** are assets, so the GC's reference set includes the `imgs`
  of every box.
- **Migration v4 → v5** (`MIGRATE[4]`): `v = 5`. `rules.box` stays absent
  (a Reset after the upgrade sets the box up without re-enabling rules),
  and `lastSetup` is kept. It rewrites no catalog record: every box record
  already carries `src` since Phase 2, and "built in" is derived by
  content, never by name. Duplicate boxes left by older versions stay
  (items refer to them); new registrations deduplicate.
- **The size of an import** is bounded by the zip limits (4j), and its
  storage cost by the quota handling of 1h. A failed asset store shows a
  toast ("Couldn't store the box's images: storage is full"), and the box
  is not registered: **all or nothing**.

### 4i. CLI bridge

- **Snapshot:** `boxes: [{id, name, types, rules: boolean, src, builtin}]`,
  and `lastSetup`.
- **Commands:**

  | Command | Sends |
  |---|---|
  | `boxes` | prints the snapshot's box list |
  | `group <op> <id,id,…> [dx dy \| deg]` | `group` |
  | `setup <boxId> [--keep] [--rules]` | host only; `--keep` = no clear |
  | `reset` | host only; resets `lastSetup` |

- **[DECISION] No box upload from the CLI in phases 1–5.** The images would
  have to be read and downscaled by the tab anyway, so the browser dialog
  is the upload path.
- **Bridge API** (both languages): `group(op, ids, **kw)`.

### 4j. Security

**Import limits** (`boxio.js`, before anything is decoded):

- **JSZip** is loaded lazily from
  `https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm` (3.10.1 has no native
  ES-module build; jsdelivr's `+esm` wraps it). A test pins that this
  build exposes `file._data.uncompressedSize` and `internalStream`.
- **The zip.**
  - The zip file itself is ≤ `ZIP_MAX_BYTES` (64 MB), checked on
    `file.size` **before** `loadAsync`.
  - `loadAsync` only reads the central directory; nothing is inflated
    yet. The entries are counted (≤ 2,100).
  - The declared sizes (`file._data.uncompressedSize`) are a fast
    pre-check: their sum must be ≤ 64 MB, and each ≤ 16 MB. They can lie,
    so they are **not** the defence.
  - **The defence is a streamed inflate.** Each entry is read with
    `file.internalStream('uint8array')`, counting bytes as chunks arrive,
    and aborted (`pause()`, then reject) as soon as it passes
    `min(declared size, 16 MB)` for that entry, or 64 MB in total for the
    whole import. JSZip's `async()` would inflate the whole entry before
    its own size check, so it is never used on an untrusted entry.
  - `game.json` ≤ 2 MB; `rules.js` ≤ 200 KB (both enforced by the same
    streamed limit).
  - **[DECISION]** The previous "refuse by the declared size" relied on a
    field that a crafted central directory can understate. A streamed
    limit bounds memory whatever the directory says.
- **Paths.** Leading `./` is normalized. Entries whose path contains `..`
  or starts with `/`, or that sit inside `__MACOSX/`, are rejected. Paths
  are only ever used as lookup keys.
- **`game.json`** is found at the root, or inside exactly one top-level
  folder.
- **Images.** Every file first passes `imageDims` (§1a: ≤ 4,096 px per
  side, ≤ 16 Mpx) on its header, before it is decoded. It is then
  re-encoded through `createImageBitmap` and a canvas (`encodeImage`):
  - at most 2048 px on the long side for board kinds, 560 px for anything
    else;
  - as WebP 0.8 when `canvas.toDataURL('image/webp')` really returns WebP
    (Safari may silently return PNG); otherwise as JPEG 0.85 for an opaque
    image, or PNG for one with transparency;
  - if the result exceeds `ASSET_MAX_BYTES` (2 MB), the quality steps down
    (0.8 → 0.7 → 0.6) and then the size (× 0.85 per step), until it fits;
    a board that still cannot fit at 1,024 px is an error naming the file;
  - the asset records the **actual** MIME of the result, read from its
    magic bytes;
  - so no SVG or other active content survives;
  - a file that fails to decode is an error naming it.
  - The sum of a box's image bytes is ≤ `MAX_BOX_BYTES` (48 MB).
  - The same `encodeImage` is used for deck images (it replaces
    `fileToDataURL`), so decks get the Safari fallback too.

**`cleanBox`** applies to the whole result, with every cap of 2j, and:

- `decks` through `cleanDeck`, each;
- `rules` ≤ 200,000 chars;
- `rulesState` ≤ 4e6 chars of JSON, through the gates of §3a: `asks`
  through `cleanAsk`, `data._timers` validated, `secret` keys matching
  `PID_RE` or the `@#k` placeholder, each value ≤ 8,000 chars;
- `meta` ≤ 8 KB.
- `src`, `by` and every other host-only field are dropped (§2j).

**Other gates**

- **The budget.** Guests share the 1.5 M-char budget with decks, saved with
  the table. Host uploads have no budget, but every cap still applies.
- **Host only:** `setup`, `reset`, `setRules.state` and export.
- **`group`:** ≤ 200 unique ids, a flood cost of 1 + ⌊N/20⌋, and the full
  per-member checks.
- **Trust.** Box rules never run without the trust dialog (4g). Guests
  never receive `rules`, `rulesState` or `setup` (`PublicBox`).

**Attacker cases** (`t-p4-boxes.js`):

1. A zip bomb (a small file that inflates to 100 MB): refused before it is
   inflated.
2. A zip with `../../evil.png` and `/abs.png`: refused.
3. An "image" that is an SVG or HTML with a `.png` name: decoding fails,
   and the upload is rejected loudly.
4. A `game.json` that references a missing file: the error names it.
5. Mallory sends `addBox` with a 2 M-char box: refused by the budget. With
   `__proto__` type ids: refused by `cleanBox`.
6. Mallory sends `setup` or `reset`: refused (host only).
7. Mallory's received bodies never contain the `setup` or `rulesState` of
   an exported, re-imported game: a recursive scan for the planted hidden
   identities.
8. Mallory sends `group` with 500 ids, duplicates, or another player's
   pieces: capped, deduplicated, skipped.
9. A zip whose central directory **understates** an entry's size (a
   declared 1 KB entry that inflates to 100 MB): the streamed inflate
   aborts at 1 KB, nothing larger is allocated, and the upload fails
   loudly naming the entry.
10. A forged built-in: Mallory's `addBox` carries `src: 'builtin'`, `by`
    set to the host, and the name "Draughts" with one changed piece: the
    stored record says `src: 'upload'`, `isBuiltin` is false, and Set up
    with rules shows the trust dialog.
11. Forged engine state: a box whose `rulesState` carries an ask with 500
    options, a `data._timers` entry with `at: "x"`, and a `secret` keyed
    `__proto__`: each is dropped with `console.error` on Set up, and the
    toast is shown.
12. A 30,000 × 30,000 PNG inside the zip: refused by `imageDims` before
    decoding.

### 4k. Performance budgets

| # | Budget | How it is measured |
|---|---|---|
| B18 | Hexfront snapshot ≤ 120 KB; guest render ≤ 600 ms on desktop, ≤ 2 s on emulated iPhone 13 with 2× throttle | Node; `__ct.perf.lastSnapRenderMs` |
| B19 | `group` move of 200 items: host apply ≤ 15 ms; the patch ≤ 30 KB per peer | Node, plus the browser byte counter |
| B20 | Importing a 64-image zip (≈ 20 MB) on desktop: ≤ 10 s, with progress shown | wall clock in `t-p4-boxes.js` |
| B21 | Export of Hexfront (with images) ≤ 5 s | wall clock |

### 4l. Test plan (Phase 4)

**`core-p4.test.mjs`** (Node)

1. `cleanBox` over the `game.json` authoring format:
   - the board structure on the piece;
   - the `img` shorthand;
   - `backs` defaults;
   - decks;
   - `rules` and `rulesState` caps and gates (`cleanAsk`, `_timers`,
     `secret` keys);
   - `h` defaulting to `w`, and `"at": "seat"`;
   - `src` and `by` dropped.
2. The setup interpreter, for every entry kind:
   - `forEachSeat` with named and automatic seats;
   - `#k` seat refs and `owner: '#k'`, and a `#k` beyond the seated
     players failing before any op;
   - addresses with `{board, at}`;
   - item totals and the 3,000-item cap;
   - a missing deck or type fails *before* any op;
   - `id` reuse when free, re-minting with a remap table when taken;
   - `shuffle` of face-down `deck` and `pile` entries.
3. `group` expansion: per-member checks, rules veto per member rolling
   back only that member (`savepoint` / `rollbackTo`), a `validate` throw
   failing the whole job closed, `rot` as a per-member delta, the
   aggregated notice, the one log line.
4. Export to import round trip, in core: lay out a state, export it to a
   box, clear, set the box up → the private state is equal, **ids
   included** in a fresh table (positions within 0.5, faces, counts,
   owners by seat and `#k`, pile orders, bag contents as multisets, hands
   by seat, `rulesState` with `@#k` mapped to the new pids).
5. Deduplication: `addBox` and `t.newBox` of an identical box return the
   existing id; a one-field change registers a new box.
6. `MIGRATE[4]`, and Reset after a save/load round trip (`lastSetup`,
   `rules.box`).

**`t-p4-boxes.js`**

1. Upload `game.json` plus 6 PNGs (fixtures generated by the test with a
   canvas, committed under `tests/fixtures/`):
   - pieces render on both screens;
   - the guest fetches the assets (1b.5).
2. Upload the same game as a `.zip`.
3. Every malformed input fails loudly (4j attacker cases 1–5), with the
   inline error text.
4. A guest upload registers only, and the host sets it up.
5. The trust dialog appears for an uploaded box with rules; "Set up
   without rules" leaves the rules off. Attacker cases 9–12 of 4j.
6. Reset restores the setup, also after a host reload, and re-enables the
   box's rules when they were running.
7. Export → clear → upload the exported zip → set up: the public views
   match (both screens) and the host-state digest matches.
8. **Resume elsewhere:** chess (with its box id in `t.data.box`) and
   Hold'em (with pile ids and pid-keyed bets) are exported mid-game with
   the game state, imported into a **fresh room** with two new players,
   set up with rules, and play continues with legal moves (a chess move
   by the side to move; a Hold'em call), with no script error.
9. The guest budget is shared with decks. A guest's box sets up with its
   face-down piles shuffled, and the confirm names the guest.
10. JSZip is loaded lazily from the CDN (routed to a local copy in tests:
    `cdn/_jszip_3.10.1__esm.js`, the `+esm` build).
11. An oversized board image (a 4,000 × 3,000 photographic PNG fixture)
    is stepped down until it fits 2 MB, renders, and records its real
    MIME. With `toDataURL('image/webp')` stubbed to return PNG (Safari),
    an opaque image is stored as JPEG.
12. Loading the same built-in box twice from 📦 leaves one catalog
    entry.

**`t-p4-select.js`** (desktop and iPhone 13)

1. Rubber band, Shift+click, and ⬚ select mode.
2. A group drag of 200 members moves every member on both screens; the
   dragger sends at most 17 `drag` messages a second, receives no flood
   notice, and the drop's `group` is applied.
3. Group rotate, flip, roll, lock, delete and into-bag.
4. Locked and owned items are skipped, with the notice.
5. A rules script vetoes one member mid-group: only that member stays
   put, the others apply, and the notice names one skip.
6. The stack inspector:
   - Take k;
   - Take all;
   - a crowded space's member list (select, and drag out);
   - a hidden stack shows the back.

**`t-p4-hexfront.js`**

1. Set up Hexfront from 📦.
2. 400 counters in 40 stacks.
3. The turn script: only the active seat moves its own units, and the
   phase buttons work.
4. Split and join stacks.
5. Dice rolled in combat.
6. An event card drawn into a hand.
7. B18 and B19.

### 4m. Docs and module ownership

- **README.md:** a "Game boxes" section (the `game.json` format, zips and
  their limits, setup, reset, export and resuming elsewhere, trust and the
  uploader's knowledge of the layout), multi-select, the stack inspector,
  📦, and Hexfront. Box `meta` is public.
- **TABLETOP.md:** mark Phase 4 done.
- **index.html:** help for the selection gestures and 📦.
- **ENGINE.md:** `t.boxes`, `t.box` and `t.layout`; box rules and trust.
- **Module ownership**
  - `boxio.js` (new):
    - parsing `game.json`;
    - resolving files and zips, with the limits;
    - `encodeImage` (replacing `fileToDataURL`; moving `nameFromFile` and
      `manifestDeck` here from `app.js`, since decks and boxes share
      them), with the MIME fallback and the step-down;
    - the streamed zip inflate with its limits;
    - building the `TransportBox`;
    - export, with JSZip `generateAsync`, writing `id`, `#k` and `@#k`.
  - `core.js`: the full setup interpreter (ids, `#k`, shuffle), the
    `group` expansion with savepoints, `addBox`, `setup` and `reset`
    (`lastSetup`, `rules.box`), the id remap and `@#k` mapping,
    `PublicBox`, the facade additions, `MIGRATE[4]`.
  - `app.js`: 📦, upload and progress, the trust dialog, multi-select, the
    group bar, the inspector, export download.
  - `templates.js`: `BOXES.hexfront` (a generator with a fixed seed, so
    the box is deterministic) and its turn script.

---

## 5. Phase 5: Private material

**Goal:**

- `vis`: pieces visible to their owner, dice under a cup;
- private areas beyond the hand: a tile rack or a screen, built as private
  zones on small boards;
- peeking at any hidden piece.

**Demos:**

- **dominoes**, with racks;
- **Veiled Ranks**, an original hidden-units skeleton: ranks behind
  screens, revealed in combat.

### 5a. Data model and state changes

**Host state, v6:**

```ts
Piece = { ...v4,
  vis?: VisRef[],        // ≤ 8. Who sees its face while up === false. undefined = nobody.
  pv?: 1,                // hidden BY a private zone (cleared on leaving, see below)
  po?: 1,                // owner SET by the engine on hiding (a private zone, or `hide`); the owner goes with it on reveal
}
VisRef = pid | 'seat:<seatId>'          // seat refs follow the seat's occupant, like owners
Zone   = { ...P2, owner?: 'board' | 'seat:<id>', private?: 'reveal' | 'keep' }
```

- **The visibility rule.** A piece is **hidden from viewer `V`** iff
  `up === false && !resolveVis(vis).includes(V)`. A piece that is face up
  is public, whatever its `vis`. This is the `hiddenFrom(p, it)` of §2c,
  so the uniform refusals and the back's flags apply to `vis` pieces for
  everyone outside `vis`.
- **`vis` applies to pieces only**, and only to types with a `back`.
  Supplies, bags, piles and cards gain nothing. Hands are already private.
- **A new index**, `byVis: Map<VisRef, Set<id>>`. When a seat's occupant
  changes, every item in `byVis.get('seat:<id>')` is touched, so viewers
  get the right per-recipient form.

**Private zones**

- A zone is active when its board is on the table and its owner resolves:
  - `owner: 'board'` → the board item's `owner`;
  - `owner: 'seat:<id>'` → that seat.

  A zone with no resolvable owner does nothing.
- **Entering an active private zone.** This happens when a piece's centre
  is **placed** in it, i.e. inside `place()` (§0.2, the callers listed in
  §3a), and never because a board moved (§3a).
  - **The type has a back:** set `up: false` and `vis: [zoneOwnerRef]`,
    then `pv: 1`. If the piece was unowned, also set
    `owner = zoneOwnerRef` and `po: 1`.
  - **The type has no back:** a human action is refused ("🚫 That piece has
    no hidden side"); a script op throws `TypeError`.
- **Leaving** a private zone, for a piece with `pv` that lands outside any
  active private zone of the same owner:
  - **`private: 'reveal'`** (a rack): `up: true`; `vis`, `pv` are deleted;
    if `po`, the `owner` and `po` are deleted too.
  - **`private: 'keep'`** (a screen): `pv` is deleted. The piece stays
    hidden from others, with its `vis` and `owner`. It is revealed later by
    a flip or by the script.
- **Moving between private zones of the same owner** changes nothing.
- **Entering another owner's private zone** re-applies the entering rule
  for the new owner.

**[DECISION] Private areas are zones on small boards.** There is no new
area concept.

- A rack is a board piece with one `private:'reveal'` zone covering it. A
  screen is a `private:'keep'` zone.
- `forEachSeat` places one per seat, owned through `owner: 'seat'`.
- `reveal` and `keep` cover the two physical behaviours:
  - a tile taken off a rack is played face up;
  - a unit moved out from behind a screen stays hidden.

### 5b. Wire protocol (PROTO 6)

**Per-recipient overrides.** Snapshots and patches gain
`vis?: { [id]: PublicItemFull }` beside `hand`.

- **In a patch**, for every id in the shared `items` whose piece is hidden
  (`up: false`) and whose resolved `vis` includes this recipient, the
  recipient's override holds the full form:

  ```ts
  { k:'g', t, f, x, y, rot, z, n?, owner?, lock?, at?, up: false, vis: VisRef[] }
  ```

- **In a snapshot**, every such item for this recipient.
- **On the guest**, for each id in `items`:
  `view.items[id] = body.vis?.[id] ?? body.items[id]`. Overrides are **per
  message, never sticky**.
  - A player removed from `vis` gets the touched item's shared, reduced
    form with no override. That is correct.
- **The cost.** Overrides are computed per recipient only for the dirty
  `vis` items of the tick (snapshots: every `vis` item). The shared patch
  is still built once.
- **Peek replies** (`note.peek`) also carry `{t, f}` for a piece, beside
  today's `{d, i}`.

### 5c. Actions

| Action | Payload and validation | Semantics | Log | Flood | Ruled |
|---|---|---|---|---|---|
| `hide` | `{ids: id[1..20]}`: pieces whose type has a `back`; `mayHandle`, `notLocked` | `up = false`, `vis = [p]` (the actor's pid). If the piece was unowned, also `owner = p` and `po: 1`. | "hid {label}" / "hid {N} pieces" | 1 | yes |
| `flip` (a hidden piece) | as in 2c, plus the private-piece rule below | reveals it: `up = true`; `vis`, `pv` and `po` (with the owner set by `po`) are deleted | "turned over {label}" (now public) | 1 | yes |
| `roll` (hidden dice) | as in 2c; a die with a non-empty `vis` may be rolled by the players in its resolved `vis` and by its owner (who also pass `mayHandle`) | the new faces are visible only to `vis`; everyone sees the tumble of the backs | "rolled 4 dice (2 hidden): 3 · 5" (values of shown dice only), or "rolled 2 hidden dice" | 1 | yes |
| `face` (a private piece) | as in 2c, plus the private-piece rule below | `it.f = f`; the piece stays hidden from others | "turned a hidden piece" | 1 | yes |
| `peek` | `{id}`: as today for cards and piles; **and** any piece hidden from the actor (a pile top that is a hidden piece too) | A private note `{peek: {t, f}, to: p}` (the host's own peek uses `showPeek`). Loud on the log. A peek at a piece the actor can already see → the note "You can already see it", no log line. | "peeked at a hidden piece" (`k: 1`, loud) | 1 | yes (vetoable; `strict` refuses it unless allowed) |
| `group` | gains `op: 'hide'` | per member, as `hide` | "hid {N} pieces" | 1 + ⌊N/20⌋ | yes |

**[DECISION] `hide` sets `vis` to the actor's pid, not their seat.** Dice
under a cup, or a tile you turned away, belong to you as a person. Box
setups and scripts use seat refs when the material belongs to a seat.

**[DECISION] Private pieces are protected.** Without an owner, anyone
could `flip` (reveal) or `roll` (re-roll) Alice's cupped dice.

- `hide` makes an unowned piece Alice's (`owner`, with `po` so that the
  ownership ends when the piece is revealed), so `mayHandle` keeps others
  off it.
- **The private-piece rule:** a piece with a non-empty `vis` that is
  hidden from the actor refuses `flip`, `roll` and `face` with the uniform
  "🚫 That piece is hidden", unless the actor owns it. This also covers
  pieces a script hid for a seat without giving them an owner.
- A piece hidden from **everyone** (no `vis`, such as a face-down tile in a
  memory game) is unaffected: anyone who may handle it can turn it over,
  as in Phase 2.

### 5d. Public view and hidden information (final form, every kind)

| Item state | A viewer in `vis` (resolved) | Every other viewer |
|---|---|---|
| card face up / face down | as in Phase 1 (cards have no `vis`) | as in Phase 1 |
| pile | `top` as in Phase 2; a hidden piece on top shows `{b, up:false}` to everyone | same |
| piece shown | `{k:'g', t, f, …}` | same |
| piece hidden, no `vis` | `{k:'g', b, …}` | same |
| piece hidden, with `vis` | `{k:'g', t, f, …, up:false, vis}`, delivered in the per-recipient `vis` override | `{k:'g', b, x, y, rot, z, n?, owner?, lock?, at?}` |
| die under a cup (hidden, `vis: [owner]`) | the full die, result included | `{k:'g', b: <cup back>, …}` |
| piece hidden, box missing | `{k:'g', b: null, …}` (no override: the host cannot build one) | `{k:'g', b: null, …}`; never `{t, f}` (§2d) |
| supply | as in Phase 2 | as in Phase 2 |
| bag | `{…, n}` (never `of`) | same |
| hand | its owner, per recipient | `handCount` only |

- **The log never names a piece that is hidden from anyone.** `itemLabel`
  uses "a hidden piece" whenever `up === false`, and roll lines list only
  the values of shown dice (5c). That covers `t.roll` of a hidden die
  ("📜 Rules rolled a hidden die") and group rolls (§4c).

### 5e. Facade (`t`) additions

| Call | Returns | Notes | Log (Rules) |
|---|---|---|---|
| `t.hide(id, refs = [])` | `boolean` | `up = false`, `vis = refs` (pids or `'seat:<id>'`, ≤ 8); throws `TypeError` if the type has no back | aggregated "hid N pieces" |
| `t.reveal(id)` | `boolean` | `up = true`, and `vis`, `pv` and `po` (with its owner) cleared | "revealed {label}" (now public; aggregated when 4 or more) |
| `t.setVis(id, refs \| null)` | `boolean` | changes who may see it; `up` is untouched | aggregated "changed who sees N pieces" |
| `t.canSee(pid, id)` | `boolean` | the visibility rule | — |
| `t.spawn(type, o)` | | `o.vis` (with `o.up: false`) | |

- **Reads** (`t.item`, `t.find`, `t.at`) return full private items, as
  every script read does today. Scripts see everything.

### 5f. Worker

There is no change. `vis`, `pv` and `po` are plain item fields in patches.
The per-recipient reduction happens on the host, at broadcast time (5b).

### 5g. UI and interaction

- **A piece hidden from others but visible to me:**
  - renders its face, with a small 🙈 badge and a faint hatched corner
    ("only you can see this");
  - its tooltip says so;
  - if it is in a private zone, the zone's label already says so.
- **Pieces whose type has a back** gain buttons on the action bar:
  - "🙈 Hide" (`hide`), when the piece is shown;
  - "Reveal" (`flip`), when it is hidden and the player may handle it;
  - "Peek", when it is hidden from the player.
- **Dice under a cup.** "🙈 Hide" on dice, or on a group of them, is the
  cup. Rolling hidden dice tumbles their backs on everyone's screen, and
  the faces on the owner's.
- **Private zones** are drawn in the board SVG as a hatched fill in the
  owner's colour, with the label "🔒 {name}'s rack" (or the zone's
  `label`).
- **A bag**, when the player owns an active private zone, gains "Draw to my
  rack": `pull` with `x, y` = the zone's first free slot (a simple scan
  along its bounding box in steps of the piece size, within the polygon).
  **[DECISION]** A tile then lands hidden at once, instead of appearing
  face down beside the bag and being dragged over.
- **Peek.** The zoom overlay shows the piece's face, captioned "Only you
  can see this — everyone knows you peeked".
- **Multi-select:** the group bar gains 🙈 Hide.

**The demos** (`BOXES` in `templates.js`):

- **Dominoes.** A double-six set of 28 tiles, each a `tile`:
  - 60 × 120, faces `[{pips: [a, b], color: '#f8fafc'}]`, a shared back,
    `rotStep: 90`;
  - `hand: false`. **[DECISION]** TABLETOP lists dominoes among
    hand-held pieces, and a box may still declare `hand: true`. The demo
    uses racks on purpose: it is the proof of private areas beyond the
    hand, which Phase 5 delivers, and racks keep tiles on the table where
    a phone player can see the line of play and their tiles together.
  - The boneyard is a bag of the 28 tiles, face down.
  - `forEachSeat` places a 520 × 140 rack board, owned by `'seat'`, with
    one `private:'reveal'` zone covering it.
  - The light rules script:
    - turn order (the `turns` logic);
    - "Draw 7" at the start (`t.pull` into each rack);
    - the spinner and the scoring are left to the players.
- **Veiled Ranks** (an original hidden-units game: capture the banner).
  **[DECISION]** Its ranks and interactions are deliberately its own: no
  commercial game's rank names, no "scout moves any distance", no
  bomb/miner or spy-beats-marshal rule. Hidden units, a flag to capture
  and higher-beats-lower combat are generic, public-domain ideas.
  - **The board:** a 1,600 × 1,600 rect table and a 10 × 10 board, chess
    labels, `primary: true`.
  - **Deployment zones:** two `private:'keep'` zones, rows 1–3 owned by
    `seat:south` and rows 8–10 owned by `seat:north`.
  - **Units:** 12 per side. Each is a token with its faction's back and
    `meta.rank`:

    | Unit | Count | Rank | Rule |
    |---|---|---|---|
    | Banner | 1 | 0 | immobile; whoever captures it wins |
    | Crown | 1 | 4 | — |
    | Blade | 2 | 3 | — |
    | Pike | 3 | 2 | — |
    | Lancer | 2 | 1 | moves 1 **or 2** squares in a straight line, the first square empty |
    | Herald | 1 | 1 | its attack is a **parley**: both units are revealed, nothing is removed, and the Herald stays where it was |
    | Trap | 2 | — | immobile; a unit that attacks it is removed **together with** the Trap (single use) |

  - **Setup:** `forEachSeat` with a `group {shuffle: true}` that places
    the 12 units on the player's three rows. They enter the `keep` zone on
    placement, so each lands hidden, visible to its seat, owned through
    `po`; their z values and positions are shuffled among units sharing
    the faction back (§2c), so neither order nor layout reveals a rank.
  - **The script** (`strict`):
    - **Deploy phase:** own units may be rearranged inside the player's
      zone (swap by dragging onto another own unit). "Ready" ends it once
      both players are ready.
    - **Then** `handle` enforces the turn, an orthogonal step of one
      square (Lancers: one or two, with `t.line` checking the first
      square), and immobile units.
    - **An attack** means moving onto an enemy: `t.reveal` both, then the
      higher rank wins and the loser is removed (both on a tie); a Trap
      removes both; a Herald parleys.
    - **Capturing the Banner** calls `t.win`.

### 5h. Persistence

- **Migration v5 → v6** (`MIGRATE[5]`): `v = 6`. Older pieces have no
  `vis`, so nothing else changes.
- **Saves** include `vis`, `pv` and `po` as plain item fields.
- **The setup grammar gains what exports need** (Phase 5 extends §4a):

  ```ts
  // on piece entries (with up: false) and on the piece members of pile and hands entries:
  vis?: VisSpec | VisSpec[]          // ≤ 8
  po?: true                          // piece entries: the owner was set by hiding, and ends on reveal (5a)
  VisSpec = 'seat'                   // inside forEachSeat: that seat ('seat:<id>' or the seated player)
          | `seat:${string}`         // a named seat
          | `#${number}`             // the k-th seated player (4a), for a pid in the exported vis
  ```

  `rot` and `owner` on `deck`, `pile` and `card` entries already exist
  since Phase 4.
- **Exports** write `up: false` with `vis` (pids as `#k`), and `owner`
  (pids as `#k`). A piece with `pv` is exported **without** `up`, `vis`
  and (when it also has `po`) `owner`: placing it in its private zone on
  import re-derives all of them (5a), exactly as the original placement
  did. A piece with `po` but no `pv` (hidden with `hide`) is exported with
  its `owner` as `#k`, its `vis`, and `po: true`. Exports are host only
  (4d).

### 5i. CLI bridge

- **Snapshot:**
  - items hidden from me are `{kind: 'hidden', …}`, as in Phase 2;
  - items I can see but others can't carry `hiddenFromOthers: true` and
    their full fields;
  - a peek arrives in `msgs` as `peek: {name}`.
- **Commands:** `hide <id…>` and `reveal <id>`. `reveal` sends `flip`.
  `peek <id>` works on pieces.
- **Bridge API:** `hide(*ids)`.

### 5j. Security

**Gates**

- The reduction (5d) is computed on the host, per recipient, inside the
  bound body. A peer that is not registered gets only the shared form.
- **A seat change** re-sends every seat-ref `vis` item (the `byVis`
  touch). The new occupant gains the full form; the old one gets the
  reduced form.
- **The log** never names a hidden piece.
- **Peek** is loud and vetoable.
- **`hide`** requires a back, `mayHandle` and `notLocked`, and makes an
  unowned piece the actor's (5c).
- **The private-piece rule** (5c) and the uniform refusals of §2c apply
  to everyone outside a piece's `vis`.
- **Private zones** never expose anything; they only hide.
- **Forged fields** (`vis`, `up`, `pv` in action payloads) are ignored.
  No human action sets someone else's `vis`.

**Attacker cases** (`t-p5-private.js`; Mallory is seated, or a raw peer):

1. Alice hides 3 dice under her cup. No body Mallory receives contains
   their `t` or `f`, or the result, before or after a roll. Checked by a
   recursive scan over every body, for the face labels and the type ref.
2. Dominoes in Alice's rack: Mallory never receives their pips (a scan
   for `pips`) and gets no `vis` override.
3. Mallory takes Alice's former seat after Alice leaves: if `vis` refs that
   seat, Mallory now sees those pieces (by design). If `vis` is Alice's
   pid, she doesn't. Both are asserted.
4. Mallory sends `move`, `flip` or `peek` on Alice's rack tile: the move
   and flip are refused (owned, through `po`); the peek works and is
   logged loudly.
5. Mallory sends `hide` on Alice's pieces, or on pieces with no back:
   refused.
6. Mallory sends `{t:'move', id, x, y, vis: [mallory], up: true}`: the
   extra fields are ignored.
7. A rules script with `validate` vetoing `peek` (as Hold'em does for its
   deck): a piece peek is blocked, with the notice.
8. **Cupped dice are Alice's.** Mallory sends `flip`, `roll`, `face`,
   `move` and `owner` (claim) on Alice's cupped dice: every one is
   refused, the refusals for `flip`, `roll` and `face` are the uniform
   "🚫 That piece is hidden", and the dice and their values are unchanged
   (checked in the host state).
9. **A script-hidden unit with no owner** (`t.hide(id, ['seat:north'])`):
   Mallory, seated south, sends `flip` and `roll`: refused uniformly.
10. **Order reveals nothing.** Over 20 Veiled Ranks setups (fresh rooms),
    Mallory records the z order and the key order of the 12 hidden north
    units in her first snapshot, and guesses each unit's rank from its
    position in those orders (and from its square): her accuracy does no
    better than the best constant guess, within a binomial 99 % bound.
11. **Hidden rolls are not logged.** A group roll of 2 shown and 2 cupped
    dice logs "rolled 4 dice (2 hidden): a · b", and `t.roll` of a cupped
    die logs "📜 Rules rolled a hidden die"; the scan finds no hidden
    value in any log entry Mallory receives.

### 5k. Performance budgets

| # | Budget | How it is measured |
|---|---|---|
| B22 | 8 players, each with 20 `vis` tiles: a move of one `vis` tile adds ≤ 400 B to the listed recipient's patch, and 0 B to the others' | the Node byte count |
| B23 | A snapshot for one recipient with 160 `vis` items in the table: build ≤ 20 ms | Node timing |

### 5l. Test plan (Phase 5)

**`core-p5.test.mjs`**

1. The per-viewer reduction, for every row of 5d, including seat-ref
   `vis` and owner changes.
2. Private zones:
   - entering, for a type with and without a back;
   - `reveal` versus `keep` on leaving;
   - between zones of the same owner;
   - into another owner's zone;
   - `po` cleanup.
3. Peek, piece variant.
4. The `hide` and `roll` semantics of hidden dice: `hide` sets `owner`
   and `po` on an unowned die and not on an owned one; `flip` clears both;
   the private-piece rule.
5. `byVis` touches on a seat change.
6. `MIGRATE[5]`.
7. A random run of 500 ops with three viewers: each viewer's applied
   patches equal that viewer's full snapshot.
8. **Export round trip of private material:** cupped dice (`po`), rack
   tiles (`pv`, `po`), a screened unit that has left its screen (`vis`,
   no `pv`) and a script `t.hide` with seat refs export and set up again
   in a fresh table with the same `up`, resolved `vis`, `owner`, `pv` and
   `po`.

**`t-p5-private.js`** (desktop and iPhone 13, two seated players plus
Mallory):

1. Attacker cases 1–7.
2. The 🙈 badge appears for the owner only.
3. Dice under a cup roll, and their reveal is seen by both.
4. Hide and Reveal from the action bar, and group hide.

**`t-p5-demos.js`**

- **Dominoes:**
  - "Draw 7" fills both racks;
  - each player sees only their own pips;
  - dragging a tile out of the rack onto the table reveals it to both;
  - the boneyard count drops.
- **Veiled Ranks:**
  - deploy inside the zone; deploying outside is refused;
  - Ready;
  - a legal move, and an illegal one refused;
  - an attack reveals both units on both screens, and the lower one is
    removed;
  - a Lancer's two-square move, with a blocked first square refused;
  - a Herald's parley reveals both units and removes neither;
  - attacking a Trap removes both;
  - capturing the banner gives 🏆.

### 5m. Docs and module ownership

- **README.md:** "Private material" (hiding, cups and who may touch them,
  racks and screens, peeking at pieces, exporting private material), and
  the demos.
- **ENGINE.md:** `t.hide`, `t.reveal`, `t.setVis` and `t.canSee`; private
  zones. Remind authors that hidden-movement policy (fog of war) belongs to
  scripts.
- **TABLETOP.md:** mark Phase 5 done.
- **Module ownership**
  - `core.js`: the `vis` rule, `byVis`, private zones (inside
    `place()`), `hide` and the private-piece rule, peek of pieces, the
    per-recipient full forms, the setup grammar's `vis` and `po`, their
    export, `MIGRATE[5]`.
  - `app.js`: the override merge, the 🙈 rendering, the bar buttons, "Draw
    to my rack", piece peeks.
  - `pieces.js`: zone hatching, the 🙈 badge.
  - `templates.js`: `BOXES.dominoes` and `BOXES.ranks`, with their scripts.

---

## 6. Cross-phase dependency map

```text
P0 core.js / templates.js / tests/  (put/remove/touch, queues, injected rules iface)
 │
 ▼
P1 SCALE ──────────────────────────────────────────────────────────────────────────────┐
 │  dirty sets + takeDirty ──► patches (shared + per-recipient parts, per-peer base)     │
 │  T.pub, trimLog, zMax, byKind, t.item/t.find                                         │
 │  host job queue (preprocessing outside the FIFO) ────────────────┐                   │
 │  store.js: IndexedDB saves/catalog/assets, content-hash pull,     │                   │
 │  imageDims; boot role decision; MODULE_V + PROTO gates            │                   │
 │  PUBLIC_ACTIONS, refusal touches, late-arrival indexes, __ct      │                   │
 ▼                                                                   │                   │
P2 PIECES ───────────────────────────────────────────┐               │                   │
 │  item kinds g/s/b, cleanBox, owner/lock, seats     │               │                   │
 │  (named, seat-bound owners), rect tables, handy,   │               │                   │
 │  grid.js DRAWING + ADDRESS GRAMMAR, pieces.js,     │               │                   │
 │  `boxes` channel, place(), hidden-item rule, back  │               │                   │
 │  flags, board z band, boxKey/isBuiltin, setup      │               │                   │
 │  subset (+group shuffle), loadBox/clear, t.roll    │               │                   │
 ▼                                                    │               │                   │
P3 SPACE + WORKER ◄───────────────────────────────────┘ (boards)      │ (queue)           │ (patch machinery
 │  grid.js MATH: snapping, zones, links, primary board               ◄┘                   │  → StatePatch,
 │  journal (rollback/checkpoint/savepoint) ◄──────────────────────────────────────────────┘   applyStatePatch)
 │  rules-worker.js, watchdog, internal actions, handle/strict/allow
 │  ask/hint/secret as per-recipient parts (same mechanism as `hand`)
 │  components from code, spatial helpers, `drag` relay
 ▼
P4 BOXES ◄── P2 cleanBox + setup subset; P3 addresses in `Where`, savepoints, Worker-queued setup → setRules
 │  boxio.js (game.json/zip/export, streamed inflate, encodeImage), addBox/setup/reset,
 │  ids and @#k on import, lastSetup/rules.box, PublicBox, group (savepoint per member),
 │  multi-select, stack inspector (P3 space fan-out), 📦
 ▼
P5 PRIVATE ◄── P2 hidden-item rule; P3 zones + place() + per-recipient parts + ruled peek;
 │             P4 group op, export (#k), BOXES with forEachSeat racks
    vis + byVis, private zones (reveal/keep), hide (+owner), private-piece rule, piece peek,
    per-recipient `vis` overrides, setup grammar vis/po
```

**Hard prerequisites** (a phase cannot start without them):

| Phase | Needs from earlier phases |
|---|---|
| P1 | P0's `put/remove/touch` and its queues |
| P2 | P1's dirty sets, patches, PROTO gate and asset store |
| P3 | P2's boards, `grid.js` geometry and address grammar, and `place()`; P1's queue and patch machinery |
| P4 | P2's `cleanBox`, `boxKey` and setup; P3's addresses, savepoints and Worker queueing |
| P5 | P2's hidden-item rule; P3's zones and per-recipient parts; P4's `group`, export and setup grammar |

**Work that can run in parallel inside a phase:**

| Phase | Tracks that can proceed side by side |
|---|---|
| P1 | `store.js` (IndexedDB, migration, quota) ‖ delta sync in core and app ‖ the bench harness (byte counter, serial runner) |
| P2 | `cleanBox` and core actions ‖ `pieces.js` and `grid.js` drawing ‖ rect tables and seats (layout, seat menu) ‖ the CLI |
| P3 | `grid.js` maths (pure, Node-tested) ‖ the journal and pipeline in core ‖ `rules-worker.js` and the host queue and watchdog ‖ the demo templates (chess, go and reversi logic, developed against core in Node) ‖ the ask, hint and secret UI |
| P4 | `boxio.js` (import and export) ‖ multi-select and the inspector UI ‖ the Hexfront generator |
| P5 | core `vis` and zones ‖ the dominoes and Veiled Ranks boxes ‖ the UI badges |

**Documentation.** Every phase updates README.md, ENGINE.md, TABLETOP.md
§7 and the help dialog in the same PR as its code.

## 7. Risks

| # | Risk | Likelihood / impact | Mitigation in this spec |
|---|---|---|---|
| R1 | Phase 0's API names differ from §0.3 | high / low | §0.3 rule: Phase 0's names win, this spec's semantics win |
| R2 | An IndexedDB write started in `pagehide` doesn't commit, so a reload loses the last ≤ 1 s | medium / medium | the `ct-pending-<room>` marker makes the loss loud (1h). The throttle stays at 1 s. |
| R3 | Safari IndexedDB quirks: Blobs, private mode, eviction | medium / medium | `ArrayBuffer` storage; `navigator.storage.persist()`; loud open failures; no silent fallback |
| R4 | Trystero 0.25.3 binary `send(data, target, metadata)` behaves differently from what 1b.5 assumes | low / medium | a Phase 1 spike test first. Fallback: base64 inside the JSON `asset` message (+33 % bytes), with the same pull and verify rules. |
| R5 | The host state and the Worker mirror drift because of a core bug | medium / high | one-writer invariant (3f.1); `T.digest()` checks in tests and in test builds; the 300-action convergence test |
| R6 | Atomic hooks change the behaviour of user scripts that relied on partial ops | low / low | no shipped template does; ENGINE.md documents it |
| R7 | Module Workers are unsupported (iOS < 15, Firefox < 114) | low / medium | a loud failure on Enable: "This browser can't run rules scripts (module workers unsupported)". The free table keeps working. |
| R8 | Live drag relay (`drag`) changes how others see drags (state no longer changes mid-drag) | medium / low | fx live rendering with a 1.5 s hold; existing sync and UI suites must stay green; screenshots reviewed |
| R9 | JSZip's internal `_data.uncompressedSize` changes, or the `+esm` build differs from the UMD one | low (pinned) / low | pinned `jszip@3.10.1/+esm`; the declared sizes are only a pre-check; the defence is the streamed inflate with hard caps (4j); a test pins `_data` and `internalStream` on that build |
| R10 | 1,000 DOM pieces on a mid-range phone miss 60 fps | medium / high | dirty-set rendering, `contain`, cached board SVG; B4 and B10 fail the suite; TABLETOP keeps canvas as a later option |
| R11 | New public fields leak hidden information: `at`, `owner`, `n`, `z`, a stable id across hide and reveal | medium / medium | positions, counts and owners are public by design (as for face-down cards today). Identity linkage through a stable id is documented: scripts that need anonymity re-spawn (as CAH re-deals). Attacker scans in each phase. |
| R12 | The version gate annoys players for about 10 min after a deploy | high / low | a clear "reload" message; nothing breaks silently |
| R13 | Box rules are a trojan: a script that leaks hands in game | medium / high | the trust dialog (4g), no auto-enable, built-ins exempt; README honest limits (dynamic `import()` included) |
| R14 | Test runtime on 4 CPUs grows with about 15 new suites | high / medium | focused suites; the bench runs serially once; Node logic suites carry most of the combinatorics |
| R15 | Seat-key migration (`players[p].key` → `keys`) misses a path, so guests are refused | low / high | `MIGRATE[1]` test plus an E2E resume of a legacy save with a returning guest |
| R16 | ECDSA signing load: 25 ticks/s × 8 peers = 200 signatures/s | low / low | signing happens only when something changed; B2 measures it |
| R17 | Ambiguous snapping on overlapping boards | low / low | snapping picks the topmost (newest) board under the piece; display forms come from the primary-board rule (3a); an ambiguous bare address throws or is refused, never guessed |
| R18 | UI crowding on phones: seat menu, inspector, ask sheet, group bar | medium / medium | every UI check runs on the iPhone 13 descriptor; screenshots in each phase's review |
| R19 | Pages serves a mix of old and new module files for ~10 minutes after a deploy | high / medium | `?v=MODULE_V` import specifiers, the boot assertion, the Worker's init check (§1b.6); a PR that changes a module without bumping `MODULE_V` is a review blocker |
| R20 | The watchdog kills healthy rules on a phone host that was backgrounded | medium / high | visible-time budget with a 1 s grace, re-armed after a late timer, scaled by job size (3f.5); a frozen-page test (3l) |
| R21 | Id and `@#k` substitution on import rewrites a script string that merely equals an old id or pid | very low / medium | ids and pids are random 32- and 64-bit hex strings; substitution is exact-match only; the remap is reported with a toast |
| R22 | A stray async continuation in a script mutates the Worker's mirror after `done` | medium / high | `drain()` plus the `guard()` JSON comparison turn it into a loud `fatal` before the next job (3f.7) |
| R23 | An IndexedDB failure or a newer save on a host reload turns the host into a guest, or overwrites the newer save | low / high | the boot role decision uses the host key; newer saves are refused and never written (1h) |

## 8. Process notes for implementers

- **Branches.** One branch per phase, merged as one pull request.
- **Commits:** the subject `cardtable: <summary>`, then a bullet body.

- **Before a phase is handed over:**
  - every existing suite, plus the phase's suites, passes in one full run
    (`run-all.sh`, under the machine-wide flock);
  - `parse.js` passes on every module (`app.js`, `core.js`, `grid.js`,
    `pieces.js`, `store.js`, `rules-worker.js`, `boxio.js`,
    `templates.js`);
  - the benches pass serially;
  - `MODULE_V` is bumped in every module and import specifier (§0.2);
  - `tests/README.md` lists the phase's suites, the serial bench list, the
    fixtures and the minimum Node version (22.7);
  - every existing suite that had to change is listed, with the reason,
    in the PR description (as §1l does for Phase 1).
- **Iterate with single suites.** The machine has 4 CPUs.
- **Test fixtures and CDN copies.**
  - Images for box tests are generated once by
    `tests/gen-fixtures.js` (canvas in Playwright) and committed under
    `tests/fixtures/`.
  - JSZip's `+esm` build is added to the routed CDN copies (`cdn/`) in
    Phase 4.
  - Raw test peers import `PROTO` from `core.js`; nothing hard-codes it.
- **`window.CARDTABLE_TEST`** is the only test switch. It exposes `__ct`
  (1g), `__ct.workerDigest()` (3f.3) and the perf counters. Production code
  paths must not depend on it.

## 9. Decisions index

Every sub-decision this spec takes where TABLETOP.md left the question
open:

| # | Decision | Section |
|---|---|---|
| D1 | Coordinates are always top-left, and addresses always centre the item (for every API and `game.json`) | §0.2 |
| D2 | One crypto RNG (`env.randInt`, rejection sampling) for all engine randomness, shuffle included | §0.2 |
| D3 | Seat keys move out of `players` into `host.keys`, never mirrored, patched or exported | 1a |
| D4 | Assets are content-addressed by the SHA-256 of their bytes, stored as `ArrayBuffer` plus MIME | 1a |
| D5 | Patches replace whole public items (no field-level diffs) | 1b.2 |
| D6 | A version gate (`PROTO` = phase + 1; `_v` on actions, `v` on bodies) with a loud "reload" | 1b.6 |
| D7 | An explicit `PUBLIC_ACTIONS` whitelist; `_*` actions are host-internal | 1c |
| D8 | Script reads return detached copies, not frozen proxies | 1e |
| D9 | A `window.CARDTABLE_TEST` hook (`__ct`) for full-view comparison and fast actions | 1g |
| D10 | A `ct-pending-<room>` marker makes a lost pagehide save loud (amended by D308: it holds the state itself when it can, and a boot resumes it) | 1h |
| D11 | No localStorage fallback when IndexedDB is unavailable (a loud "won't be saved" instead) | 1h |
| D12 | The `log` channel is retired; log entries travel inside snapshots and patches, with a shared `trimLog` | 1b, 1a |
| D13 | Board structure is declared and **drawn** (generated SVG) in Phase 2; its semantics come in Phase 3 | 2a |
| D14 | A `pips` Face primitive for dice and dominoes | 2a |
| D15 | Seat-bound owners and `vis` (`'seat:<id>'`) follow the seat's occupant | 2a, 5a |
| D16 | An offline player's named seat is held for them; the host frees it | 2a |
| D17 | The host is not exempt from owner checks; it reassigns ownership instead | 2c |
| D18 | Touch: a drag takes one from a ×N stack; "Move all" arms a whole-stack drag | 2g |
| D19 | `t.roll` and `t.random` ship with the human `roll` (Phase 2); other components from code in Phase 3 | 2e |
| D20 | A piece whose box is missing is kept and rendered as a placeholder, never deleted | 2h |
| D21 | `PublicBox` (the wire form) never carries `setup`, `rules` or `rulesState` | 2b, 4b |
| D22 | Only pieces (`k:'g'`) snap and get addresses; boards never snap | 3a |
| D23 | Display addresses: bare on the primary board (`primary: true`, else the oldest grid board, else the oldest spaces board; zone-only boards never count), `<typeId>[#n]:<local>` elsewhere; ambiguous bare addresses throw or are refused | 3a |
| D24 | Live drags travel as a non-state `drag` fx; only the drop is a `move` | 3c |
| D25 | `strict` has an `allow` list; `seat` is never strict-refused | 3c |
| D26 | `onAction` also runs after handled actions (`a.handled = true`) | 3e |
| D27 | Rules log lines aggregate (runs of ≥ 4 of the same op in one action) | 3e |
| D28 | A per-action journal with checkpoints gives atomic hooks (veto → rollback; a hook throw → keep the default effect, drop the hook's ops) | 3f.4 |
| D29 | Worker hardening deletes network and storage APIs (defence in depth); script trust stays the model | 3f.7 |
| D30 | The page passes `WORKER_GLOBALS` (`CAH_CARDS`) to the Worker as `window.*` | 3f.7 |
| D31 | The watchdog drops the in-flight action and continues the queue on the free table | 3f.5 |
| D32 | A guest's box only registers; set up, reset and export are the host's | 4c |
| D33 | Box rules never run without the host's explicit, warned click (exempt only when `isBuiltin`: content equal to a `BOXES` entry) | 4c, 4g |
| D34 | Export is host only (it serializes hidden information) | 4d |
| D35 | No box upload from the CLI in phases 1–5 | 4i |
| D36 | Zip bombs are refused by a 64 MB cap on the zip and a streamed inflate with hard per-entry (min(declared, 16 MB)) and total (64 MB) caps; declared sizes are only a pre-check | 4j |
| D37 | `group` expands into ruled per-member sub-actions in one atomic job; failing members are skipped | 4c |
| D38 | Private areas are zones on small boards (`private: 'reveal' \| 'keep'`); no new area concept | 5a |
| D39 | `hide` sets `vis` to the actor's pid (a cup belongs to a person) | 5c |
| D40 | "Draw to my rack" pulls straight into the player's private zone | 5g |
| D41 | The guest budget (1.5 M chars) is unchanged and shared by decks and boxes | 4c, 4j |
| D42 | The demos are original or public domain: draughts, backgammon, chess, go, reversi, dominoes, Hexfront (original), Veiled Ranks (original) | 2g, 3g, 4, 5g |
| D43 | The patch base is per recipient; `sync` advances only when a body is sent, so private-only commits never cause gaps | 1b.3 |
| D44 | Module version: `MODULE_V` in every module, `?v=` import specifiers, a boot assertion and a Worker init check | 0.2, 1b.6 |
| D45 | Deck and box ingestion runs outside the FIFO, one per player; the guest budget is checked before decoding and again at commit | 1c |
| D46 | Image header limits (≤ 4,096 px a side, ≤ 16 Mpx), checked before decoding on every peer | 1a |
| D47 | The host serves only assets this table's catalog references; referenced-but-missing ones are answered with `missing`; guests time out after 20 s and one retry | 1b.5 |
| D48 | The host/guest role is decided after IndexedDB opens and the save loads; the host key keeps a storage-less reload hosting | 1h |
| D49 | Saves from a newer version are refused and never overwritten | 1h |
| D50 | `navigator.storage.persist()` is requested only from the host's first upload gesture | 1h |
| D51 | Budgets read TABLETOP's "steady 60 fps" as B4's long-task and relative frame bound, and allow 1.5 KB observed on the wire (B1') for a 1 KB sealed body (B1) | 1k |
| D52 | `card` is not a piece kind; cards stay decks (a deviation from TABLETOP's one-piece model) | 2a |
| D53 | A back carries `rotStep`, `hand` and `stack`; hidden items use the back's flags everywhere | 2a |
| D54 | `lockable` is set per box | 2a |
| D55 | The grid adds `labels: 'go'` and `snap: 'point'` | 2a |
| D56 | Exact table bounds: round 1300/1800/2400; rect 800–6000 × 600–4000 | 2a |
| D57 | A bag's `hand` flag is fixed when the bag is made | 2a |
| D58 | Boards live in a reserved z band (`BOARD_Z0 + boardSeq`), newer above older | 2a |
| D59 | "Built in" is derived from content (`isBuiltin`); `src` and `by` live in the catalog record and are never read from a box; boxes are deduplicated by content (`boxKey`) | 2a, 2j |
| D60 | Uniform refusals for pieces hidden from the actor, before any type-dependent check | 2c |
| D61 | `MAX_ITEMS` = 5,000, checked on every op that adds items; old saves above it still load | 2c |
| D62 | Hidden setup pieces carry no creation order: sorted-id serialization, random z, `group {shuffle}` | 0.2, 2c |
| D63 | Claims need an unowned, unlocked, non-board item; non-host locks need `mayHandle` | 2c |
| D64 | `split {onto}` moves part of a stack onto another atomically | 2c |
| D65 | `t.players()` excludes watchers (`{all: true}` includes them) | 2e |
| D66 | A drag that starts on an item the player may not handle pans the view (amended by D313: the first such pan for each owner says whose the piece is) | 2g |
| D67 | A handful of dice: a double-click rolls the die and the dice touching it | 2g |
| D68 | The doubling cube is a token, turned with `face` | 2g |
| D69 | Asks live in `rules.asks` behind `cleanAsk`; `t.secret` in `rules.secret`; hints are not persisted | 3a |
| D70 | A board move moves nothing else; `at` and zones are recomputed by containment; zone effects fire only on placement | 3a |
| D71 | `pull` draws its member (`a.pick`) before the hooks, so `a.to` is known to them | 3c |
| D72 | `select` is limited to 5 per second and refused on pieces hidden from the player | 3c |
| D73 | A group's live drag is one `drag {ids, dx, dy}`, one flood token | 3c |
| D74 | The Worker is the only writer while rules are on; the mirror is not synced through public patches | 3f.1 |
| D75 | Thenable returns fail closed; `drain()` and `guard()` make stray async mutations fatal | 3f.7 |
| D76 | The watchdog counts visible time, with a 1 s grace, scaled by job size | 3f.5 |
| D77 | A space's `dir` is its fan direction | 3g |
| D78 | Chess draws are automatic (threefold repetition, fifty-move rule, insufficient material); Offer draw and Resign buttons | 3g |
| D79 | Reversi starts from the fixed crossed position, dark to move | 3g |
| D80 | The `group` flood cost is 1 + ⌊N/20⌋ | 4c |
| D81 | Ids are preserved on import when free; remapped ids and seated players' pids (`@#k`, `#k`) are substituted in the rules state | 4c |
| D82 | Reset uses the persisted `lastSetup` and `rules.box` | 2a, 4c |
| D83 | A guest's box shuffles its face-down piles by default, and the confirm names the uploader | 4c, 4g |
| D84 | `hide` claims an unowned piece; private pieces refuse `flip`, `roll` and `face` from anyone outside `vis` but their owner | 5c |
| D85 | The dominoes demo uses racks (`hand: false`) | 5g |
| D86 | Veiled Ranks has its own ranks and combat (no commercial rank names or signature rules) | 5g |
| D87 | Hands hold at most `MAX_HAND` = 1,000 entries and piles `MAX_PILE` = 5,000 (cards too); a growing op past either is refused ("🚫 Your hand is full (1,000)", "🚫 That pile is full (5,000)"); scripts get `false` and a `console.warn` | 2c (amended after the 2A review) |
| D88 | A bag keeps `box`, the box whose setup made it; it decides who may lock the bag (never `of`) and is **public** (it names a public box, never the contents) | 2a, 2d (amended after the 2A review) |
| D89 | A back is shared by boards only or by non-boards only; in a `group {shuffle}`, hidden entries sharing a back must agree on `rot`, `lock`, `n` and `owner` (refused in `cleanBox`, not permuted) — amended by D210: being a die, too | 2a, 2c (amended after the 2A review) |
| D90 | The owner dot shows on demand: only while the item is selected, or under a pointer that hovers (`@media (hover: hover)`); its colour (a seat-bound owner's is the seat's) and its growth on a table drawn small are unchanged. A tap still selects someone else's piece, which shows the dot and the bar's Claim / Release / Give; a drag on it pans | 2g (amended at the Phase 2 close-out) |
| D91 | (Amended by D297: the printed text is HTML spans over the board's SVG, turned by CSS `rotate` about their own centres; `transform-box` no longer plays a part.) A board's printed text reads upright on every screen: each coordinate `<text>` (`.blabels`) turns about its own centre (`transform-box: fill-box`) by minus the view's angle and the board item's own `rot`, as chess apps do on a flipped board, and stays at its own file or rank; it also grows with the badges on a table drawn small, by at most 1.6× and no more than its margin holds (D97). A space's or zone's label (`.slabel`) turns by that angle rounded to the nearest half turn (CSS `round()`): never upside down, and still along its space, inside the board. The badges with a number or a name (a pile's count and name, ×N, ∞), 🔒 and a bag's drawing turn the same way as the coordinates, about their own centres (a pile's name about the pile's: D97), and hold still while two fingers move the view (D96). The `boardSVG` string stays the same for every viewer (still cached per type): the view's angle is `--view`, written by `layout()` into one rule of the app's adopted view sheet only when the angle changes (a property on `#table` would restyle every element on the table at each turn), and an item's `rot` is `--rot` on its element (set only when non-zero). A board's face and SVG don't clip (a turned label may stand past its edge); its image keeps the round corners. Piece faces (label, text, pips, image) stay physical | 2g (amended at the Phase 2 close-out, and after its review) |
| D92 | ⟲ ⟳ (and R / Shift+R) are not offered on a circular piece (round or disc, and `w === h`) whose shown side has no image, label, text or pips: a turn would not show (a checker, a man). An oval turns visibly, so it keeps them | 2g (after the Phase 2 close-out review; the oval after its second review) |
| D93 | The watchdog's backoff (`ct-rejoin`) is cleared only once a guest is back with its host (or, for the host, once nothing starves), not on the first tick that doesn't starve yet; a guest that keeps its paused table (`keepPaused`, guests only) keeps when it last saw the host too, so its next page counts the absence on: the reloads come 40 s, 80 s, then 2 min apart, and the notice says how long the host has been away. For its first `RELAY_GRACE_MS` (10 s) a page whose relays have not opened yet says the table is paused, not "Connection lost" | app.js's signalling watchdog, outside the phase sections (after the Phase 2 close-out review) |
| D94 | A host's save never starts sooner than `SAVE_DEFER_MS` (250 ms) after the change that asked for it (still at most one a second), but a page's first save starts at once (it puts the table in storage for a host who leaves right away: pagehide's own save may not commit): run in the change's own burst of work, after its broadcast and redraw, the save of a 1,000-item table took 2.4 ms median and up to 11.5 ms under load, against 1.9 ms deferred; B6 now measures this unthrottled path too | 1h (after the Phase 2 close-out review) |
| D95 | Trystero 0.25.3 hands out a pooled offer older than 57 s by an ICE restart that first rolls the unanswered offer back; in Chromium and WebKit (Safari, every iOS browser) the rollback drops the data channel's m-line (Firefox keeps it), so the restart's offer is empty (no `m=`, no ICE ufrag) and the peer that answers it never links. Of two peers the one whose id sorts first offers, so a guest joining or reloading into a room whose host has been open over a minute (or a host reloading beside an old guest) never linked half the time, waiting for the watchdog's reload and another coin toss (the "signalling stall" the harness used to retry, and t-p1-bench B8's flake). `connect()` passes `rtcPolyfill: WholeOffers`, an `RTCPeerConnection` whose `setLocalDescription({type: 'rollback'})` does nothing while there is no remote description, so the restart re-offers the same connection, whole. Trystero 0.26 skips only that restart's rollback of an unanswered offer; `WholeOffers` skips every such rollback, so an offer colliding with ours (glare: Trystero rolls back, then sets the remote offer) is left to `setRemoteDescription`'s implicit rollback. The raw test peers use the very class: `h.rawPage` cuts it from app.js's text (`window.RawRTC`), and fails if it can't. The harness no longer retries a link, nor lets the app's watchdog do so unseen: a watchdog reload, like an uncaught error, on any tab of a player's browser (the page `env.page` opens, or one the test opens later in its context) fails the suite, unless that tab opted out (`watchdogOK`: from the start with `env.page(label, {watchdog: true})`, or set when the test lets it lose its host or relays; `t-harness.js` checks both ways), and t-p1-bench, t-p1-delta and t-p2-hidden fail a link that does not form within 15 s, with what both sides see. t-p2-link chooses each page's id (the first `Math.random()` call picks its first character), so every run covers both who-offers cases: reloads beside a host open for a minute link within 5 s; host reloads beside an old guest within 8 s; no page ever makes an offer without an m-line. Dropped when Trystero is upgraded to 0.26 or later | app.js `connect()`, outside the phase sections (after the Phase 2 close-out's second review; the harness's watch on every tab after its fourth) |
| D96 | While two fingers move the view (a pinch, a twist), the badges keep their turn and their size: the view sheet's badge `--view` and `--bz` are written only when no pinch is on, so the badges move with the table as its pieces do. A rest of the fingers sizes them (`pinchRest`, D102, D103) — so no badge stays swollen to the fit's 3× over the pieces zoomed in on, and a twist alone never resizes them (a rectangle refits as it turns: tested by their exact size alone, a twist on a rectangle drawn small would resize them every half turn). They settle — upright, at the exact size — once the fingers lift (`endPinch` → `layout()`). Board texts still follow every frame (a board holds a few dozen). Not while the fingers move, because a restyle of 1,000 badges in a frame that also moves the table is a long task on the B4 phone at CPU × 2: 50–95 ms on the bench's 6000 × 4000 table, 190–670 ms on an 1800 × 1200 one (with `--bz` written in 25% steps mid-gesture, after the close-out's third review; before D96 the badges' turn paid it every frame of a twist); a resize at a rest or at the lift costs too (a task of 50–100 ms, then a raster of the layer that a move within about 100 ms waits for: D102), but outside the fingers' movement. B4 takes three gestures over 1,000 ×3 stacks, each after one not measured (the table's first turn off its axes, or first zoom that far, redraws its layer once): a half-turn twist and a pinch from the fit to 12× on 6000 × 4000, and a half-turn twist on 1800 × 1200, whose fit — and the badges' exact size — changes by over 25% as it turns. Each: no long task over 50 ms while the fingers move, the rAF p95 of a pan, and no settle task over 150 ms. `--gutter` (the landscape margins' width) is set on the three boxes that use it, not on `#main`: as an inherited property it restyled every element of the table at each frame of a zoom, or of a rectangle's turn (its fit changes as it turns). The B4 gestures are rows of §2k, with the two pinches that pause of D102 | 2g, 2k (after the Phase 2 close-out's second review; the size at a rest after its fourth, amended by D102 after its fifth and D103 after its sixth) |
| D97 | (Amended by D297: `--lmax` sits on the board's `.btexts` layer.) What is drawn in table units stays readable on a table drawn small, and where it belongs: the view sheet's `--bz` (badge growth, at most 3×) also grows 🔒 (which turns upright too), a pile's name (at most 2×) and the selection rings and outlines, a card pile's included (their widths in multiples of `--u`, `1px × --bz`, set once on `.item.selected`). A pile's name is anchored at the pile's centre, turned upright there, then moved down — screen down — past the pile's corners (`--pr`, half its diagonal: `hypot(--cw, --ch) / 2` for a card pile; `kind()` sets a piece pile's) and past its count (which a turned view may bring there): it sits under its pile on every screen, never over it. A board's coordinates grow by at most what their margin holds: `gridSVG` puts `--lmax` on its `.blabels` (the margin over the widest label's box, an em tall and 0.6 em a character wide, whichever way it turns; at least 1, at most 1.6): single letters and digits in draughts' 20-unit margin grow 1.25×, two-digit ranks hardly at all | 2g (amends D91, after the Phase 2 close-out's second review) |
| D98 | The paused table's messages blame the side that failed. Our own side first: with no peers and no open relay, the watchdog's reason is always "no relays reachable" ("Connection is struggling — reconnecting…"), even on a page that is hostless; the hint of a page with no table says "Connecting…" while its relays open (and before it joins the room), "Can't reach the signaling relays — reconnecting…" once they never did (`RELAY_GRACE_MS` after the join: D100), "Connection lost" once they dropped, and "Waiting for the host…" only while it can reach the room. The backoff record is the room's (`ct-rejoin-<room>`), and only the page its reload opened trusts it (D100), as only that page takes a kept table's "host last seen": a later visit to the room in that tab (it browsed away, was restored, or a reload landed on the browser's offline page) starts afresh. The hint sits on a plate, centred on the table area, as wide as the middle 60% of the felt (`HINT_FELT`) and no wider than the gap between the seat labels within `HINT_BAND` (75 px: half the tallest plate, 6 lines on a phone held upright) of the middle (`placeSeats`), 140 px at least (`HINT_MIN_W`) — and always as wide as its longest word (`min-width: min-content`), so no text runs past its plate | app.js's signalling watchdog and `updateNet` (amends D93, after the Phase 2 close-out's second review; the plate's floor after its third) |
| D99 | (Amended by D308: what flushSave marks pending is the state itself when it can be.) A host's tab that is hidden (`visibilitychange` to hidden: a phone switching apps or locking, which may suspend and later discard the tab with no `pagehide`) saves at once, as `pagehide` does (`flushSave`: the `ct-pending-<room>` mark, then the save, not `SAVE_DEFER_MS` later). One write at a time still holds for a hidden tab, which lives on: its save waits for the one in flight (`again`); only `pagehide` (`flushSave(true)`) starts one beside it, as the page may not live to see that one end. Neither starts a save when the one in flight already holds the moment (`savingSeq`): closing a tab hides it, then fires `pagehide` | 1h (amends D94, after the Phase 2 close-out's second review; one write at a time after its third) |
| D100 | The watchdog's and the hint's clocks start when the page joins the room (`joinAt`, set in `connect()`), not when it loaded: a first-time player may spend a while on the name dialog first. `RELAY_GRACE_MS`, the watchdog's first 20 s and a guest's "host last seen" (unless a kept table brings the last page's) all count from the join, and before it the hint gives no verdict on the connection ("Connecting…"). The page a watchdog reload opened is told by its navigation's start (`performance.timeOrigin`, within `REJOIN_FRESH_MS`, 5 s, of the record: the toast's 600 ms and the unload), however long it then takes to load: a phone on a struggling network keeps doubling its backoff. Before, a guest 12 s on the dialog was told at once that its relays could not be reached, a new host 25 s on it reloaded at its first tick, and a reload whose page took over 15 s to load started its backoff again at 20 s | app.js's watchdog and `updateNet` (amends D98, after the Phase 2 close-out's third review) |
| D101 | A short screen's watchers' box (§2g) says "every seat is taken" while no named seat is free; opened by a tap, it closes after `WATCH_OPEN_MS` (6 s), on any touch on the table or on another tap. Beside a felt with wide margins it wraps in the right one (`.gutters #watch-box`, `max-width: calc(var(--gutter) − 16px)`), where the notices take the left. `--gutter` is the margin beside the felt as the view shows it — `(W − feltW) / 2`, the felt's bounding width at the view's angle (`layout`) — not `TABLE_W × scale`, which, for a rectangle seen from a side seat, put the notices and the box over the felt | 2g (after the Phase 2 close-out's second review; the margin's width after its third) |
| D102 | A rest of the fingers mid-pinch (D96) is `PINCH_REST_MS`, 300 ms without a move — longer than a hesitation, so a pinch that pauses and goes on writes nothing — and it resizes the badges by their size, not by the zoom: `--bz` changes only when the size called for differs from the badges' own by more than 25% (`BZ_STEP`; the rule as amended is D103's). Held at `BADGE_MAX`, a zoom to 3.46× the fit (1.9× that of the rest before) took the exact size from 3.00 to 2.98, which the zoom's 25% step wrote all the same. Why: a resize costs at a rest too. On the B4 phone (CPU × 2, the bench's 1,000 ×3 stacks on 6000 × 4000) it is a task of 50–100 ms (the restyle and repaint of the 1,000 badges), and then the browser rasters the table's layer again; the next commit waits for that raster (a trace shows the main thread in `WaitForCommitCompletion` while the raster workers run), so fingers that move again within about 100 ms pay one more task: 50–90 ms. With the 120 ms rest of the fourth review's fixes, a pinch that paused 150 ms had a task of 58–166 ms as the fingers moved on, the useless 3.00 → 2.98 write the worst of them; with 300 ms and the size test, 200 ms hesitations write nothing — yet a hesitation alone can let the browser raster the layer again at the new zoom, which the next move waits for: a task of 54 ms in 1 of 22 pinches of four legs, and of 54 and 64 ms in 2 of 30 more at the sixth review, each in the move after a hesitation, with `--bz` unchanged, on gestures already preceded by the same full zoom — and a rest, then a move 20–50 ms after its write, costs tasks of 50–100 ms. The settle at the lift, where it writes, is a task of 50–85 ms (D96 had “no task over 50 ms”: 11 lifts of 24 had one of 50–76 ms). B4 adds two rows on the 6000 × 4000 bench table, each after one not measured: the pinch from the fit to 12× in four legs with 200 ms hesitations (no resize: the check a rest too short fails, as 120 ms does; no task over 150 ms, B4's settle budget, while the fingers are down: a hesitation's raster may pass 50 ms, which its first form, “no long task over 50 ms”, would blame on the app), and with rests of `PINCH_REST_MS` + 50 ms (the size rule at each; no task over 150 ms while the fingers are down: a resize at a rest costs what the settle at the lift does). Neither checks the rAF p95: their moves are the pinch's, their pauses idle frames | 2g, 2k (after the Phase 2 close-out's fifth review; the hesitation's raster and the paused row's budget after its sixth, with D103) |
| D103 | A rest of the fingers (D102) gives the badges the view's exact size (`sizeBadges(scale)`) when that differs from theirs by more than 25% (`BZ_STEP`) and the zoom's size at the fit the fingers landed on (`pinch.fit` × the zoom) does too; else it writes nothing. The first test makes every write exact and visible; the second keeps a twist alone from resizing them, as a twist moves the exact size of a rectangle (by its refit) but never the landing fit's, which stays the badges' own until a zoom moves it. The fifth review's fixes wrote the landing fit's size itself: after a twist with a zoom on a rectangle that refits as it turns, it was off by the whole refit (1.5× on 1800 × 1200 on an iPhone held upright, 1.64× on the tall 1100 × 1800 in landscape) — swollen badges, or text of 5.4 px where 8 px is the floor — and was written even where the exact size had not changed. Writing the exact size on the zoom's 25% step alone, as the fourth review's fixes did, would write changes under a quarter where a twist offsets the zoom. A write after a twist with a zoom can leave the badges apart from the landing fit's size, so a later rest in that gesture may resize them after a twist alone: still to the exact size, and by over 25%. Within 25% of the exact size the badges keep theirs, as they do through any zoom: turned back a quarter from 90° while zooming 1.3× on 1800 × 1200, they keep 2.06 where 2.38 is exact (text of 7.0 px for 8) until the lift. `t-p2-tables` checks it on the tall rectangle in landscape: zoomed 2.5× and turned a quarter, a zoom on to 3.67× rests at 1.31 (1.46 exact; the fifth review's fixes wrote 1.00); from the fit, a quarter turn while zooming by the refit keeps ×3 (they wrote 2.00), and a zoom on to 2.5× rests at the exact 2.14 (they wrote 1.31) | 2g (amends D102, after the Phase 2 close-out's sixth review) |
| D104 | A space's reach covers its drawn rectangle: board-local point p is at distance 0 from a space with both `w` and `h` when p lies inside its `w × h` rectangle about its centre, else at its distance from the centre; the nearest space with distance ≤ `r` wins, and between two rectangles holding p, the nearer centre. A literal centre distance sent a checker dropped on the upper part of backgammon's bar (80 × 980, `r` 200) to point 18 or 19, whose centres lie nearer: the drop the 2B demo makes (t-p2-demos) | 3a (Phase 3A) |
| D105 | A script's `{x, y, free: true}` places a piece with no address (its zones are still read where it lies); an explicit address (`t.move(id, 'map:c3')`, `t.spawn(type, {at: 'map:c3'})`) centres it on that very spot, and gives it that address, even where another board lies on top. A human action never names an address: it carries x, y (and an advisory `to`, which the host overwrites), so the human refusal "🚫 Which board? Say 'tray:bar'" is the tab's, for the CLI's `place` (and any future address input), before anything is sent | 3a, 3c, 3i (Phase 3A) |
| D106 | Addresses follow the boards by signature, not by op: core keeps the structured boards (`tableBoards`) behind a signature of every board's id, type, place, turn, z, side and box; whatever changes it — a move, a turn, a flip, a removal, a table resize, a Worker patch, a Phase 4 group — makes the next read of an address or an index (and every broadcast tick and save) re-read every piece's address and zones by containment, moving nothing (`syncSpots`), and re-send a piece whose address or display form changed. A v4 save's addresses stand on load (one naming no spot is dropped with `console.error`); `MIGRATE[3]` reads a v3 save's by containment | 3a, 3h (Phase 3A) |
| D107 | The display form's `#n` counts the boards of one type **id** across boxes (draughts' and backgammon's `board` number together), so a display form never names two boards; `boardsNamed` takes a board's item id, `typeId` or `typeId#n`. Script-facing zones use the display form too (`t.zones`: `'<zone>'` on the primary board, else `'<board>:<zone>'`), and `t.find({zone})` takes a bare zone id on any board | 3a, 3e (Phase 3A) |
| D108 | Fanning (§3g), as drawn: on a space with a `dir` the pieces run from its far end (a backgammon point's base) toward `dir`, so even a lone checker sits at the base; elsewhere `FAN_STEP` = 6 units apart toward the board's top. The fan is laid out from the public view (`fanAt`: display address → ids), turned with its board, and a press on any member — a tap, a drag, a double-click — takes the top one. The "×k" badge (`.fanb`) is amber, bottom left, joining the view sheet's badge rules (scale and upright turn). Backgammon's doubling cube now waits beside the board, off every space: on the bar's centre it snapped to the bar and fanned in with every checker sent there | 3g (Phase 3A) |
| D109 | Live drags, as built: the host relays a `drag` outside its action queue (no state, no hook: `T.drag` checks ownership and lock quietly and clamps), each item's last live position in a tick only; other screens show it by `translate` (`.item` transitions `translate` as it does left/top, so a drop where the glide was shows no jump), with the dragger's name bulb following it; a committed update of that item, or 1.5 s without news, ends it. A guest's drag queued while it is disconnected is dropped, not sent later | 3c, 3g (Phase 3A) |
| D110 | Script log lines: placements add " to {address}" (a take, pull, play, split or deal onto a spot; `t.spawn`: " on {address}"), removals " from {address}"; aggregation (§3e) treats `locked` and `unlocked` as two ops, sums a run of "used randomness" lines, and names each line in a merged one by the address it had, else its label ("removed 5 pieces: b:A1, b:B1, …"); its noun is pieces, cards, or items when they mix | 3e (Phase 3A) |
| D111 | `t.newBox` takes the game.json format of §4a (`pieces`, `backs`: lists with ids; a board's structure on its piece; a type's name defaults to its id) through `boxFromDef`, keeps its text decks in the box's `decks` ({name: deckId}, Phase 4's field, accepted by `cleanBox` from now on), and finds the same box again by content, its decks' content included: a reset re-running `setup` registers no new box or deck | 3e (Phase 3A) |
| D112 | What snaps, and where, is one rule (`core.js` `snapTo` and `snapAt`, pure): the host's `place`, the page's snap preview and `__ct.snap`, the CLI's `place` and containment all ask it. A piece is centred on the spot in reach of its (clamped) centre even where that puts it past the playing area's margin — a board's edge spot lies on the board, in reach of a point inside the area; the old final clamp moved such a piece off-centre and took its address, while the preview promised the spot and a later re-read gave it back. **Dice never snap** (`snaps`: neither a board, D22, nor a die): a die set down on a backgammon point joined the checkers' fan, counted in their ×k and, on top, took every press there; it also keeps B9's roll of 20 dice lying on a board within 3 KB per peer (2,884 B, the original fixture again) | 3a (Phase 3A fix-up) |
| D113 | Amends D106: a board change re-reads the address and zones of the pieces it concerns — those whose centre lies on a board that changed, where it was or where it is, or addressed on one; after a table resize, all — so an explicit address under a newer board (D105) stands until a board under that piece changes, not whenever any board anywhere does. And the re-read comes before ANY read of an address: `act` runs it before `prepare` (a.from), and every log line, `t.item`/`t.items`, `t.where` and the indexes read through it (`addrNow`); in a tick that touched a board, `tableBoards` is re-signed at every read (a board is touched before it changes) | 3a (Phase 3A fix-up) |
| D114 | Amends §3c's pull decision: a pull's draw (`drawFrom`) is kept, host-only and unsaved, until a pull takes it (or the member leaves the bag); a veto or a refusal leaves the bag unchanged AND that member pending, so the next pull of that bag — anyone's, a script's too — takes it. A pull's a.to is where the drawn member lands by its own size; had a veto redrawn, a guest could aim her pulls where only the size she wants snaps and, under any script that vetoes pulls landing on no spot, fish the bag for it (2,000 aimed pulls took all 10 large tiles of 50). Refusing pulls now never draws again; what is left is that a veto keyed on a.to can tell her the pending member's size class, never choose it | 3c (Phase 3A fix-up) |
| D115 | A press on a crowded spot (a tap, a drag, a double-click) takes its topmost piece that this player may move (`mayTouch`, not locked), else its top piece (amends D108 and §3g's "selects the top piece"); backgammon's bar fans from its top end down and the trays from their outer ends (`dir`), so a checker of each colour sent to the bar shows, and each player takes their own from under the other's | 3g (Phase 3A fix-up) |
| D116 | A spot's fan lays out, from the spot's centre, only the members centred on it (as the state keeps every snapped piece); a member read onto it by containment while off its centre — a board moved under it, a v3 save's spread checkers — is drawn where it lies and counted in ×k (fanned from its own place, a Phase 2 backgammon save drew its checkers off the board). A guest's drop is drawn at the preview's slot (its place in the fan) until the host confirms, not at the spot's centre first. A live glide's end runs out on `translate` alone (FLIP: left/top jump to the new place, translated back to where the glide is): `left/top`'s main-thread transition started a frame after the composited `translate` one, a step back of half a man, and laid the item out every frame (amends D109). An address alone (a board moved) redraws no item | 3g (Phase 3A fix-up) |
| D117 | Only the host sets an action's `to`, `from`, `pick` and `handled`: whatever a payload says of them is dropped at the top of `act`, on every action (an `owner`'s `to` excepted: it names the new owner, §2c — 3B's frozen copy must keep the two apart), so no hook ever sees a client's claim; a `deal` from a pile of pieces is prepared like `take` (a.to for the prospective piece, by its back's size when dealt face down) | 3c, 3e (Phase 3A fix-up) |
| D118 | A group drag's shift is cut so that every relayed member lands on the table (`clampShift`): on a rectangle each axis to the range all members allow (the group slides along the edge, keeping its shape); on a round table the shift is shortened along its direction until every centre is within `playR`. The old clamp of the shift to ±the table's size relayed members off the table | 3c (Phase 3A fix-up) |
| D119 | Amends D112 for the table's own pulls: a table change (`setTable`) and a host's resume clamp the items through one helper (`pullOn`): every item shifted with the table's centre, the boards first, each clamped onto the playing area — but a piece that would then sit centred on its own spot (`snapTo` with its address, the boards already in place) stays there, as snapping put it, even past the area's margin. A piece whose board was pulled in harder is only clamped, and every address is read again by containment (D113). A new felt alone (same shape and size) moves and re-sends nothing. Before, a host reload or any table change silently pulled an edge-spot piece off its spot's centre, so a save did not resume as saved | 3a, 3h (Phase 3A second fix-up) |
| D120 | Amends D116 and D115: a spot fans ALL its members as soon as one of them lies centred on it — off-centre ones too, in z order from the base — so a piece put on a point of a v3 save (or anywhere containment gathered pieces) is never drawn over one already there; Phase 2's spread equals the fan's slots, so its checkers stay put and the fan just closes up under a gap. A spot with no centred member draws each where it lies (D116). A press takes the fan's topmost piece this player may move only when the pressed piece is drawn in a fan; a piece drawn where it lies (off its spot's centre, or alone) is the piece pressed. The preview's slot is the dragged piece's place on top of that whole fan | 3g (Phase 3A second fix-up) |
| D121 | A player's own parts while the rules are off: their asks and hint are sent only while the rules are on (`partsOf`: the ask UI and the highlights belong to a running script, and `answer` is refused while it is off — no ask is pending as far as the engine knows); their `t.secret` entry is sent whatever the state of the rules, like a hand (a game disabled by a script error must not hide a player's secret role). Asks and secrets stay in `rules` either way, so a re-enable that keeps the state brings the asks back; hints start afresh on every Enable | 3b, 3d (Phase 3B) |
| D122 | The engine's gates (`t.data` ≤ `DATA_MAX_CHARS`, `t.secret`'s keys and sizes, the asks through `cleanAsk`) run at the checkpoint as well as at the end of a job: a `handle` or `validate` that broke them fails CLOSED (nothing of the action applies: "a validate() that outgrew t.data fails like one that threw", Phase 1), and a later hook that did is undone back to the checkpoint. A failure names the hooks it undoes ("onButton(), onAction(), buttons(): t.data is too large …"). Every hook after the checkpoint reverts to that one checkpoint, as §3f.4's pseudo-code says, `buttons()` included (its failure undoes the `onAction` before it too). The journal's snapshot at the job's start makes a ruled action serialize `t.data` three times on the page (the start, the checkpoint, the end) where Phase 1 did twice; in a Worker, `guard()`'s comparison hands its JSON to the job's start, so the guard costs nothing more | 3f.4, 1e (Phase 3B) |
| D123 | `_join` is the registration's job; binding the seat key stays outside it, on the host, synchronous (`T.bindKey`: the app checks a key and binds it in the same step, so two claims of one seat can't both pass, and keys never reach a Worker). `T.join(p, name, key)` is both: the binding, then a `_join` only when the player is new, offline or nameless (an action from a seated, online player registers nothing). `_name` is `name`, chat flood control included | 3c (Phase 3B) |
| D124 | A pull's pending draw (D114) is kept by what the member is (`type|face|side`) and where it was (its index), not by reference: a rollback puts back a copy of the bag, and two members alike are one and the same draw. A vetoed pull's member is still the bag's next pull | 3c (Phase 3B, amends D114) |
| D125 | The live facade is the runner's (`scriptHooks`): the script gets a copy of `t` whose methods work only while one of its hooks runs; a call from anywhere else throws "t.{name} was called outside a hook — rules hooks must be synchronous" and is remembered (`stray()`), and the next job disables the rules (`guard()` in a Worker; on the page, `apply` runs `_rulesOff` with that reason). `T.api` itself stays a plain facade: the host's code and the Node tests drive a table through it. The getters (`t.data`, `t.public`, `t.secret`) are not guarded — a stray write through them is what `guard()`'s JSON comparison catches | 3f.7 (Phase 3B) |
| D126 | A StatePatch holds the table's own objects (items, players, `rules.data` …), not copies: a Worker's `postMessage` copies it, and refuses one holding a function (a `DataCloneError`, which the Worker must treat as the script's failure); a test copies it before applying it to another table. Boxes travel as catalog records `{box, src, by?}` (a script's box is `src: 'script'`), decks as decks; both are gated again on the host | 3f.2, 3f.6 (Phase 3B) |
| D127 | An ask's shape, beyond §3a: `among` only with `pick: 'item'` or `'space'` (required there), `count` only with `'hand'` (1 by default), `min` and `max` only with `'number'` (required there); an option's value is JSON of at most 2,000 chars (`MAX_META_CHARS`); `t.ask` and `t.hint` name a player at the table, or throw. `t.ask` turns a space pick's `among` into display forms (an address no board has throws), and `t.hint` keeps its spaces in display form and drops, with a `console.warn`, items no longer on the table | 3a, 3e (Phase 3B) |
| D128 | The host's queue around the Worker (`app.js`): one FIFO whose job in flight (`current`) is a job posted to the Worker or a Worker starting; with the rules off, a job still runs at once, in the caller's task. A guest's seat key binds on receipt (D123) and its registration is a queued `_join` (one at a time per player: none is queued while one waits); `hello`, `snap` and `need` are answered on receipt and never queued (they change nothing, and would cost a Worker round trip each); `_refuse` (re-sends) runs on the host table, a re-send being no state change. A guest's action finding `MAX_QUEUE` jobs waiting is refused ("🚫 The table is busy — try again", console.warn) and what it named re-sent; the host's own and internal jobs always queue. Each job's `done` is applied, committed and, for the host's own action, broadcast at once; `perf.lastRulesRoundtripMs` is taken before that broadcast. A job's end reads every address again (`syncSpots`), so a Worker's patch carries what a board's change moved and the host never derives an address outside a patch | 3f.5, 3f.6 (Phase 3B) |
| D129 | A job whose patch the Worker can't post (`DataCloneError`: `t.data` or `t.public` holds a function, which JSON — and so the engine's gates — skips) is the script's failure, as D126 says, and it keeps the page era's outcome: in the same `done`, the Worker runs core's `unsaveable` on its mirror (the rules off, both fields cut to their JSON part, "error in t.data / t.public: they hold a value that can't be saved (…) — keep them JSON"), merging that patch into the job's. The host's state then only ever holds structured clones, so the host's `_unsaveable` job (a save's DataCloneError) is gone | 3f.2, 3f.7 (Phase 3B, amends D126) |
| D130 | What ends a Worker, and how it is said. A `fatal` (an uncaught error or rejection in the Worker, a stray facade call, `t.data` changed outside a hook), an `error` or `messageerror` event: "the script crashed: {message}" — log, `lastRulesError`, the toast "Rules disabled — the script crashed: …"; the job in flight is dropped exactly as the watchdog drops it ("🚫 The rules stopped responding — your action was not applied", what it named re-sent). While a Worker starts, any failure — `evalError`, `fatal`, an `error` event (a module that doesn't load), a Worker that can't be constructed ("this browser can't run rules scripts (module workers unsupported)"), RULES_INIT_MS of visible time — is that start's `evalError`: an Enable fails with the running rules unchanged, a resume switches the saved rules off. A done after which the rules are off (a hook failed) ends the Worker too: rules on ⇔ a Worker runs or starts. The watchdog's late re-arm (a timer over 1 s late) is given once per job; a box setup's budget counts `countSetup` with one seat per player | 3f.5, 3f.8 (Phase 3B) |
| D131 | Hardening that a browser refuses (a non-configurable global) is said with `console.error` and the Worker goes on: it is defence in depth, and the rules must still run there. `requestAnimationFrame` is stubbed with the timers. The Worker answers its messages one at a time (a job awaits its `drain()` before the next message is read), so a `digest` request is answered after exactly the jobs posted before it. Test builds (`CARDTABLE_TEST`): the host table's `T.apply` throws while a Worker runs (the one-writer rule), the host's digest is compared with the Worker's every 50 jobs, and `__ct` gains `workerDigest()`, `digest()`, `lastRulesError`, `jobs()` and the Worker counters in `perf` | 3f.1, 3f.3, 3f.7 (Phase 3B) |
| D132 | Amends D128: the host takes a Worker's addresses as read. `applyStatePatch` puts the catalog first, then the boards, then the other items (each piece's zones read against the patched boards), and then adopts the boards as the Worker read them (`spotTB`, `spotSig`, `respot`) — no re-read by containment on the host, not even after a table patch (the Worker's end-of-job `syncSpots` already re-read, recorded and shipped every piece a board's or the table's change concerned). The host syncs its addresses before a Worker copies its state (`T.syncSpots`, exported). Before, the host re-read by containment against the boards as they were before the job (all pieces after a table patch, a new felt included), so a piece placed free, or given an explicit address under a newer board (D105), got another `at` on the host than in the Worker — broadcast, saved, and handed to the next Worker | 3f.3, 3f.6 (Phase 3B fix-up) |
| D133 | The engine's gates refuse what JSON would change on its way through a rollback, a save or a patch (`notJSON`): in `t.data` and `t.public` when their JSON changed in the job — a typed array, `ArrayBuffer`, `Map`, `Set`, `Date`, a class instance, a non-finite number — and in every `t.secret` entry, every job, a function or symbol too (a function JSON skips leaves the JSON unchanged, so a JSON comparison never sees it). The hook fails, naming the value ("onAction(): t.data.board is a Uint8Array, not JSON — …"). A function in `t.data` or `t.public` stays D129's (the Worker can't post it: the rules go off, keeping the JSON part), which keeps the page era's outcome for it; `unsaveable` cuts `t.secret` to its JSON part too | 3a, 3e, 3f.4 (Phase 3B fix-up; amends D129) |
| D134 | Amends D130 — what a stop of the rules keeps. (1) An internal `_join`, `_leave` or `_name` in flight when the watchdog fires or the Worker crashes is not dropped: it runs again on the host's table once `_rulesOff` has applied (no hook: the rules are off), as the atomicity table keeps the registration when `onJoin` or `onLeave` fails; nobody is told an action was dropped. A player's action and `_tick` are dropped as before. (2) The watchdog of a Worker that is starting is its own: a crash of the running rules meanwhile (a late rejection) touches only a job's watchdog. (3) A Worker that starts for an Enable began from a copy of the table: when the running rules stop meanwhile (their `_rulesOff` changes the table under it), the candidate is ended and the start begins again from the table as it now is, with a fresh init budget. Before, the start's init watchdog was cancelled (a top level that never ended blocked the queue for good) and the new rules' patch, from a mirror still marked on, left the host's rules off after "«New» enabled". The test build's one-writer assertion covers a Worker starting too | 3f.5, 3f.8 (Phase 3B fix-up) |
| D135 | Amends D124: a rollback puts back the pending draw a pull it undoes took — `opPull` records the entry it deletes in the journal frame (`taken`), `restore` sets it again (the first, when several) — while draws made since stay pending. A script's `handle` that pulls the drawn member itself and then vetoes (or throws) leaves that member the bag's next pull, so it can't become the bag-fishing oracle D114 closed | 3c, 3f.4 (Phase 3B fix-up) |
| D136 | Amends D130's wording: a Worker's `fatal` carries a message, never a stack (the Worker logs the error whole in its own console), and says whether it is the engine's own words (`engine`: a broken rule of running — "t.say was called outside a hook …", "the script changed t.data outside a hook", "the script dispatched a message to its own Worker"). The public log line is "rules disabled — the script crashed", followed by the message only when it is the engine's; the host's toast ("Rules disabled — the script crashed: {message}") and the 📜 dialog (`lastRulesError` "the script crashed: {message}") always carry it. A script's own words — an error it let escape, a rejection's reason — stay with the host, as a hook's failure keeps its message from the public line ("script error in onAction()") | 3f.5 (Phase 3B fix-up) |
| D137 | An Enable evaluates the script once: the Worker's init loads it under the start's budget (RULES_INIT_MS), and the Enable's `setRules` job, in that same fresh Worker, reuses it (a `load` of the same code returns its name). Before, the job evaluated it again under a job's 4 s, so a top level of 4–10 s passed init, then failed the job after the running rules were already replaced | 3f.8 (Phase 3B fix-up) |
| D138 | Amends §3f.8 step 5: saved rules that can't start on a host's resume for a reason that isn't the script's — a version mismatch, a Worker that didn't load (an `error` event while starting) or can't be made — are switched off on that page (`_rulesOff`, as before) but stay on in the save (`rulesHeld`: `snap` writes `enabled: true`), so the reload the toast asks for ("Card Table was updated — reload this page to run rules"; "Saved rules failed to load: … — reload this page to try again") runs them again; the host's next Enable or Disable ends that. A script that fails to evaluate is switched off in the save too, as before | 3f.8, 3h (Phase 3B fix-up) |
| D139 | A Worker's mirror starts equal to the host's state, hints included: `createTable(…, {mirror: true})` (rules-worker.js init) skips the load gates' dropping of `rules.hints` (`gateRules(r, live)`; they still run, and are idempotent on a host's state). D121's "hints start afresh on every Enable" then reaches the host: the Enable's `hints: {}` differs from the mirror's start, so the patch carries it. Before, the mirror started without hints, the patch left them out, and the host kept sending a player a hint no script had set, which their next action could not clear — the digests apart for good | 3d, 3f.3 (Phase 3B fix-up) |
| D140 | Amends §3f.7's hardening, and D131. The Worker reads only trusted messages (`isTrusted`, which a script can't forge): a `MessageEvent` a script makes and dispatches to its own Worker is a fatal ("the script dispatched a message to its own Worker"), never a job — before, a script could have its Worker run an action as another player under the id of the host's next job. It reads a message's `data` through the getter captured before any script ran, registers its own listeners first and in the capture phase, captures `Promise`, and freezes `Promise.prototype`, `Event.prototype`, `MessageEvent.prototype` and `EventTarget.prototype`. It also takes away `WebSocketStream`, `FontFace` and `fonts` (both reach URLs), the `webkit…` file system, `navigator.storage` (OPFS: origin-wide, shared with every page of the site), `navigator.storageBuckets` and `navigator.locks`, and stubs `close` (which ended the Worker silently: the host waited out the watchdog). On the host, a `done` for a job not in flight ends the rules ("the script crashed: its Worker ran a job the host never sent"): the mirror can't be trusted after it. Dynamic `import()` stays the one documented way out | 3f.7, 3j (Phase 3B fix-up) |
| D141 | Amends D128 — presence and refusals. Whether a keyed message queues a `_join` is decided by what the queue will leave: the last presence job queued or in flight for that player (`lastPresence`); a `_leave` waiting means they are back, so a `_join` follows it, whatever the committed state says (a reconnect while the old connection's `_leave` waited behind a slow hook left the player offline for good). An action refused before it ran (flood control, a full queue) re-sends what it named at once, outside the queue (`T.refreshFor`: no state change, its own flood bucket), so a guest's flood can't grow the host's queue while a hook holds it; the `_refuse` job is gone | 3c, 3f.5 (Phase 3B fix-up) |
| D142 | `applyStatePatch` checks the rules' state a patch brings again, in the host's realm (a script shares the Worker's realm, so the Worker's own gates are only as sound as the built-ins it left alone): every `t.secret` key and value (secretProblem), the asks (cleanAsk, ASK_MAX, player ids, one id once), the hints (player ids, ≤ HINT_MAX short strings), `t.data`'s size and its `_timers`. A failure throws before anything is applied, and the app ends the rules ("the host could not apply the script's changes: …"). The secret map is stored without a prototype on the host too | 3a, 3f.6, 3j (Phase 3B fix-up) |
| D143 | `select` keeps §2c's narrow `hiddenFrom` (a face-down piece or supply), as §3c says: a face-down card, a pile whose top is face down, and a bag may be selected. Refusing them would refuse a deck pile — a natural target for "draw here" highlights — and a hint about a card is the script's choice (§3d); D72's concern, a piece's mobility telling its rank, is about pieces. Recorded after the 3B review, which proposed the wider rule | 3c, 3d (Phase 3B fix-up) |
| D144 | Amends D140, D142, D133 and D134 after the second 3B review. (1) A script shares the Worker's realm with the engine, so it can replace a built-in the engine calls (`Array.prototype.push`, `Function.prototype.call`, an `Object.prototype` setter) and rewrite what the engine writes there. The Worker reads each host message with the `data` getter and `Reflect.apply` it kept before any script ran (before, `dataOf.call(e)`: a replaced `call` re-addressed the host's own move to Bob). The robust half is on the host: `applyStatePatch(patch, out, job)` checks, in the host's realm, who the patch speaks for (`speakerProblem`) — every log line and every name bulb (`fx`) is `job.p`'s or RULES'; a chat line (`c`) only in a `chat` job, by `job.p`, once, exactly the line the host makes of `a.msg` (`chatLine`); a frozen name (`n`) only on a `name`/`_name` job's line by `job.p`, equal to the name `job.p` had — and that `t.data` / `t.public` in a patch are plain JSON (`notJSON`; a structured clone carries a `Map`, a `Date`, a cycle). A failure throws before anything applies: the rules end ("the host could not apply the script's changes: …"). What the job's other lines say stays the Worker's account (the rules' own lines say anything already). (2) The value gate (`valueProblem`: `notJSON` on `t.data` and `t.public`, `secretProblem` on every `t.secret` entry) runs on every job with the rules on, not only when a field's JSON changed: a `Date` over its own ISO string, a `Map` over `{}`, `NaN` or `-Infinity` over `null` fail the hook too (before, the mirror kept them while the host held the JSON value, and the digest couldn't tell). `notJSON` names the path only once it found a bad value (its cost is now about one `JSON.stringify` of the field). (3) `guard()` runs the same value gate after its JSON comparison: a write outside a hook that JSON can't see (a function into `t.secret`, a `Date` over its text) is its own fatal, "the script changed t.secret outside a hook (t.secret[…] is a function, not JSON)", not the next job's hook failure. (4) A patch the host refuses ends the rules with the job still in flight (`done` hands it to `rulesDown`): a `_join`, `_leave` or `_name` in it runs again with the rules off (D134), a player's action is dropped with the notice and its re-send, as on the watchdog's and a crash's paths (before, `done` cleared the job first: a departure was lost — a ghost at the table — and the actor never told) | 3f.4, 3f.6, 3f.7, 3j (Phase 3B second fix-up) |
| D145 | Amends D140, D142, D144, D131 and D136 after the third 3B review. (1) **The lockdown.** A script shared the Worker's realm with the engine, so a built-in it replaced (`Object.entries`, an `Object.prototype` getter or setter, `Array.prototype.push`) let it reach the engine's live player objects and the patch itself: swap Alice's and Bob's names (every log row shows a speaker's current name), add a player, rewrite `rules.code` (guests' 📜 view and the next resume then show a benign script), or reword the acting player's own line. Before any script is evaluated, `rules-worker.js` now freezes every built-in the engine calls — the language's (`BUILTINS`), `console`, `crypto`, `structuredClone`, the event classes, and the intrinsics the syntax reaches without a name (the array, Map, Set, string and RegExp iterators, `%IteratorPrototype%`, the generator and async function prototypes, `%TypedArray%`, the iterator helpers) — all the way down, and fixes the global names that hold them; the properties a script commonly sets on its own objects (`constructor`, `toString`, `valueOf`, …, a function's `call` / `apply` / `bind`, an error's `name` and `message`) become accessors that define the object's own property on assignment (the override mistake, SES's workaround), so `class E extends Error { … this.name = 'E' }` and `o.toString = …` still work. Checked in Chromium, WebKit and Firefox: every replacement throws a `TypeError`; a bare Worker starts in 25–80 ms, and B15 (1,000 cards and the CAH decks) stays at 36–47 ms in Chromium, with B12's Worker share unchanged (0.2 ms). (2) **An allowlist of globals** replaces the list of what goes: every name on the global scope and its prototypes that is neither the language's nor on a reviewed platform list is deleted — so `navigator.serviceWorker` (Safari and Firefox expose it in a Worker: a script could unregister every PWA's service worker on the shared origin), `scheduler.postTask` (a real timer), `Notification`, `navigator.usb` / `hid` / `serial` / `permissions`, and whatever a browser adds next are gone; `navigator` is a frozen object of five plain values; `scheduler.postTask` throws the timers' message. The page APIs (`document`, `alert`, `localStorage`, `sessionStorage`) are values whose every use throws their message (a Proxy over a throwing function), never getters that throw: WebKit's inspector reads `document` off a Worker's global scope when it logs, and a throw there took the page down (this predates the review; found while checking the lockdown in WebKit). (3) **The host checks every field** (`checkPatch`, 3f.6 step 0) and refuses the patch whole, nothing applied before every check passed (a refused patch used to leave its items, decks and boxes on the table): shapes as the engine writes them in every build (`itemProblem`, `playerProblem`; `env.test` is gone), and against the job — players (a new one only in its own `_join`; a name only by its own rename, to that name; a colour never; online only by its own `_join` / `_leave`), the rules (`RULES_STATE`, `code`, `name`, `enabled` only; code and name only in the host's enabling `setRules`, that code; on only there, off only with `out.error`, a Disable or `_rulesOff`), the catalog (new ids only, a box's `src` and `by`), the counters (only growing, within bounds; `guestDeckChars` only by a guest's `addDeck`), `lastSetup` (a box), log lines (`logEvent`'s fields, LOG_TXT_MAX, no bucket over its cap, a frozen name once in a rename, a line on the record only in a peek), the effects (each type's fields; a peek's answer only in the actor's own peek), `out.error`. The asks are kept as `cleanAsk` leaves them, and a hint has only its two lists. (4) **The guard's words are the engine's.** `guard()` returns `{why, detail}`: `why` is fixed text ("the script changed t.data outside a hook", "…t.secret…", "the script left its state unserializable outside a hook"), which the public log may carry (D136); `detail` — the value and the script's own key path, a cycle's message — goes to the host in `fatal.detail`, and app.js shows it in the toast and the 📜 dialog only (the second fix-up had put the path, which may name a hidden card, in everyone's log). (5) `done()`: the job's effects, the host's flush and the digest check run in one try — a failure resolves the job `{ok: false, error}` and the queue goes on; `commit()` broadcasts and saves a changed table even when carrying out an effect throws. (6) A saved item or player that `itemProblem` / `playerProblem` refuses is dropped on load, with `console.error` (one bad record no longer keeps a table from starting: 'Failed to start' on every reload). (7) The trust model reads as it did: a script can't make the host apply an action as another player, sign another player's name or reword their line, change who a player is, or send one player's ask, hint or secret to another; it is still trusted with every hidden card | 3f.6, 3f.7, 3j (Phase 3B third fix-up) |
| D146 | Amends D133 and D144: `notJSON` finds what JSON would change that a walk by keys missed — an array's hole (`new Array(64)`: "t.data.board[0] is a hole, not JSON (JSON writes null) — fill the array") or `undefined` in it, a property that isn't an index (`moves.turn = …`, a `Date` hung on an array: the second fix-up's index walk had stopped seeing it), and a non-enumerable or symbol-keyed property (a structured clone drops it, a rollback's `JSON.parse` loses it). A getter is read as its value, as JSON and a clone read it — checking each property's descriptor would double the gate's cost, and one whose value moves outside a hook is `guard()`'s. The walk costs about 1.6 `JSON.stringify` of the field, 1.8 times the second fix-up's (39 KB: 0.30 ms; 1 MB: 11 ms in Node), on every job with the rules on, in the Worker. A function in `t.data` or `t.public` fails the gate when that field's JSON is as it was when the job began (the patch won't carry it, so D129's failed post can't fire in the job that wrote it), and `guard()` refuses any function there that the last job's patch won't carry (one in a field the patch carries, the guard after the job's microtasks leaves to the post, which fails: D129 keeps the case where the JSON changed too, its `t.data` kept as JSON) | 3a, 3f.4, 3f.7 (Phase 3B third fix-up) |
| D147 | What a job sends the host is bounded by the engine itself: `commit` trims the patch's log lines to what the log keeps (`trimLog`: the host would trim the rest away), so 2,000 `t.say` calls in one hook send 200 lines, not 2,000; `logEvent` cuts a line, `notify` a notice and the engine's toasts at LOG_TXT_MAX (1,000 characters), and a veto's reason is cut at 300 (a script's words, as `t.say`'s). The host refuses more (3f.6 step 0). A `done` is deserialized before the host can look at it, so its size can't be capped on the host; with the lockdown a script can no longer forge a larger one | 3f.2, 3f.6 (Phase 3B third fix-up) |
| D148 | Amends D145, D144 and D140 after the fourth 3B review. **The engine's own modules are locked down too.** A dynamic `import()` of the engine's URL (`/cardtable/core.js?v=1`) hands a script the very module instance its Worker runs, and D145 froze only the built-ins: a script could define a `Symbol.replace` of its own on core.js's exported `CTRL` regex and make every `str()` and `cleanDeck` in the Worker return its words — a guest's "added deck" line, and the deck itself (its name, its cards), rewritten before anyone received them — or `RULED_ACTIONS.add('chat')` and veto other players' chat. The lockdown now also hardens every export of `core.js`, `grid.js` and `templates.js` (`import * as` each, by the URLs core.js imports them by): objects and functions frozen all the way down, a global or sticky regex (`CTRL`, `CTRL_NL`) made non-extensible (its `lastIndex` must stay writable), and the lists the engine reads (`RULED_ACTIONS`, `STRICT_ACTIONS`, `PUBLIC_ACTIONS`, `HOST_ACTIONS`, `RANKS`, `SUITS`, `IMG_MIMES`) are frozen arrays, not Sets — a frozen Set still takes `Set.prototype.add.call`. core-p3 checks that no export holds a Set, a Map, a Date or a typed array; the Worker says one it meets. The Worker no longer keeps its own `Reflect.apply`, `data` getter and `Promise` (D144): those are frozen built-ins before any script runs. Every data property of `Object.prototype` (not seven picked ones) is overridable: since D145 a tally keyed by what players type threw on `tally['__lookupGetter__'] = 1`. On the host, a second layer where it can tell: in an `addDeck` job whose patch has a line in the guest's name, that line must read `added deck "{name}" ({n} cards)` and the patch must carry that deck, both exactly as `cleanDeck(a.deck)` makes them in the host's realm ("the script rewrote Bob's deck"). What the acting player's other lines say stays the Worker's account (the host checks whom each speaks for: D144); that a script can't reword them rests on the lockdown | 3f.6, 3f.7, 3j (Phase 3B fourth fix-up) |
| D149 | The effects of a Worker's job are rebuilt on the host from the fields the engine writes (`checkPatch`'s `EFFECTS`: a marker `{p, id, x, y, roll?}` with ids as text, a banner `{msg}`, a notice `{p, msg}`, a peek `{p, c: {d, i} or {t, f}}`, a toast), and only those copies are carried out. Before, the check read a marker's `p`, `x` and `y` and passed the rest on: a lying Worker's `{t: 'fx', f: {p, x, y, live: true}}` reached the broadcast tick, whose `liveFx` read the missing `ids` and threw on every tick after — no screen updated again, every action of the host's resolved as failed, the rules stayed on. The broadcast tick now also takes its marker and banner queues before reading them, so a tick that throws can't leave behind what made it throw. `mark()` writes ids as text, and `apply()` and `refreshFor()` read the items an action names (`id`, `pile`, `onto`, `bag`, `ids`) as text (`textIds`): a guest that named item "12" as the number 12 put it in the indexes (Sets) a second time, and once it left the table, a board move threw on every action after. (A script's facade calls take the ids the facade hands it; one that passes a number confuses only its own Worker's mirror) | 1c, 3f.6 (Phase 3B fourth fix-up) |
| D150 | `Z_MAX = 2^52`: a Worker's patch keeps `zMax` and every item's `z` within it. It allowed up to `MAX_SAFE_INTEGER`, so after a forged `zMax` the next item anyone brought to the top got `z = 2^53`, was saved so, and the load gate dropped it on the next reload. The load no longer judges `z` beyond being finite: a resume past `Z_MAX` renumbers the items 1…n in their order and says so (`console.error`), so even a lie's leftover never costs a card. A patched item's address must be text of at most 100 characters (an object there made every later action on that item throw) | 1a, 3f.6 (Phase 3B fourth fix-up) |
| D151 | An item or a player the load drops (D145 (6)) is said to the host, not only to the console: `resume()`'s toast, which already named unreadable game boxes and pieces without a box, adds "2 saved items and a saved player couldn't be read: dropped" | 3h (Phase 3B fourth fix-up) |
| D152 | The host must take what the honest engine makes. `checkPatch` read a rename's name as `x ? cleanName(x) : ''` while the engine renames with `cleanName(a.name)`, so `{t: 'name', name: 0}` — any guest can send it — renamed Bob "0" in the Worker and made the host refuse the patch: the rules off for everyone, the script blamed. The engine and the check now use one expression each: `cleanName(a.name)` for `name` / `_name`, `joinName(a.name)` (ensurePlayer's: '' for a falsy name) for `_join`. `t.tell(p, msg)` throws a `TypeError` ("t.tell: no player …") unless p is a player at the table, as `t.ask` and `t.hint` do: it queued `{t: 'note', p: undefined}` for `t.tell(t.data.dealer, …)` before there was a dealer, which the host refused as "the script's effects are malformed" — now it is the script's own error, the same on both sides, naming `t.tell`. The (7) digest run adds facade calls with odd arguments (`t.tell(undefined)`, `t.tell(0)`, `t.say(5)`, `t.announce` of an object), renames and joins named 0 or 7, and an action naming an item by a number: the host takes every patch of the honest engine | 3c, 3e, 3f.6 (Phase 3B fourth fix-up) |
| D153 | Amends D146: `notJSON` no longer looks for a property hung on an array (`moves.turn = …`). Finding it took `Reflect.ownKeys` of every array — a list of every index, 4 to 24 times the cost of the JSON itself (400k numbers: 54 ms against `JSON.stringify`'s 2.2), on every job, twice in the Worker and once on the host's main thread — and JSON leaves such a property out as it leaves out an object's `undefined` value, which the gate accepts too. The walk is an index loop for arrays (a hole or `undefined` still fails) and `Object.keys` plus the non-enumerable and symbol checks for records: in Node, 1.1–1.2 `JSON.stringify` of the value for arrays of numbers, 0.8 for records, 0.4 for a list of strings (D146's "about 1.6" held for records alone). One job over 0.8 MB of `t.data` as a flat array of numbers: the Worker's job and drain guard 211 → 18 ms (median), the host's `applyStatePatch` 71 → 6.5 ms; over 1.45 MB of go boards, 110 → 40 ms and 38 → 13 ms | 3a, 3f.4 (Phase 3B fourth fix-up) |
| D154 | Selections, as built: with `view.rules.wants` holding `'select'`, a tap on an item sends `select` — and so does the start of a drag, so the hint shows while the piece is carried (the drop, a ruled action, clears it) — never for a piece whose public view is its back (the host would drop it, §3c). In strict rules that want selections a tap selects for the rules and shows **no action bar**: their game moves by drags, asks and buttons; the bar's buttons are ruled actions such rules refuse unless `handle` takes them, and its place above a piece covered the very squares its hint marks (the first screenshot of the UI suite). The bar's keys (R, F, Space, Delete) go with it; a double-click and a long-press zoom stay | 3g (Phase 3C) |
| D155 | The ask panel takes its own room: `#ask` is a sheet between the table area and the hand bar on every screen (on a wide one a centred card, at most 720 px), never over the table — where a pick must be tapped, and where a floating card covered pieces, seat labels, the turn cue or the watchers depending on the table. The table refits above it, so it covers none of them by construction; the price is a smaller table while an ask is open when the table is fitted to its height (≈9% on a 1280 × 800 desktop, ≈20% on a phone held sideways), which ▾ gives mostly back: it folds the panel to a "❓ Rules ask (N)" chip until another question comes first. A table pick (`item`, `space`) takes the tap while the panel is open (a tap on what isn't offered toasts "Pick one of the highlighted pieces" / "… spots" and selects nothing); a space answers with the spot snapping finds under the tap when offered, else the nearest offered spot within ¾ of its size. An answer sent disables the panel's buttons for 3 s or until the asks change (a refusal re-enables them). Option buttons are 44 px tall on touch, and drawn large when every label is one or two characters (♕ ♖ ♗ ♘) | 3g (Phase 3C) |
| D156 | The hint layer is one element per board in `#table`, positioned and turned as the board (`z-index` 99998, above the pieces, under a dragged piece and the snap preview; `pointer-events: none`), not inside the board's element: there, a piece standing on a hinted spot (a capture) hid its mark. An empty spot gets a translucent disc (radius 0.24 × the spot's size: a cell, or a space's smaller side), an occupied one a ring round the piece (0.47 ×); cyan for a hint, violet for what an open ask offers. `pieces.hintSVG` writes numbers and fixed class names only. Items keep `.hint` / `.offer` (a dashed outline, grown like the selection ring by `--bz`) | 3g (Phase 3C) |
| D157 | A guest's view gates its asks as it gates its hint (`viewAsk` in core.js): an ask from the wire must be shaped as the host sends one — an id, a prompt, and either 1–20 option labels or a pick with its own fields — or it is dropped, with `console.error`; the panel and the terminal show only what passes | 3b, 3g (Phase 3C) |
| D158 | The terminal's asks are the tab's text: the tab writes every ask line (`cliAsk`: "❓ promo: Promote to [0] ♕ [1] ♖ [2] ♗ [3] ♘", and for a pick what to answer), so `asks` is a tab command (its lines come back in `msgs`), and the tab pushes each new ask, a new hint ("💡 hint: …") and a new `t.secret` ("🔒 for you: …") into `msgs` as they arrive — both REPLs print the same words by construction. `answer <id> <value>` sends the value as typed (the Bridge API: as given) and the tab converts it with the panel's own `answerV` — an option's number or label in any case, an offered item's id, an offered spot in any form, hand indices ("0,3" or a list), a number — or says what is offered (`error: <id>: answer …`) and sends nothing. The snapshot's `asks` give a hand pick's `count` (1 when the script left it out) | 3i (Phase 3C) |
| D159 | The secret card sits in a column with the rules' buttons (`#rules-row`, which `placeSeats` lifts above the player's own seat label), above them; its head folds it, and a new text opens it again; it shows `text` (at most 1,000 characters) as pre-wrap text. The 📜 dialog shows a rules error the moment it happens while it is open (`rulesError`), not only when it is opened again | 3g (Phase 3C) |
| D160 | A piece type may ask for its label to read upright on every screen: `upright: true` (cleanBox keeps it only when true, so no existing box changes its canon or its built-in match). pieces.js gives such a shown face's label and text the class `uptext`, which turns them against the view and the item's own turn (`--view`, `--rot`), as D91 turns a board's coordinates; `--view` reaches them through the view sheet's rule 2 (the badges', written at a rest, not every frame of a twist), and on a class of their own, so a change restyles those labels alone — never every piece's `.plabel` (the B4 bench's 600 labelled tokens). Every other face still lies as it lies on the table (D91). Without it Black saw every chess glyph upside down. A hidden piece shows its back, whose rendering this never touches | 2a, 3g (Phase 3C) |
| D161 | (Amended by D285: a face's name comes before its label.) A face may carry a `name` (1–40 characters, never drawn): what the log calls a piece showing that face when it has no label (`pieceName`, `faceLabel`: label, then name, then pips, then its number). A two-sided token without labels — reversi's disc — read "turned Disc to 2"; it reads "turned Light disc to Dark disc on d4". Public box data, like a label | 2a, 3e (Phase 3C) |
| D162 | (Extended by D314 to Draughts and Backgammon.) The demos' tables are taller than wide, with 260 units by each seat's edge (chess and reversi 1000 × 1360, go 9 × 9 1180 × 1620, 19 × 19 1340 × 1780), where §3g said 1300 × 1300 for chess: a phone held upright fits a table to its width, so a narrower table draws the board about 30% larger (0.39 px per unit against 0.30), and the band holds the seat label and, above it, the player's buttons (`#rules-row`), which otherwise lay over the board's edge row on a phone. Go's board keeps a margin of 1.5 cells, where its coordinates stand clear of the stones on the edge lines; its bowls (supplies owned by `seat:black` / `seat:white`) sit in the bands' outer corners, clear of the buttons. The cost: on a phone held sideways the boards are small (pinch to zoom) | 3g (Phase 3C) |
| D163 | How the demos are written: an expression calling a function (its rules object first, its helpers as plain functions below); the pieces on the table are the position, read with `t.find` in every hook (the table and the rules can't drift apart, and a test plants a position by moving pieces); `t.data` holds only what a board can't show; `handle` plays every legal move itself with `t.*` ops and returns `true` (so the log says "📜 Rules moved ♙ e2 → e4"), or returns the reason; `onAction` and `onJoin` keep `public.turn` on the seat of the side to move; after the game a "♻ New game" button (a seated player or the host). Chess: White's outlined glyphs on light round tokens, Black's solid ones on dark (`♟\uFE0E`: iPhones draw a bare ♟ as an emoji); the promotion ask offers the side's own glyphs with the values Q R B N; a draw offer is the opponent's ask (Accept / Decline) and any move lets it lapse; Resign asks for confirmation first; dead positions are judged generally (no pawn, rook or queen, and at most one minor piece or only bishops all on one colour of square), which covers §3g's list and keeps K+B v K+B on opposite colours playing; a repetition key holds the en-passant square only while a capture there is legal (FIDE), and the counts restart at every capture or pawn move | 3g (Phase 3C) |
| D164 | Go as built: a stone is spawned for the bowl's `take` (`t.spawn`, ownerless and locked: a drag on it pans the view, and a forged `move` of it is refused, "A stone stays where it is played"; a reversi disc likewise), ko is the simple positional rule against the position before the opponent's last move (a pass resets it), and a play after two passes resumes the game. A capture is `t.remove` per stone, so §3e's aggregation makes four or more one line (B16: 30 stones, one line) and one to three a line each — AGG_MIN stays 4, as core-p3 checks. `onSelect` on a stone hints its group and liberties (a learner's aid; a tap therefore selects without an action bar, D154). B13 measured 0.3–0.9 ms of Worker time at stone 300 | 3g, 3k (Phase 3C) |
| D165 | Reversi as built: a disc is spawned locked showing its player's face, the closed lines turned with `t.setFace`; a player with no move passes, announced ("Light has no move and passes — Dark plays again"); with neither able to move the counts decide (`t.win`, or an announced draw when equal); each seated player's count is a seat badge; `onSelect` on your own pile on your turn hints the legal squares | 3g (Phase 3C) |
| D166 | 🎲 starts a `clear: true` game (`pickCleared`, shared with the box games) on a table with items or a rules state only once the host agrees, then sends `clear` and `setRules {enabled: true, reset: true}`: a fresh game even over the same one (whose kept `t.data.ready` would otherwise skip setup on an empty table). `clear` is a host action, which no rules may refuse | 3g (Phase 3C) |
| D167 | One call, one line: `t.remove(ids)` and `t.setFace(ids, f)` also take a list, and the lines a list's ops queue become ONE Rules line from two items on ("removed 2 pieces: A1, B1"), standing apart from the run around it; separate calls still merge from AGG_MIN (4) on, as core-p3 checks. A merged turn line whose entries all went between the same two faces names them ("turned 4 pieces from Light disc to Dark disc: d4, …"; "turned 4 pieces: …" otherwise). Go removes a capture with one `t.remove(ids)` and reversi turns a move's discs with one `t.setFace(ids, f)`: the task's "a capture of N stones is ONE log line" for every N (B16's 30 included). Amends D164's one-to-three gap | 3e, 3g, 3k (Phase 3C review) |
| D168 | Amends D148. The Worker deletes `RegExp.prototype.compile` before its lockdown: an Annex B method that rewrites a regex in place, a frozen one's pattern included (it throws on the read-only `lastIndex` only afterwards, in Chromium, WebKit and Firefox alike), so a script that import()ed core.js re-pointed `PID_RE` and turned `CTRL` into `/not /g`, rewording a guest's re-uploaded deck; the engine never calls it. On the host, the addDeck check no longer waits for a line in the player's name: in an `addDeck` job whose patch adds a deck or says anything in that player's name, the patch must add `cleanDeck(a.deck)` (canon-equal) and carry exactly one line in their name, `added deck "{name}" ({n} cards)` — whatever its other lines; a script that handles someone's `addDeck` by adding a deck of its own is refused too. The honest engine always writes that line: `logEvent` never folds it into an identical one before (its options object's `keep`), so a deck added twice in a row passes. t-p3-attack's D148 case calls `compile` and checks the sources | 3f.6, 3f.7, 3j (Phase 3C review) |
| D169 | The demos take the table. 📜 Enable of one of the `clear` games' texts goes through `pickCleared` — the confirm, `clear`, `setRules reset` — unless the rules state is that game's (`scriptName(code)`: re-enabled to go on, or reset by the box): over another game's board the old board stayed primary, the demo's bare addresses were that board's, and go refused every stone as suicide. Each demo's fresh `setup` (no `t.data.ready`) also takes every item not of its own box off the table in one line (`clearOthers`), whatever started it. Go's and reversi's `handle` read an item's type only when it has one (`it?.t?.startsWith`): a card pile or a bag left on the table is refused by strict ("Not a move in this game"), where it threw and switched the rules off for everyone | 3g (Phase 3C review) |
| D170 | A fingertip's reach: a touch press that takes nothing it may drag takes the nearest supply this player may drag, drawn under 44 px, whose centre is within 22 px of it (`TOUCH_REACH`) — go 19 × 19's bowl is 16 px wide on an upright phone, and a press 12 px off it panned the view. Only supplies, the few places every move starts: on a crowded table zoomed out, small pieces everywhere would leave a finger no felt to pan by. Not while an ask's table pick is open (the tap is the pick's) | 3g (Phase 3C review) |
| D171 | What a phone must see is said on its screen, not only in the hidden log: chess announces a check ("Black is in check"), tells the offerer a declined or lapsed draw offer, and refuses the opponent's move during a promotion with its reason ("Black is choosing what the pawn becomes"); go announces a pass ("Black passes — White to play") and, after two in a row, offers Count or a stone, not a third Pass. "♻ New game" is each seated player's and the host's own button (`id: 'new-<pid>'`, `pid`): a watcher has none, and a forged press is the engine's refusal (D163's "a seated player or the host"; t-p3-chess's watcher check is changed to that) | 3g (Phase 3C review) |
| D172 | The screens and the terminal, after play's review. The button row and the secret card above it keep to the room above their spot (`--row-room`, set by `placeSeats`): the card is a column whose text shrinks and scrolls, its head — which folds it — always on screen (a phone held sideways with an ask open and the hand bar shown leaves the table area about 100 px; the card stood 44 px above the screen). The ask panel's ▾ sits in the card's right edge, which the card keeps free, never on a row of its own. An answer's 3 s wait ends when the asks change in any way, not only their first id: the same question asked again under its id works at once (an identical one still waits). The terminal: the tab posts whenever a message waits, so an error repeated in the same words prints at once (the snapshot equal to the last one held it back); `select` says what the host would drop ("the rules take no selections", "that piece is hidden from you", the page's own test); `answer`'s text is an option's label first (any case), then an index — "3" is the option labelled 3 when there is one; a number (the panel's button, the Bridge API's `answer(id, 2)`) is an index | 3g, 3i (Phase 3C review) |
| D173 | The 📜 dialog knows the demos by name (amends D169). Enable goes through `pickCleared` — the confirm, `clear` (the table and the hands), `setRules reset` — with the dialog's own text for any text whose `scriptName` is one of the `clear` games' and that would start afresh: over another rules state, or with Reset ticked over the same game. An edited copy (one comment line added) went straight to setRules, and its setup's `clearOthers` took the table unasked and left the old game's cards in hands; Reset on the running game did the same. A copy saved under a name of its own is a script like any other: its fresh setup still takes the other items off the table unasked (the backstop for every other path, Phase 4's reset included) and leaves the hands — README says so. No facade op discards a hand (`t.takeHand` needs a pile), so `clearOthers` does not try | 3g (Phase 3C second review) |
| D174 | The rules row in a short room (amends D172). The 🔒 card's frame always holds its head: its `min-height` is the head's (a fixed 28 px, 24 on a short screen) and it clips (`overflow: hidden`), where its text spilled out of a frame shrunk under its own head. Room runs out in a fixed order: the card first (`flex-shrink` 1000), its text scrolling, down to its head; then the button box (`flex-shrink` 1, `overflow-y: auto`), down to 30 px — its first row whole — whose further rows a swipe brings. Buttons were `flex: none`: with four or more on two rows (Playwright's iPhone 13 sideways, 750 × 342, an ask open) the card shrank to 2 px and its head lay under the first row, out of reach. The row stays lifted above its player's own label, even beside it in the right margin (t-uxfix UX-4), so a sideways phone with an ask open leaves it about 64 px: the card's head and one row of buttons. A room smaller than that (a view panned so the label sits mid-screen) overflows downward, over the label, never under the toolbar | 3g (Phase 3C second review) |
| D175 | A draw offer withdrawn by the offerer's own move: chess still lets any move end an offer (§3g "an offer lapses when the offerer moves"), and when the mover is the offerer the log says "White moved: the draw offer is withdrawn", the offerer is told "Your move withdrew your draw offer" and the opponent, whose question vanished, the log's words; an offer answered by the opponent's move stays "Your draw offer lapses: Black moved", told to the offerer. It told the offerer "Your draw offer lapses: White moved", their own move named as if the opponent had made it, and the opponent nothing | 3g (Phase 3C second review) |
| D176 | addBox's payload, reconciled with Phase 2's `cleanBox`, `boxFromDef` and the catalog: the box travels in the game.json authoring format (`pieces` and `backs` lists, a board's structure on its piece, `img` the one-face shorthand on a piece or a back); a TransportBox (the wire) carries its images as data URLs in `imgs` and its decks in the upload shape (`cleanDeckV1`), each with the `id` it asks for. The host checks it on receipt, before anything is decoded (`checkTransportBox`: at most MAX_BOX_CHARS of JSON, every image a data URL, the whole box through `boxOfDef` with stand-in image ids and `cleanDeckV1` decks), ingests it outside the queue (`store.ingestBox`: every image through `checkImage` — its real type by its magic bytes, at most 2 MB, its header's size — and hashed; each deck through `ingestDeck`; all at most MAX_BOX_BYTES; an error names "image k" or "deck k («name»)"), and queues `{t: 'addBox', box, cost}` with asset ids and catalog decks, which core reads with `boxOfDef` → `cleanBox`. `boxFromDef` now carries every other field (table, seats, players, lockable, setup, rules, rulesState, meta, imgs), so `t.newBox` and addBox read one format. A box, a deck or a setup item asks for an id of 8 lower-case hex digits (`CATALOG_ID_RE`, what `uid()` mints): guests ignore a catalog entry under any other id. A box may have no piece types when it has a deck (a card game's export) | 4a, 4c, 4j (Phase 4A) |
| D177 | `cleanBox` checks a box's `rulesState` for its shape and size alone (`{data, public, asks, secret}`, each an object, ≤ MAX_RULES_STATE as JSON); its entries pass the §3a gates when they are seeded — `setRules` with `state` (`seedState`): t.data and t.public plain JSON (t.data ≤ DATA_MAX_CHARS, its `_timers` through `gateTimers`), every t.secret entry through `secretProblem`, the asks through `cleanAsk` (ASK_MAX, one id once). A bad entry is dropped there with `console.error` and the host gets one toast ("Some saved game state was invalid and was dropped"); an asks or secret entry keyed by someone who isn't at the table (an "@#k" past the seated players, a pid the export couldn't name) is dropped with the other toast ("Some saved state referred to players who weren't seated; it was dropped") — a player at the table who watches keeps theirs. So a box carrying a forged entry registers, and §4j's attacker case 11 is said on Set up, as §4l asks. `state` is read only for a fresh state (a `reset`, or another game's name); `remap` (old id → new) is put in first, then "@#k" | 4c, 4j (Phase 4A) |
| D178 | The setup grammar, as built (§4a): a `Where` string is an address in §3a's forms that names a spot of one of the box's own board types ("<local>" on any, "<type>[#n]:<local>" on that one; cleanBox refuses any other), read on the table as the entry is laid out (an ambiguous one — a second board of that type, kept by `clear: false` — refuses the setup whole); `{board, at}` is read on the first board of that type this layout placed, which the setup must place; `free: true` (with `[x, y]` only) sets a piece down unsnapped, as an export writes one lying off its spot; `rot` and `lock` go on every placed kind. A `deck` entry is a face-down pile of the whole deck named after it (`shuffle: true` shuffles it); a `pile`'s pieces lie face down when their type has a back (as `t.newPile`), its cards as given; a hand's pieces face up unless `up: false`; `hands` names a seat of the box (its holder) or "#k", never inside forEachSeat. "#k" counts the seated players clockwise from the bottom after the box's seats are set. `lay()` re-reads the addresses as each board lands (`syncSpots`), so an earlier entry's piece takes its spot by containment and a later entry's stands as written | 4a (Phase 4A) |
| D179 | "Every check before the first op", as built: setup and reset run their checks (`setupProblem`: decks in the catalog and their card indices, "#k" against the seated players, the named seats a hand goes to, MAX_SETUP_ITEMS and MAX_ITEMS, hands within MAX_HAND) once the box's table and seats are set — the counts depend on them — inside the job's journal, which every box job opens (`BOX_JOBS`: setup, reset, loadBox, addBox), and `atomic()` rolls the job back to its savepoint on any failure, an address the table doesn't have included: nothing is left, not even a log line, and the actor hears "🚫 Couldn't set up «X»: {why}". `loadBox` keeps its Phase 2 pre-checks and gains the same rollback | 4c (Phase 4A) |
| D180 | Ids on import, as built (§4c): an entry's `id` is used when no item holds it, and the ids the layout mints avoid every id its setup asks for, so a clearing setup (and every reset) never changes one; with `clear: false` an id the table holds is minted anew. addBox keeps the box's and its decks' ids when the catalog (one key space) doesn't hold them, else mints, and puts the new ids into the box's stored `rulesState` at registration; a setup's item remap goes to the rules' seeding (`setRules.remap`). Either is said once (console.warn, and the toast "N ids had to change; a running script that stored them may misbehave"). Content deduplication compares the box as it would be stored before any remap: a box registered under remapped ids no longer matches its own file, so importing that file again registers it once more — rare (an id taken by another box), and harmless | 4c (Phase 4A) |
| D181 | A setup's rules, after it (§4c, §4f): core's setup — or reset, when the rules running are that box's (`rules.box === lastSetup`) — emits `{t: 'enable', box, remap}`, and app.js (`enableBox`) puts the host's own `setRules {enabled, reset: true, code: box.rules, box, remap, state: box.rulesState}` at the head of the queue, so it runs right after the setup commits and before any job that waits; like every Enable it starts a new Worker from the table as the setup left it (§3f.8), where the "@#k" are mapped against the players then seated. The host's `checkPatch` takes an `enable` only in its own setup with `rules: true` naming that box, or a reset of the box whose rules run, and with exactly the remap the setup made (none when it clears; else the ids it asks for that the table held, each now a new item of the patch) | 4c, 4f (Phase 4A) |
| D182 | `rules.box`: an Enable with `box` sets it when that catalog box's rules are this very code; any other Enable leaves it out (a Worker's patch says `box: null`, which the host deletes); a Disable keeps it, and a reset restarts the rules only while they run (§4c). `checkPatch` takes `box` only in the host's Enable, as that box or null | 4a, 4c (Phase 4A) |
| D183 | Where a box comes from is checked on the host (it decides D83's shuffle default): a Worker's patch may add a box with `src: 'host'` only in the host's own loadBox (exactly `cleanBox(a.box)`) or addBox, `src: 'upload'` only in that guest's addBox, by the actor, one box a job; `src: 'script'` (t.newBox) anywhere. An addBox's box is exactly `boxOfDef(a.box)` with its decks under the ids it asked for where they were free and its rulesState remapped to the ids it got, said once in the actor's name ("added the box «X» (N piece types)", kept like an added deck's line); `lastSetup` moves only in the host's setup (to `a.box`), reset or loadBox. Before, a lying Worker could register a guest's box as the host's. addBox's `added` effect names the box it registered or found (the same content: no line, no budget, the notice "That box is already on this table"), and the host's `act()` resolves `{ok, error?, id}` with it (`outcome`) | 4c, 4j (Phase 4A) |
| D184 | All or nothing (§4h), as built: the host's own box's images are written to IndexedDB (`store.stash`, after one GC when storage is full) before its addBox is queued; failing that, the toast "Couldn't store the box's images: storage is full" and nothing is added. A guest's box keeps 1B's rule — nothing of a guest's is persisted before it commits (D45): its images are held once it is on the table and saved with it, within the guests' budget — so a guest whose boxes the rules keep refusing can't fill the host's storage. Images stashed for a box then refused at commit are unreferenced, and the GC's own rules collect them (14 days unused, or the 500 MB cap) | 4h (Phase 4A) |
| D185 | Export, in core (`T.exportBox({rules, state})` → `{box, warnings}`; boxio.js turns it into files): addBox's payload of the table as it stands — the types and backs of every box the position uses (the last one set up first; an id an earlier box took gets "-2", "-3"…; their images in one list), the decks it shows and those boxes' own (a name taken gets " 2"…), the table and named seats, and a setup of every item: the boards first, then the rest, bottom to top, each under its own id, at its top-left — `free` when it lies off the spot snapping would give it, its display address when it is centred on an explicit one under another board (D105) — owners as "seat:<id>" or "#k", a lock where it differs from its kind's default, then the seated players' hands as "#k"; with `rules` the script, with `state` t.data, t.public, the asks and t.secret, every seated pid as "@#k" and the ids of the other boxes merged into it as its own. What can't go — an item whose deck or box is missing, an unseated owner, a watcher's hand — is left out and listed in `warnings`. The result passes `boxOfDef` before it is returned (one setup holds at most MAX_SETUP_ENTRIES entries). A round trip into a fresh room gives the same private state, ids included (core-p4 (4)) | 4c, 4d, 4m (Phase 4A) |
| D186 | PublicBox lives in core (`publicBox`, the boxes channel's and `t.box`'s): the box without setup, rules and rulesState, plus the display fields src, by, builtin and `hasRules` (a guest's 📦 shows the 📜 badge without the code). `t.boxes()` lists `{id, name, src, builtin, types}`; `t.layout(boxId, entries?)` checks its entries against the box (cleanBox) and the table (setupProblem) before any op — a TypeError naming `t.layout` — lays them out as the rules with nothing cleared, mints anew an id the table holds (console.warn) and writes one line, "placed N items of «X»". addBox is ruled and strict-refusable like addDeck (§10.1): a strict game refuses an upload unless its `allow` lists it. A guest's box over the budget it shares with decks: "🚫 Box rejected: this table's budget for guests is full (N kB left) — ask the host to add it" (`boxOverBudget`). A setup's or reset's watchdog budget counts its forEachSeat entries for every player (an upper bound). Test builds add `__ct.hostState()` (the host's state, keys left out) | 4b, 4c, 4e, 4f (Phase 4A) |
| D187 | The `game.json` boxio.js reads (§4a, reconciled with D176's TransportBox, whose `img` is an index into `imgs`): in the file every `img` — a piece's shorthand, a face's, a back's (its shorthand or its `face`) — and a deck's `back` and each card's `file` name a file of the upload, relative to game.json (a leading `./` dropped; a name the upload lacks is an error naming the field and the file). The box's images are numbered in the order the box names them — backs first, then pieces, each face in order — one per file, encoded for its largest use (`BOARD_PX`, 2,048, for a board's faces and the back a board uses; else `PIECE_PX`, 560); a deck's are encoded at 560 for the deck, apart. Each deck is a deck.json manifest (the + Deck dialog's, the same code: `manifestDeck` over `deckOf`), which now also takes a text-only card (`text`, no `name`) and a standard card (`r`, `s`, `c`: an export writes a standard deck so); a deck's `id` passes through. `rules` is read from the upload when it names a file there, or looks like a file name (`*.js` on one line): else it is the code itself. An upload is one `.zip` on its own, or plain files with exactly one `.json`; a zip's game.json lies at its root or in its one top-level folder. A game.json with `cards` and no pieces or decks (a deck.json) and one with `types` (cleanBox's map) in place of `pieces` are said as such | 4a, 4j, 4m (Phase 4A part 2) |
| D188 | The zip and file limits, as built (§4j): `ZIP_MAX_BYTES` (64 MB) on `file.size` before JSZip reads anything; at most `ZIP_MAX_ENTRIES` (2,100); each entry judged by its original name (`unsafeOriginalName`: JSZip 3.8+ resolves `..` in `name`) — `..` or a leading `/` refuses the zip, naming the entry — and macOS Finder's `__MACOSX/` copies and folders skipped, not refused (Finder adds them to every zip it makes: refusing them would refuse every Mac user's zip); the declared sizes a pre-check (16 MB a file, 64 MB in all; a size the reader can't give refuses the zip: a JSZip build that changed fails loudly); then each entry unzipped through `internalStream`, stopping at the first chunk past what it declared, its kind's cap, or 64 MB for the whole import — one compressed block's output (16 KB in, at most ~16 MB out, pako's synchronous push) may arrive after the stop, and is dropped, never kept. Caps per file: 16 MB (`FILE_MAX_BYTES`) for game.json and images, where §4j said 2 MB for game.json — an export writes up to 4 M characters of rules state and a 3,000-item setup into it, and must import again; `RULES_MAX_BYTES` 600 KB for a rules file, where §4j said 200 KB — 200,000 UTF-16 characters (MAX_RULES_CHARS) are at most 600,000 bytes of UTF-8, so a script cleanBox takes always fits. Plain files take the same caps on `file.size`, before they are read. A text file that isn't UTF-8 is an error. Export checks its own file against these limits and refuses to write one an import would refuse | 4j (Phase 4A part 2) |
| D189 | `encodeImage`, as built (§4j; it replaces `fileToDataURL`, so decks gain the 2 MB step-down and the Safari fallback): the real type by the magic bytes (`store.imageType`), `imageDims` and the IMG_MAX_SIDE / IMG_MAX_PX limits before anything decodes; `createImageBitmap`, a canvas at most `max` px on the long side; the format chosen once per image by what the canvas really wrote for WebP 0.8 (its bytes, not its data URL's prefix), else JPEG for an opaque image (an alpha scan) or PNG; over ASSET_MAX_BYTES the quality steps down (WebP 0.8 → 0.7 → 0.6, JPEG 0.85 → 0.7 → 0.6; PNG has none), then the side × 0.85 a step at the lowest quality, an error naming the file below min(BOARD_MIN_PX, its own first size); the data URL carries the type its bytes are. One canvas, reused and shrunk to 1 × 1 after each image (iOS caps all canvases' memory). An image whose SHA-256 this browser already holds, of a type kept as is (not GIF), within `max` and 2 MB, is kept byte for byte: it passed these very checks before (and passes checkImage again in ingestBox), so a game exported and imported again is the same box, and a file picked again re-encodes to the same bytes anyway (the canvas is deterministic). Checked in Chromium, WebKit and Firefox (Playwright's WebKit on Linux writes WebP; `toDataURL` stubbed to answer PNG stands for Safari) | 4j (Phase 4A part 2) |
| D190 | The 📦 dialog, as built (§4g): rows of `boxEntries()` — the host's catalog, a guest's boxes and boxInfo — with their size ("4 piece types · 1 deck"), who added them ("by Bob", "built in", "made by 📜 Rules"), 📜 when they bring rules (`hasRules`, kept by takeBoxes) and "set up" on lastSetup; the host's Set up only on a box with a setup, Reset on lastSetup; the built-in list goes through `pickCleared` (loadBox, 🎲's confirm). Set up, Reset and the trust dialog are one dialog, `#box-ask` (`data-kind` setup, reset, trust); Set up asks only when there is something to decide (items or hand cards to clear, rules, a guest's box) and the trust dialog follows for every box but a built-in one with "Enable its rules" ticked. Messages live in the dialog, scrolled into view, since a toast lies under a modal's backdrop: an upload's progress and failure, a refused setup, the export's result — and a guest's answer from the host (the notice "🚫 Box rejected: …" or "That box is already on this table", or the box arriving by him: `boxWait`). A guest checks before sending only that the box fits the whole guests' budget (what is left is the host's to know, and its refusal says it), and caches its own images first, as for a deck. "Set up now" sets the host's upload up also when the box was there already. Closing the dialog drops an upload in the works. On a short screen (a phone held sideways) a ✕ in a sticky header replaces the footer's Close; elsewhere Close is a sticky footer, by the thumb | 4g (Phase 4A part 2) |
| D191 | Export, as built (app.js + boxio.js `exportFile`; amends D185's name): images as `images/<k>.<ext>` by the box's own index (the reader numbers them in the same order, so the box comes back equal), a deck's as `images/deck<i>-<g>.<ext>` and `deck<i>-back`, one file per image; a deck's cards as deck.json entries, consecutive equal cards as one with a `count` (≤ 500), an image card without a name written `"name": ""` (else the reader would name it after its file); rules as `rules.js` in a zip, inline in a `.json`; game.json indented. "Include the rules" and "Include the game state" are ticked by default only while the rules run, and disabled with no rules text: a table whose rules were switched off does not carry another game's script unasked. A table with no box (a card game) is named after its running rules ("Hold'em (chips).json"), not "Table" (core's exportBox). The file is the box's name with the characters a file system refuses replaced; it is saved through an object URL, revoked a minute later | 4g, 4m (Phase 4A part 2) |
| D192 | A refused or deduplicated `addBox` changes nothing: core's effect returns as a refusal does (no hook, no seq bump), so `act()` resolves `{ok: false, id}` for "That box is already on this table" on the host's own path too — it said `ok: true` there while the rules were off (the Worker path already said false) — and the dialog can tell "Added «X»" from "That box is already on this table" | 4c (Phase 4A part 2) |
| D193 | The terminal, as built (§4i, minus 4B's `group`): the snapshot's `boxes` (`{id, name, types, rules, src, builtin}`: the host's from its catalog, `isBuiltin` memoized per box object; a guest's from boxInfo, `rules` its `hasRules`) and `lastSetup` (the host's, else null); the REPLs print `boxes` in the same words ("[cd34ef56] Beacon Watch — 2 piece types · 📜 rules · a guest's upload · set up"); `setup <box> [--keep] [--rules]` names a box by its id or its name (any case; words joined) and `reset`; the Bridge API's `setup(box, keep, rules)` and `reset()`. The tab says what it refuses (a guest's setup or reset, a box that isn't there, `--rules` for a box without). `--rules` on a box that isn't built in opens the trust dialog on the host's page and tells the terminal it waits there: a typed flag never starts a box's rules. A setup from the terminal asks no "clears the table" (the command is explicit; `--keep` exists) and leaves the shuffle to its default | 4i (Phase 4A part 2) |
| D194 | The 4A part 2 suites, as built (§4l): B20 and B21 are `t-p4-bench.js`, in the serial batch (wall clocks), not t-p4-boxes; `t-p4-cli.js` holds the terminal. §4l item 7's "host-state digest" is compared as the position (items bottom to top, z left out, each type by its own id and each card by its deck's name, the hands): in the same room the catalog keeps the first box, so the re-import's box and deck ids are remapped (D180); the digest-exact round trip into a fresh room is core-p4's (4). Item 11's 4,000 × 3,000 PNG is a photograph's (3.5 MB: noise that size would pass the 16 MB file cap) and is encoded to 2,048 px at once; the step-down — quality, then size — is shown on a 2,048 × 2,048 board of noise (WebP 0.8 → 0.6 at 2,048 px still over 2 MB, then 1,740 px). The fixtures are drawn by `tests/fixtures/make-boxes.js` and committed; WebKit and Firefox were checked by a scratch run of boxio.js (the harness drives Chromium) | 4k, 4l (Phase 4A part 2) |
| D195 | The 📦 button joins the toolbar without adding a line to it on a phone: at ≤ 820 px wide "Copy invite" reads "Invite" (its title says the rest) and the toolbar's column gap is 6 px, not 8, so a guest's toolbar on an iPhone held upright stays two lines and a host's held sideways one, the heights the layout suites were measured at (79 and 37 px; a host upright stays three, 115 px). The row gap is kept: the toolbar's height on every phone is what it was before 📦 | 4g (Phase 4A part 2) |
| D196 | A shuffled `group` deals out identities, not places (§2c, amends D178): its face-down pieces that share a back trade their type and face among the group's places, and every item keeps its place, z, address and `id`. An entry's `id` is new in Phase 4 and sat on the piece: the box's author — a guest — read every hidden piece's identity off the ids in the public view after the shuffle (30 of 30 trials). Now an id names a starting place, never a piece; a sequentially minting env learns nothing either. A die that trades into a token's spot takes no address (dice never snap) — superseded by D210: a die no longer shares a shuffle with other pieces, and every place keeps its address | 2c, 4a, 4j (Phase 4A fix-up) |
| D197 | `"off": [dx, dy]` (setup grammar, a `piece` entry whose `at` is an address): the piece is set down that far from the spot's centre, unsnapped, and keeps that address while containment reads it there (D119: a table change or a board's move leaves a piece so) — out of the spot's reach, the setup is refused ("«off» [300,0] takes the piece out of reach…", the message naming the spot). Export writes it for a piece whose address is the one containment reads where it lies, off the centre (it wrote `free`, and the address was lost on import: core-p4 (4′)); `free` stays for a piece with no address | 4a, 4c, 4m (Phase 4A fix-up) |
| D198 | `{board, at}` names a board an entry BEFORE it places, checked as the box is read (cleanSetup, in the setup's order: a board is placed after its own `at`): a box listing it later registered and only failed at Set up | 4a (Phase 4A fix-up) |
| D199 | A saved state's key that names no player (neither a pid nor "@#k": "__proto__", "mallory") is invalid — "Some saved game state was invalid and was dropped" — and only a pid or an "@#k" nobody at the table answers is "away" ("…referred to players who weren't seated…"); every key not at the table was "away", which told the host something false about a forged key (§4j case 11) | 4c, 4j (Phase 4A fix-up; amends D177) |
| D200 | A `clear` ends the box set up: `clearTable` drops `lastSetup` (a setup or reset that clears sets it again; a loadBox that clears without a setup leaves none), so after 🎲 started chess, go or reversi (`clear`, then their rules) 📦 offers no Reset and marks no box "set up". A Worker's patch says the drop as `lastSetup: null`, which the host takes only in its own `clear` or a clearing `loadBox`. Export names and opens the file with the box set up only while the position is its — a piece or a card of its decks on the table or in a seated hand, or its rules running (D185 put it first whatever lay there: chess exported as "Draughts", with its types) | 4a, 4c, 4f, 4h (Phase 4A fix-up) |
| D201 | The lines of setup, reset and loadBox's setup are kept (`logEvent`'s `keep`): a second set laid out with `clear: false` is said again, never folded into the identical line before | 4c (Phase 4A fix-up) |
| D202 | In the host's `loadBox` job a Worker's patch may set `lastSetup` only to the box that job lays out (the one of that content the patch adds or the catalog holds, `laidOut`), and only when it asks for its setup and the box has one, as the engine does: a lying script pointed Reset at another box | 4f, 4j (Phase 4A fix-up; amends D183) |
| D203 | Errors are said as the author wrote the box: cleanBox's `types.<id>` (`.board` with it) reads "pieces[k] («id»)" and `backs.<id>` "backs[k] («id»)" on every authoring path (addBox, checkTransportBox, t.newBox: `cleanDef`), and a piece without an id "pieces[2]: `id` is required". `isBuiltin` says no at once to a box whose name is none of BOXES', and keeps its answer per box object (a stored box never changes): the boxes channel asked it of a 3 M-character box in 40 ms at every guest's join; app.js's own memo is gone | 4b, 4j (Phase 4A fix-up) |
| D204 | The 📦 questions (`#box-ask`) disable their buttons for half a second once shown (`ASK_ARM_MS`), and the trust dialog's are, left to right, Enable rules, Set up without rules, Cancel — Cancel where the confirm's Set up stood — under the title "«X» has rules" (the body keeps §4g's words, its question once). A double click or tap on the confirm's Set up answered the trust dialog that followed in the same element: the box's rules started unread (desktop and iPhone, Chromium and WebKit). One Set up or Reset runs at a time (`oneSetup`): the click that landed on the 📦 list while the confirm closed started a second one. D214 makes "Cancel where Set up stood" hold at every size (the dialog's bottom anchor) | 4c, 4g, 4j (Phase 4A fix-up) |
| D205 | A clearing Set up — and a Reset — of a box first switches off the rules running, unless a Reset restarts them as the box's own (`rules.box`): the game they ran is cleared away with the table, as 🎲's `pickCleared` does (D166), and the confirm says "The rules running now («Chess») are switched off."; the terminal's `setup` and `reset` take the same path. Chess's strict rules stayed on and refused every move on the new layout; a box's own rules that failed to start left the old ones running on it. A strict game still refuses an upload (D186, §10.1), and the dialog says why and what to do ("— the rules running («Chess») refused the box; the host can switch them off in 📜, then it can be uploaded again"), the host's and a guest's alike. Set up is offered for a box with a layout or with rules (a script that lays the table out with `t.layout`); "Set up now" skips, and the terminal refuses, a box with neither ("it has no layout to set up") — D211: only a refusal the rules made (`ruled`) is so explained | 4c, 4g, 4i (Phase 4A fix-up) |
| D206 | A touch take from a supply drawn smaller than 2 × TOUCH_REACH grips the new piece by its centre, as nearTouch's take does (D170): a direct hit on the bowl's edge held it by its corner, and the stone missed the point under the finger (WebKit hit-tests a bowl's corner; so would any synthetic press). t-p3c-review's press beside the bowl moved from 12 to 14 px off its centre, clear of the bowl's own box | 3g (Phase 4A fix-up; amends D170) |
| D207 | boxio.js, as fixed: a zip entry that declares 0 bytes is read as empty (JSZip keeps it as a promise of '', never inflated) — a README or a `.keep` refused the zip; two game.json at a zip's root, told apart by case, refuse it; among plain files (a picker gives no folders) a path the upload lacks is found by its own name — an export unzipped and picked — and two picked files of one name are refused; game.json must have its `name`; a deck stops being built the moment it passes MAX_DECK_CARDS (5,000; a 36 KB game.json of "count": 500 lines built 300 M cards first), and the + Deck dialog reads a deck.json of at most FILE_MAX_BYTES and points a game.json to 📦; a deck back that names no file of the upload and reads as a colour ("navy": COLOR_RE, what an export may write) is a colour. README's example is fixed (two seats, a card that exists, a `pile` beside the hand) and checked as written by t-p4-boxes, as is Help's new example; the 📦 dialog and Help link the README's Game boxes; the + Deck dialog's 📦 is 44 px on a touch screen | 4a, 4g, 4j, 4m (Phase 4A fix-up) |
| D208 | `scriptName` (the 📜 dialog's demo check, D173) reads a script's `name` however it is spaced or quoted (`name:'Chess'`, `"name": "Chess"`, a template literal): a reformatted copy of a demo went straight to setRules again | 3g (Phase 4A fix-up; amends D173) |
| D209 | A guest's upload waits for the host's answer at most BOX_WAIT_MS (30 s), stops at once when the host leaves (or isn't there to send to), and takes any 🚫 notice that comes meanwhile as its answer — the dialog is modal: a refusal of anything else can't be under way — said in the dialog; it waited on "Sent «X» to the host…" for ever | 4g (Phase 4A fix-up) |
| D210 | Amends D196 and D89. In a `group {shuffle}`, the hidden pieces that share a back must agree on being a die too (`sameLooks`, at `cleanBox`: "setup[1].group[1]: being a die differs from setup[1].group[0], which shares its back — the shuffle would show which is which"). D196 deals identities among places and every place keeps its address; a die never snaps (D112), so the place a die was dealt to lost its address (D196's `delete it.at`), and the public `at` told the box's author — a guest — where the die went every time (40 of 40 trials; a die and a token may share a back and every flag: cleanBox allows it, sameLooks compared no kind). Now a die never trades with a non-die, every place keeps its address, and the `delete` is gone. A die and a token under one back outside a shuffled group stay allowed (Phase 2's "alike from outside", t-p2-pieces/t-p2-hidden fixtures): dropped on a spot they still differ (D112's snap), which an author who placed them knows anyway — left for Phase 5's `vis`, which reworks hidden dice | 2c, 4a (Phase 4A fix-up 2) |
| D211 | A refusal is blamed on the running rules only when the rules made it: core's `veto()` (a script's string, `strict`, a failed hook) emits its notice as `{t:'note', p, msg, ruled: true}` (the Worker's effect allowlist passes `ruled` only as `true`); app.js's `drain` keeps it for the job's outcome (`{ok: false, error, ruled}`) and `tell` sends it with the notice (`{msg, ruled}`), so the host's and a guest's upload say "— the rules running («X») refused the box; the host can switch them off in 📜…" (`ruledOut`) for those alone. Amends D205's wording: the host's path added it to any refusal while rules ran — submitBox's ingest errors and "Couldn't store the box's images: storage is full" read as the rules' fault | 4c, 4g (Phase 4A fix-up 2) |
| D212 | `exportBox` leads with the box set up (`lastSetup`) or, when a clear has ended it (D200), the box whose rules run (`rules.box`) — each while the position is its (its pieces or its decks' cards here, or its rules running). A host `clear` while a box's own rules ran (pickCleared's clear, then a setRules that failed) left an export that threw on an empty table ("types needs at least 1 entry") and exported the rules without the box's types on a busy one — D216: "run" is enabled (a Disable keeps `rules.box`) | 4d (Phase 4A fix-up 2) |
| D213 | A box with rules and no layout is set up by its rules alone (they lay the table out with `t.layout`): its Set up confirm has no "Enable its rules" (nor "Shuffle face-down piles": t.layout doesn't shuffle), its trust dialog only Enable rules and Cancel, and the terminal's `setup` of it without `--rules` is refused ("setup: «X» has no layout — its rules lay the table out: add --rules"). Unticked or "without", Set up cleared the table and the named seats for nothing, logged "set up «X» (0 items)" and marked the box set up — D215: and the engine refuses a setup or a reset of it that starts no rules; 📦 offers no Reset then | 4g, 4i (Phase 4A fix-up 2) |
| D214 | Amends D204. `#box-ask` stands on its bottom edge (`margin-block: auto 30vh`, `max-height: calc(70vh - 16px)`; on a screen at most 560 px high, 12 px from the bottom), not centred: the last button of a right-aligned row — the confirm's Set up, the trust dialog's Cancel — sits at the bottom right whatever the body's height and however the buttons wrap. Centred, a taller trust dialog whose buttons wrapped (WebKit on an iPhone 13 upright: Enable rules and Set up without rules on one row, Cancel below) put "Set up without rules" where Set up was: a burst of taps set the box up unread (its rules stayed off). Checked at 1280 × 800, 390 × 664, 844 × 390 and 320 × 568 (wrapped) in Chromium; the reviewers' probes find the same in WebKit | 4g (Phase 4A fix-up 2) |
| D215 | Amends D213. A `setup` or `reset` of a box without a layout is refused in core unless its rules start with it (`setupBox`: `!box.setup?.length && !rules` → "🚫 «X» has no layout — its rules lay the table out: set it up with them", for a reset "🚫 «X» is laid out by its rules, which aren't running: Set up starts them again", with neither layout nor rules "🚫 «X» has nothing to set up (no layout, no rules)"), on the host and in the Worker alike; 📦 offers no ↺ Reset for such a box while its own rules aren't running (app.js `noReset()`: switched off in 📜, stopped, or other rules running), and the terminal's `reset` says the same before sending. D213 closed Set up only: Reset of the box with its rules off cleared the table and the named seats, logged "reset «X»" and laid out nothing (a reset restarts the box's rules only while they run, §4c). Closed in the engine so no path — the page, the terminal, the API — can clear a table for nothing; Set up stays the way to start the rules again (it asks the trust dialog). A box of a table and seats alone, no layout, no rules, is no longer set up through the API either (the page never offered it: D205) | 4c, 4g, 4i (Phase 4A fix-up 3) |
| D216 | Amends D212. `exportBox` takes "its rules run" as enabled (`rules.enabled && rules.box`), for the lead and for whether the position is the box set up: a Disable keeps `rules.box` (setRules flips `enabled` only), so after a Disable and a clear every export was named after that box and carried its types, images, decks and `players` (a 4-player room could no longer set up the re-import), and a box set up whose rules were off and whose pieces were all deleted still named the export | 4d (Phase 4A fix-up 3) |
| D217 | `group` as built (§4c, reconciled with D37 and the pipeline of §3f.4): `{op, ids, dx?, dy?, rot?, on?, bag?}`, `op` one of `GROUP_OPS` (move, rot, flip, roll, lock, del, toBag; `hide` is Phase 5's), its members `groupIds(a)` — the first MAX_GROUP ids, each once, as text (a number names the item its digits do, as `textIds` reads it) — a malformed group refused with a notice and nothing run (an unknown op, no ids, a lock without `on`, toBag to what isn't a bag). The members run bottom to top (by z), each as the player's own single action `{t: op, id, …, group: N}` (`group` joins HOST_SET: a peer can't forge it on a single action): a move by the group's shift cut as its live drag's (`groupShift`: D118's clampShift over the members the player may move), so the drop lands where the glide was, each piece snapping on its own; a turn by `rot` more, snapped to each member's rotStep; `roll` ONE sub-action of the dice the player sees among the members (a face-down die is no die to them: no oracle on hidden types), within MAX_ROLL as the single roll (more: its refusal). With the rules on, each member takes the whole pipeline from a savepoint of its own — handle, strict, validate, the default effect, then its own onAction (interleaved: the next member's hooks see this one's onAction, as two actions in a row would) — and the gates are checked after each (`settle`); buttons() runs once, at the end. A veto or an engine refusal rolls that member back alone and re-sends it; a handle or validate that throws (or broke a gate) rolls the whole job back — "blocked X: rules script error", every member re-sent; an onAction that fails keeps the members done, undoes its own writes, and the rest are skipped ("rules script error"), the rules off. With the rules off the host's table runs a group with no journal: a member's refusal writes nothing before it refuses | 4c, 3f.4 (Phase 4B) |
| D218 | What a group says (§4c): what its members' ops would say in the actor's name — their log lines, name bulbs and refusals — is gathered (`gather`, read by `logEvent`, `mark` and `no`; a script's own lines and `t.tell` pass as ever), then said once: one line in the actor's name ("moved 8 items", "rotated", "flipped", "locked" / "unlocked", "removed", "put 3 items into the bag Sack", "rolled 4 dice: 3 · 5 · 1 · 6" — each die as opRoll says it, a hidden one's value never), kept (`keep`: two groups alike are two gestures, the line naming no item); one bulb at the first member done, where it is now; one Rules line "blocked {name}: {the first veto} (k of N)" when the rules vetoed any; and one notice, "k of N were skipped: {the first reason, bottom to top}" — a refusal ("🚫 …", so the job's outcome is `{ok: false}`) only when none applied; a group of one, and a roll, say the single action's refusal. The notice carries `ruled` when its reason is the rules' (D211). A member gone before its turn is "it is gone" | 4c (Phase 4B) |
| D219 | A group's costs and checks: `floodCost(a)` = 1 + ⌊N/20⌋ for a group (N its groupIds, numeric ids counted), 1 for anything else — a group drag's one `drag` too (D73) — taken by `T.mayAct(p, a)`; the watchdog's budget for a group is RULES_TIMEOUT_MS + 10 ms × N (app.js `budget`). A group job writes only what single actions write (items, lines in the actor's name or the rules', one bulb `{p, id, x, y, roll?}`, notices, re-sends), so `checkPatch` takes it with no rule of its own, and still refuses what no group writes (a bulb in another player's name: speakerProblem) | 4c, 3f.5, 3f.6 (Phase 4B) |
| D220 | The group drag (§3c), completed: Phase 3's relay stays (`T.drag`, one fx `{p, ids, dx, dy, live}`), sharing its predicate and its cut shift with the group's move (`movable`, `groupShift`), and another screen shows the dragger's name on the group's first member gliding (showLive), as it does on a single piece | 3c, 3g (Phase 4B) |
| D221 | A built-in box may bring rules: `loadBox {rules: true}` starts its rules right after the job, as a setup's do (the `enable` effect, app.js enableBox, `rules.box`) — 📦's Built-in Set up of Hexfront is one loadBox `{setup, clear, rules}` through `pickCleared`, with no trust dialog (built in by content, isBuiltin). A box without rules is refused ("🚫 «X» has no rules"). `checkPatch` takes that `enable` only in the host's loadBox with `rules: true`, naming the box it registers or finds (`laidOut(a, boxes, false)`), with the remap its layout made (none when it clears). Hexfront is in 📦 only, not 🎲 (GAMES unchanged); its Built-in row's line is its `meta.pitch` | 4c, 4g (Phase 4B) |
| D222 | Hexfront as built (§4's demo; original, D42): `templates.js` `hexfront()`, drawn from a fixed seed (mulberry32), so `BOXES.hexfront` is the same box on every load and built in by content. A 3,400 × 2,400 table, seats Azure (bottom) and Ember (top); a 24 × 16 pointy hex map whose terrain the generator draws as fills — a river crossing it with three fords, woods, hills, eight towns as marks — and two deployment zones; per side four arms (infantry, armour, artillery, scouts: the strength large, the arm small, upright on every screen; a reduced face to flip for a step lost; `meta: {side, arm}`), 20 stacks of ten owned by the side's seat (40 stacks, 400 counters); two dice; 24 event cards, tiles with a back held in a hand, in a face-down pile "Events" (a stored box's `decks` names catalog decks, which a built-in box can't bring: tiles keep it whole). Its turn script (validate, not strict): the side to play moves, splits and joins its own stacks in the movement phase, rolls in combat, and draws one event a turn; losses (a flip, a removal) are taken in combat by each side on its own units; ⚔ To combat and ⏭ End turn are the active player's buttons; the turn cue and a phase badge follow whoever sits in the side's seat (buttons()); a fresh state shuffles the events. B18 measured: 16.1 KB (snapshot 8.0 KB + PublicBox 8.1 KB); a guest's render 21 ms on the desktop, 48 ms on an emulated iPhone 13 at 2× throttle | 4, 4k (Phase 4B) |
| D223 | B19 as measured (`core-p4-bench.mjs`, serial): 200 tokens on a hex map, moved a hex as one group, alternately by the host and 8 guests: the host's apply p95 3.0 ms with the rules off (T.apply) and 0.8 ms with them on (applyStatePatch of the mirror's patch; the mirror's own job, a Worker's time, 3.8 ms median and 6.3 ms p95 with an onAction per member); the sealed patch to each peer at most 26 KB | 4k (Phase 4B) |
| D224 | The terminal's `group` (§4i): `group <op> <id,id,…> [dx dy \| deg \| bag]`, op `move dx dy`, `rot deg`, `flip`, `roll`, `lock`, `unlock`, `del`, `bag <bag>` (unlock: lock off; bag: toBag; items and the bag by id or name); the Bridge API's `group(op, ids, kw)` in cli.js (kw an object) and `group(op, ids, **kw)` in cli.py send `{t: 'group', op, ids, ...kw}` (dx, dy, deg, bag), which the tab turns into the action, saying an unknown op in the terminal | 4i (Phase 4B) |
| D225 | Multi-select as built (§4g, beside Phase 2's single selection): app.js `multi` (the picked ids) next to `sel`; one item picked is `sel` alone (its own bar), two or more are the group (the group bar). Picked are items that are no board, nobody else's and not locked (`pickable`), at most MAX_GROUP (a band past it: "200 at most: N left out"); the rest are counted in the chip "N not selectable (locked or someone else's)". A band starts with Shift — or ⬚ select mode, a floating toggle in the table area's bottom-left corner shown on every device — on a press where a plain drag would pan (the felt, a locked board, a piece the player may not drag); a press on a piece the player may drag still drags it (with Shift the whole stack, §2g). The band adds to the selection and picks every item whose drawn centre (fanned: where it is drawn) lies inside it, in screen space (so a turned view picks what the eye sees). Shift+click, or a tap in ⬚ mode, picks an item or puts it back; a ×N or ×k badge tapped in those modes picks too. Clearing: Esc, a click on the felt (not with Shift nor in ⬚ mode, where a tap on the felt or a board keeps the selection), ✕, ⬚ off. A member locked while picked stays picked (the group bar's 🔓 unlocks it); one that is gone or becomes someone else's leaves the selection | 4g (Phase 4B) |
| D226 | The group drag as built (§4g, §3c): a press on a member the player may drag carries every member the player may move (a locked member stays), by one shift cut as the host cuts it (core's `clampShift`, now imported by app.js: the drop lands where the glide was), each element moved by a translation; one `drag {ids, dx, dy}` every LIVE_MS (at most 16.7 a second; one flood token each). The drop sends one `group` move and draws each member where the host will put it (its own snap: `snapTo`), held there until a state shows it there or back at its origin, else 1.5 s (`landings`: Phase 3's single `landing` became a map, `hold()`, shared with the single drop). A group's drop is always a move — onto a bag, a stack or the hand bar too: 👜 Into bag ▸ is the group's way into a bag | 4g, 3c (Phase 4B) |
| D227 | The group bar as built (§4g; reconciled with §2g's "the client never sends an action it knows the host refuses"): it is #action-bar's content while two or more are picked — "N selected", ⟲ ⟳, Flip, 🎲 Roll, 🔒 Lock / 🔓 Unlock (Lock while any member this player may lock is unlocked), 👜 Into bag ▸ (the bags on the table this player may handle that aren't members, listed in the bar as Give ▸ lists players), 🗑, ✕ — each offered only when some member allows it, and each sends one `group` of just the members it applies to (those the player may move whose turn shows, that turn over; the dice the player may handle; those it may lock), so the host's "k of N were skipped" comes from a race or the rules. ⟲ ⟳ turn by the largest rotStep above 0 among the members, else 90 (a free turner's rotStep 0 counts as none; each member snaps the delta to its own step, D217). R / Shift+R, F, Space, Delete (Backspace) run the bar's commands only while the bar shows: not while the inspector is open nor while a group is carried | 4g (Phase 4B) |
| D228 | Where the bars and the inspector stand (§4g "never cover what they act on"; amends §2g's placement): `placeBeside` puts each above the screen box of what it acts on when it fits there, else below, else as low as it fits (§2g's bar ran off the screen below); a piece's own bar takes in its whole crowded spot — a finger that pressed a lower piece of a fan (to take the top one, D115) would otherwise find the bar's buttons under its next tap, and a touch tap's synthesized click lands there. On a coarse pointer the action bar's buttons are at least 44 px tall (the group bar's and §2g's alike) | 4g, 2g (Phase 4B) |
| D229 | The stack inspector as built (§4g): `#inspector`, a popover in #table-wrap's screen space beside its stack or spot (placeBeside), re-placed with the view. It opens on a tap of a ×N stack's `.count` (a piece stack, `k:'g'`, n ≥ 2 — a card pile's count is no ×N), on a tap of a spot's `.fanb` (now hit-testable), on a touch long press (450 ms) of a ×N stack in place of the zoom (a single piece keeps its zoom), and from ⋯ Inspect in the bar of a ×N stack or a crowded piece the player may move (its spot's list first). Anyone opens it by the badges: for someone else's or a locked stack it shows the face and count only. Take [k] sends `split {n: k}` at dealSpot (the host snaps it); Take all selects the stack and arms ✥ (the next drag carries it whole: the inspector picks no destination). A crowded spot's list runs top first; a tap selects that piece (its bar), and a press that moves 8 px closes the list and drags that piece (dragMode; held by its centre); the list scrolls with an up-and-down swipe (`touch-action: pan-y`). It closes on Esc, ✕, any press outside it, or when what it shows is gone (no longer a ×N stack, a spot of fewer than two), and redraws when its markup changes (every renderAll checks); the action bar hides while it is open | 4g (Phase 4B) |
| D230 | 4B part 2's measures (§4k, browser): B19 — the host's T.apply of a 200-member group move on its own table 3.6–4.1 ms (`__ct.perf.lastJobMs`, new: the host's last job on its own table), the patch that brings it to a guest 17.9 KB, the dragger's 62 drags over 8 s at most 9 in any second; B18 — Hexfront's cold render by a guest 9–14 ms on the desktop and 17–29 ms on an emulated iPhone 13 at 2× CPU throttle (`lastSnapRenderMs`), its snapshot 8.8 KB and the boxes channel 10.0 KB; B21 — Hexfront exported from 📦 in 36–56 ms (no images: `Hexfront.json`). `t-p4-hexfront.js` runs in the serial batch (a throttled CPU and wall clocks) | 4k (Phase 4B) |
| D231 | 🎲's picker marks no game "playing" while a box's own rules run (`rules.box`: Hexfront's turn script is no 🎲 game, and "Custom script… playing" misled) | 4g (Phase 4B) |
| D232 | Amends D83 and D221. A **built-in** box's face-down `deck` and `pile` entries are shuffled by default wherever it is laid out — `setup`, `reset` and `loadBox` (`shuffle` defaults to `src === 'upload' \|\| isBuiltin(box)`; the host may still pass `shuffle: false`) — as a guest's are: every player's browser holds its source, so its unshuffled order is known to all. Hexfront's Events pile went face down in templates.js's EVENTS order whenever it was laid out without its turn script (📦 Set up with "Enable its rules" unticked, ↺ Reset after a Disable or a stop, the terminal's `setup`), and the top card was always "Quiet front". The line says ", face-down piles shuffled" only when a pile was (Draughts' and Backgammon's lines are unchanged) | 4c, 4j (Phase 4B fix-up) |
| D233 | Amends D5. A patch sends an item whose public record changed **only in its place** (x, y, rot, z, its address) as `pos: {id: [x, y, rot, z, at?]}` — no address, none — and any other change, a new item, or a refusal's re-send of an unchanged one whole in `items`, as before. The host keeps what it last sent of each item (`sent`, by `patchContent`; a snapshot resets it), so the place is relative to what every peer in step holds; `applyViewPatch` folds it into the record the view has (an unknown id or a bad place: dropped, `console.error`). PROTO stays 5 (unreleased). D5's reason — a public item is under 150 bytes — held for one move; a group move of Hexfront's 200 counters cost each peer 32.0 KB (sealed: the body is JSON-escaped), over B19's 30 KB; now 11.1 KB in Node and 11.0 KB on the wire. Corrects D223's and D230's B19 figures, taken on lighter test boxes (26 KB, 17.9 KB) | 1b.2, 1b.4, 4k (Phase 4B fix-up) |
| D234 | A ruled `group`'s cost follows its real work. Each member's savepoint takes the rules' JSON from the member before (one pass over t.data, not one per member); a member that did nothing is rolled back to its savepoint and needs no settle; `settle` reuses the checkpoint's JSON when no hook ran after it (and `gateTimers`, which now says whether it changed anything, didn't). The price: while the rules run, a group costs `floodCost × ⌈t.data's JSON length / GROUP_DATA_CHARS (100,000)⌉`, at most the whole burst (40), so it can always be sent; the watchdog's budget per member is 10 ms plus 20 ms per MB of t.data (`T.rulesChars()`, the host's t.data length, kept per data object), and the stop names the limit the job had ("the script took longer than 4.2 s", "didn't answer within 4.2 seconds"; a flat "4 s" misled). The host's network gate cuts any action's `ids` to MAX_GROUP before queueing (a million ids cost the host a mapping and a Worker clone). Measured (Node, a guest's 200-member group): 3.8 MB of t.data 3.5 s, was 7.0 s, against a budget of 21.6 s; at 250 KB 281 ms, was 629 | 3f.5, 4c, 4j (Phase 4B fix-up) |
| D235 | `group` as §4c says, fixed: a member the engine refuses — or that does nothing — is rolled back to its savepoint with what its handle and validate wrote, as a vetoed one is (D217 said so; the code kept them); a group of one, and a roll, notify the single action's refusal word for word ("🔒 That is locked in place"; a rules veto's bare words get 🚫); a group roll's line is built from the faces opRoll said as it rolled (`gather` keeps its line), never read back from the dice after the hooks — an onAction that removed a rolled die crashed the engine and the rules went off blamed on the script | 4c (Phase 4B fix-up) |
| D236 | Amends D228. A selection being built — two or more picked, or one picked by Shift or ⬚ (`picking`) — docks its bar at the top edge of the table area, centred, unless that would cover one of the picks (then beside them, as before): beside the picks it lay on the next pieces to pick and moved with each pick, so a tap or click meant for a piece hit whichever button came under it (🗑 removed the group). A Shift+click on the bar selects no page text. Not done: arming the bar's buttons for 400 ms after it shows (as #box-ask's are) — a docked bar no longer moves under the finger, and a delay would swallow every quick click of the suites' drivers and the keys' users alike | 4g (Phase 4B fix-up) |
| D237 | Amends D225. In ⬚ select mode a press anywhere but on a picked member draws a band (a tap picks): its chip says "drag a box", and a drag that started on a piece took one out of its stack instead. A double click does nothing with Shift or in ⬚ mode (two clicks that pick and put back flipped, rolled or drew for everyone). A band a pinch or a long press interrupts is hidden (`dropFelt`). ⬚'s chip reads "Select: drag a box, or tap pieces" and stands above ⬚, lifted above a row of the rules' buttons over your own label (placeSeats); no seat label is drawn under ⬚ (`SEL_CORNER`: a label in the corner moves right of it) | 4g (Phase 4B fix-up) |
| D238 | The group bar as the single bar: none while strict rules take selections (D154; a group's ⟲ ⟳ 🔒 🗑 were each refused by chess); 👜 Into bag ▸ is offered when a picked piece could go in, and sends only the pieces the chosen bag takes (a picked bag drew "1 of 13 was skipped"); 🎲 Roll (and Space) rolls at most MAX_ROLL dice, the chip saying how many were left out. A piece chosen on purpose in the inspector — a row of a crowded spot's list, a stack's Take all — ends the group picked before: its own bar, ✥ armed | 4g (Phase 4B fix-up) |
| D239 | Hexfront's turn script guards every way to an event card: an action on the Events pile (by id, pile or onto) or on an event card dealt out of it, but for a move or a turn, is the side to play's alone ("Only Azure draws an event this turn" / "…touches the events this turn"), and a draw or a deal is the turn's one event ("One event a turn"): the pile's Deal↓ and a card's ✋ took events out of turn, as many as anyone liked | 4 (Phase 4B fix-up) |
| D240 | (Amended by D245: one row wherever it docks, placed again after every redraw, held off whenever it docks somewhere new.) Amends D236 and D228. A selection being built — two or more picked, or one picked by Shift or ⬚ (`picking`) — docks its bar **where no piece is drawn**: centred along the top of the table area, below the "What are we playing?" strip when it shows, when no piece but a board is drawn across that strip of the screen (DOCK_H, 60 px; a table seen whole leaves its rim there, and the toolbar stays usable), else **over the toolbar** (#action-bar moves into #toolbar, `.docked`: its whole box, the toolbar's own controls hidden under it until ✕, Esc, a click on the felt or ⬚ off), as a phone's selection bar does: ✕ first, then "N selected", in one row as tall as the toolbar (its buttons at most 44 px on touch: a guest's phone held sideways has a 37 px toolbar, so 29 px there, the toolbar's own size), scrolling sideways with its end faded (`.more`) when wider than the screen. Either way it covers no piece — D236 docked at the top edge over the top row and the game strip regardless (a click on Bridge flipped the group, on Chess locked it), and fell back beside the picks, over the next row, moving with each pick — and while the view holds still it never moves (the strip's test spans the whole width, so a wider bar changes nothing). A single piece picked by Shift or ⬚ gets ✕ too (its docked bar has no other way back to the toolbar). A selection's bar, wherever it docks, holds its buttons off BAR_ARM_MS (400 ms) after it shows or offers something else (`armBar`, disabled buttons, as #box-ask's, D204): a click aimed at the felt or a toolbar button the moment it appears presses nothing. The test-authors' t-p4-hex-bench opens 📜 with Azure's 200 still picked: on its Hexfront table the rim is clear, so the bar docks at the top and the toolbar stays reachable. A piece's own bar (D228) is not held: it shows beside the piece just tapped, where the next quick tap is meant for it (holding it failed the phone driver's taps 60 ms after it held still, and would swallow a player's quick Flip). 🗑 of more than GROUP_DEL_ASK (5) members asks first in the bar — "🗑 Remove 8?", for ARM_MS — and a second press removes them; Delete removes at once (a key is no misaimed tap) | 4g (Phase 4B fix-up 2) |
| D241 | Amends D234. A ruled group's price follows its work past the burst: `floodCost × ⌈t.data chars / GROUP_DATA_CHARS⌉`, no longer capped at 40. `flood()` lets an action that costs more than the whole burst go from a full bucket and **overdraws** it: its sender waits the rest out (20 tokens a second). Capped, a guest's group of 200 every 2 s at 3 MB of t.data bought the Worker 1.7 s of work a second (singles at flood control's rate: 0.67 s) and every other player's moves waited behind a queue that grew 0.11 s a second; now such a group costs 341 tokens (one each 17 s) and a flood of them buys 0.14 s a second at 2 MB (singles 0.32 s). An honest group pays more than the burst only past ~300 KB of t.data (none of the built-in games comes near) | 3f.5, 4c, 4j (Phase 4B fix-up 2) |
| D242 | A group member's checkpoint gate compares the rules' JSON with the **job's start** (`J.frames[0]`), as settle's does, never the member's own savepoint: the patch says a field only when its JSON differs from the job's start, so a function hidden in t.data while the members took its JSON away and back (member 1 x: 1, member 2 x: 0 + fn) is refused at once — "t.data.fn is a function, not JSON", the job failing closed — where D234's settle shortcut let it commit into the Worker alone and blamed the next job ("the script changed t.data outside a hook") | 3f.4, 3f.7, 4c (Phase 4B fix-up 2; amends D234) |
| D243 | (Amended by D246: its 16.7–16.8 ms did not hold; a per-frame layout and the hover hit test after it remained.) B4's frames on a phone, measured (a Chrome trace of the bench's 1,000-card pan and twist at 2× throttle): the seat labels are layers of their own (`will-change: transform`), so a pan frame moves them without repainting (Paint 133 ms in a 3 s pan before, none after); the table area's size is read only when it changes (its ResizeObserver: `wrapW`, `wrapH`), the view's fit is computed without the DOM (`fit()`), and a pinch reads the area's client rect once as it starts (`pinch.r`) and draws one layout per finger move (`fit()` then `anchorView`), where each of the two fingers' moves had forced the style the other had just written (4 style recalcs a frame, 593 ms in a 3 s twist; now one a frame, JS 4 ms → 0.3 ms a frame). What remains per frame is the browser's own (re-layerizing the table's layer, hover hit tests): t-p1-bench's B4 rows ran at 16.7–16.8 ms p95 alone on the machine where the code before failed them at 33.3 ms (and the base before 4B too) | 2k, 1k (Phase 4B fix-up 2) |
| D244 | `uid()` never mints an id of digits alone (it draws again): a key such as "93673545" is an array index, which a JS object lists before every other key, out of the order it was added — 📦's "On this table" and the terminal's `boxes` listed a later box first (t-p4-cli failed so about one run in twenty). Ids stay 8 hex digits; an all-digit id an older export brings is still taken when free (§4c), so only an import can still list out of order | 0.2, 4i (Phase 4B fix-up 2) |
| D245 | (Amended by D248: the row keeps its scroll, brings an ask or an opened list into sight and goes back after; a wheel scrolls it; dockTop looks at what was redrawn.) Amends D240. A selection's bar is **one row wherever it docks** (`#action-bar.row`: no wrap, sideways scroll with the `.more` fade, ✕ then the count first, at most 54 px tall — 44 px buttons on touch and the padding — within DOCK_H's 60 px strip): docked in the table area it had kept the piece bar's wrapping layout, two rows (102 px) on a phone, over the row of pieces just below the strip tested clear, where a tap meant to pick a piece pressed a bar button (🗑 of five or fewer removed the group; ✕ cleared it). While a selection is being built (`multi.size \|\| picking`) the bar is **placed again after every redraw** (`syncBar`), not only when a member moved: any piece, anyone's, that comes into its strip (another player's move, a deal) sends it over the toolbar, and back when the strip clears. **Whenever it docks somewhere new** (`placeBar`: `barAt` '' / 'top' / 'toolbar') it is held off BAR_ARM_MS (`armBar`) and its row fitted (`fitRow`, also on a ResizeObserver of the bar itself); D240's "it never moves while the view holds still" becomes: it moves only when the view or a piece in its strip moves, and is held off as it moves. "🗑 Remove N?" (the row's last button, wider than 🗑) scrolls the row to its end, unfaded, so the question is never cut off at a phone's edge. t-p4-fix section 8 covers each (a phone's 5-member bar with dice and a bag, a ⬚ single pick of a lockable token, the ask, a peer's move into and out of the strip, a member moved into it) | 4g (Phase 4B fix-up 3) |
| D246 | (Amended by D247: it held only with nothing selected — a piece's bar and the inspector, placed by left/top on a size read each frame, and a wheel zoom's sizes, still laid the page out every frame.) Amends D243, whose "16.7–16.8 ms alone" did not hold: the reviewers' solo runs of f2bc379 had one B4 row at 33.3 ms (no long task) in four of five, and so did this round's first (the 1,000-piece pan and the twist). A Chrome trace of those two gestures with invalidation tracking (a scratch probe) found the two-vsync frames paid for a **layout**: while your own seat label in the lower half moved, `placeSeats` wrote the button row's `--row-room` (its max-height) and ⬚'s chip's `bottom` — the page laid out every third frame or so — and after every layout Chrome dispatches a synthetic mousemove at the last mouse position to recompute hover (`MouseEventManager::RecomputeMouseHoverStateIfNeeded`): a hit test of the whole 1,000-piece table, 3–6 ms at CPU × 2, on top of a frame's ~9 ms. Now `placeSeats` moves the row, ⬚'s chip, the notices and the watchers' box by `translate` alone in every frame, and writes what sizes a box — the hint plate's `--hint-w`, the row's `--row-room`, `.gutters` and `--gutter` (now only with `.gutters`, which alone reads it) — only while no pinch and no felt pan moves the view, catching up as they end (`endPinch` → layout, `dropFelt` → `placeSeats`). Measured (CDP LayoutCount, t-p1-bench): a 3 s pan of the 1,000-piece table 81 layouts → 4, of the 1,000 cards 101 → 7, the twists 86–88 → 1; in the trace, main-thread time per pan frame 12.2 → 8.8 ms at CPU × 2, per twist frame 14.8 → 12.6 ms. `t-p1-bench` alone after it: every B4 row green in four runs of four (16.7–16.8 ms p95), and each pan and gesture row now asserts at most B4_LAYOUTS (15) layouts, which the code before fails four times. `overflow: clip` with `contain: layout paint` on #table-wrap was tried and changed nothing (not kept). What remains per frame, the browser's: Blink re-layerizes the page at every transform change of the table (`PaintArtifactCompositor::Update`, 6–7 ms at CPU × 2 with 1,000 pieces — it updates a transform in place only on an element with an active transform animation); a turn rewrites the view sheet's `--view` rule for board text (about 1.5 ms: a changed sheet schedules invalidations over every element); Chrome's ad-detector hit tests (about one a second, 10 ms each). A loaded machine can still push a row over: rerun t-p1-bench alone before blaming a change | 2k, 1k (Phase 4B fix-up 3) |
| D247 | Amends D246, whose rule — nothing a gesture's frame writes lays the page out — held only with nothing selected. **Popovers in screen space** (#action-bar, #inspector) now sit at `left: 0; top: 0` and are placed by `translate` (`placeBeside`, and a selection's bar docked at the top); `placeBeside` reads a popover's size (`offsetWidth`/`offsetHeight`) only while no gesture moves the view and keeps it in `popSize`, which `renderBar`, `renderInspector` (when its markup changed) and a dock change drop, so a pan, pinch, twist or wheel frame that moves one reads nothing back and writes no box; a hidden popover is not placed. Before it, `placeBeside` read the size and wrote `left`/`top` in every frame: with a piece's bar open the reviewers counted 178–181 layouts in the bench's 3 s pan of the 1,000-piece table (1–2 without) and 302–355 in the twist of 1,000 ×3 stacks, p95 33.3 ms in two runs of three — the state of a player who taps a piece and then turns the view to look at it. **A wheel is a gesture** (`viewMoves()`: a pinch, a felt pan, or a wheel's turns until WHEEL_REST_MS, 200 ms, after the last): `placeSeats`' sizes wait for its rest, as for a lift (a wheel zoom wrote them at every turn: 166–174 layouts in 3 s). Measured on the fix with the reviewers' probes: the pan with a token's bar open 1–2 layouts at 16.7–16.8 ms p95, the twist with a stack's bar open 1 layout at 16.8 ms, a wheel zoom 1–2; t-p4-fix §9: sixteen wheel turns with a token's bar open lay the page out once (32 times before). t-p1-bench runs the 1,000-piece pan and the 6000 × 4000 twist again with a piece's bar open, under B4's budgets and B4_LAYOUTS (in the closing full run: 0 and 2 layouts, p95 16.7 and 16.8 ms). A test that moves the bar itself (t-p2-review) moves it by `translate` | 2k, 4g (Phase 4B fix-up 4) |
| D248 | (Amended by D289: only a wheel over the felt zooms.) Amends D245. **A wheel over the bar or the inspector is theirs**: #table-wrap's zoom leaves an event inside them alone, and a one-row bar wider than its room scrolls sideways by a wheel (`deltaX \|\| deltaY`) — in D245's row a mouse could not reach the later bags of 👜 Into bag ▸ or 🗑 (the scrollbar hidden, the wheel zooming the table), where the bar had wrapped before. **The row keeps its place** (`scrollRow(sx)`): when it shows "🗑 Remove N?" or an open list (👜 Into bag ▸, Give ▸: from its toggle to its last button) it scrolls by as little as brings that out of its faded ends (ROW_FADE, 15% each), its start first when wider than the room; once that is gone (answered, lapsed, closed) it goes back to where it was before (`rowBack`); otherwise it keeps the scroll it had through a redraw and through a move to another parent, which resets `scrollLeft` to 0 in Chromium and WebKit (D245's ask was pushed off the edge again when the bar re-docked within its 5 s, and the row stayed at its end after the ask lapsed, ✕ out of sight with no cue). **`.less` fades the left end** while the row is scrolled off its start, as `.more` the right. **`dockTop(prev)`** no longer looks over the whole table after every redraw: after a patch of a view that kept still, a clear strip can only have been entered by what was redrawn (and its spot's fan), and the piece found in it only left it if redrawn; the whole table is looked over (`perf.dockScans`) when the view, the strip's top or a board changed, or that piece was redrawn — with three picked on the bench box another player's one-item move had cost the phone 1.70 ms median, 2.70 p95 (0.70, 1.00 before D245). t-p4-fix §9 covers each, on a phone and a desktop | 4g (Phase 4B fix-up 4) |
| D249 | Reconciles §5h with the existing model: **`vis` lives on table pieces alone.** Pile members and hand entries (`{t, f, up?}`) carry none: a piece that goes onto a pile or into a bag is hidden from everyone there (as in Phase 2), one that goes into a hand is its holder's (the hand is theirs alone); `stack`, `toPile`, `toBag` and `toHand` leave the piece's `vis`, `pv` and `po` behind. So the setup grammar's `vis` and `po` are for `piece` entries only (§5h's "piece members of pile and hands entries" would carry nothing the table could show), and an export writes them there alone | 5a, 5h (Phase 5 part 1) |
| D250 | The per-recipient overrides as built (§5b). A viewer's full form — the piece's shown public form, then `up: false` and its `vis` — travels in that viewer's own part of the body (`vis` joins OWN_FIELDS: a shared part may never carry it), built once a tick for the tick's dirty pieces hidden from others (`takeDirty`: `d.full` their ids, `d.vis` each resolved viewer's forms), and for a snapshot from `byVis` (`visFor`); a guest takes one only for an id of the same body's `items` (`bodyItems`), in that body alone. **A piece that is, or was at its last send, hidden from others with a full form goes whole in the shared `items`, never as a `pos` place** (`visSent`, beside D233's `sent`, which holds shared forms only): its viewers hold the full form, and one who lost sight of it as it moved must get the reduced form, not fold a place into the full one (the p5 notes' "placeOf falls back to the whole record"). So a vis piece's move costs every peer its whole reduced record — the same for all, and B22's "0 B to the others" holds: its viewer's body grows by its override alone (127 B in core-p5, ≤ 400). A piece whose box is missing gets no override (the host can build no form a guest can draw): everyone gets `{b: null}` | 5b, 5k (Phase 5 part 1) |
| D251 | A seat's change of occupant is caught **at the broadcast tick** (`seatMoves`, run by `takeDirty`): who holds each named seat now is compared with the last tick's, and every piece `byVis` lists under a seat that changed hands is touched — whatever path moved them (a `seat` action, `t.setSeats`, a join taking a free seat, a Worker's patch of the players), with no hook in each. §5a's "when a seat's occupant changes, every item in byVis.get('seat:<id>') is touched" | 5a, 5j (Phase 5 part 1) |
| D252 | (Amended by D277 and D278: a zone never widens who sees a piece — a screen never takes a private piece over, a rack only from one who sees it — and `unzoned` placements and a bag's backless draws are untouched.) Private zones in `place()` (§5a), as built. Where the piece lands (`landing`: snapped, else clamped) is read before anything changes, then the zones under its centre (its address's board, else the topmost board: `zonesUnder`), the first private one whose owner resolves ('board' → the board item's owner; 'seat:<id>' → a named seat of the table, held or not) wins. A piece whose type has no back can't enter one: `place()` throws a TypeError (a script's op, a setup — atomic, refused whole), and a person's `move`, `take`, `pull`, `split`, `play` and `deal` are refused before they write anything (`mayPlace`: the ops now build the new piece and check its landing first). An owner set by `po` is the engine's and follows the zone into another owner's zone; a real owner stays (no `po`). The zone a `pv` piece leaves is read where it lay (a split's: where its stack lies, `o.from`, and the split part takes the stack's `vis`, `pv` and `po`); when no zone of its owner lies there any more (its board moved away — which fired nothing), it leaves as from a screen ('keep'): a zone never exposes unless it was a rack the piece lay on. Every placement into a zone hides afresh — a piece revealed in it and moved within it, or back into it, is hidden again (§5a's "entering … happens when a piece's centre is placed in it") | 5a, 3a (Phase 5 part 1) |
| D253 | `hide` as built (§5c): `{ids}` (1 to MAX_ROLL, each once), all or none, each a piece (not a board) the actor sees — one hidden from them is refused first, with the uniform "🚫 That piece is hidden" (hiding it would show it to them) —, whose type has a back ("🚫 That piece has no hidden side"), not hidden already ("🚫 That piece is hidden already"), that they may handle and isn't locked. "hid {label}", the label as the piece showed a moment ago (as flip's "turned {label} face down"), or "hid N pieces". A group's `hide` runs one single `hide` per member (`{t: 'hide', id, ids: [id], group: N}`) and says "hid N pieces" | 5c, 4c (Phase 5 part 1) |
| D254 | (Extended by D280: stack, toPile, toBag, a split onto a bag and a rack ask it too.) **The private-piece rule covers what would show a private piece to its taker** (security, beyond §5c's flip, roll and face): a private piece (a non-empty `vis`) hidden from the actor is refused for `toHand` (a hand shows its holder every entry) and for a claim (`owner` to oneself: claimed, it would be theirs to turn over, D84), with the same uniform "🚫 That piece is hidden", unless the actor owns it (`seen`). The host's `owner` may still reassign it (D17), on the record. A group's roll takes the dice the actor sees and the private ones they own | 5c, 5j (Phase 5 part 1) |
| D255 | A piece peek (§5c) asks no owner — §5j case 4: Mallory may peek at Alice's rack tile, loudly — answers `{t, f}` to the peeker alone ("peeked at a hidden piece", `k: 1`), and for a piece the actor sees (face up, or its `vis` names them) notifies "You can already see it" with no line and no hook after it (nothing happened) | 5c (Phase 5 part 1) |
| D256 | Roll lines name the shown dice's values alone (§5c, §5d): "rolled 3 · 5"; "rolled 4 dice (2 hidden): 3 · 5"; "rolled 2 hidden dice"; "rolled a hidden die" (`rollLine`). A group's line is built from the faces and the hidden count opRoll recorded as it rolled (`gather.roll`, D235), "rolled N dice: a · b" when all show — no longer from the member's gathered text, which is gone (a group member's lines are simply dropped: the group writes one) | 5c, 4c (Phase 5 part 1) |
| D257 | A placement's log line names the new piece **as it lies after `place()`**: a piece dealt, pulled or played into a private zone was never shown, so "dealt a piece face down", "drew a piece from the bag Pool", "played a piece face down" (a pull read the bag member's side before; a deal and a play, what was asked) | 5d (Phase 5 part 1) |
| D258 | The facade as built (§5e): `t.hide(id, refs = [])`, `t.setVis(id, refs \| null)` and `t.spawn`'s `vis` (with `up: false`) take refs that are players at the table (by id) or `'seat:<a named seat>'`, at most MAX_VIS, a list (a lone string is a TypeError); `t.hide` and `t.setVis` need a piece, not a board, whose type has a back (a TypeError: such a `vis` could never apply). `t.reveal` of a piece face up with no private field is `true` with no line. `t.canSee(pid, id)` answers for every kind: a piece or supply by the rule, a card or a pile's top by its side, a bag never. Their lines aggregate ("hid", "revealed", "changed who sees") | 5e (Phase 5 part 1) |
| D259 | (Amended by D283: a piece its zone wouldn't give back as it is goes as it lies, `unzoned`.) Export and the setup grammar (§5h) as built: a piece's entry writes `up: false` with `vis` (pids as "#k"; a viewer who isn't seated is left out, with a warning) and, with `po`, `po: true` beside its exported owner; a piece a private zone hides (`pv`) is written with none of up, vis and — when its owner came from the zone (`po`) — owner: set up again, its zone hides it again. In the grammar, `vis` (one ref or a list, each once, ≤ 8: "seat:<id>", "#k", "seat" inside forEachSeat) needs a piece entry with `up: false`; `po: true` needs that and an owner. A shown piece's `vis` (t.setVis on a piece face up) is not exported | 5h (Phase 5 part 1) |
| D260 | (Amended by D281: `pv` and `po` only as the engine writes them.) The gates on `vis`, `pv` and `po` (`visProblem`): `vis` a list of 1 to MAX_VIS distinct refs (a player id, or 'seat:<id>'), `pv` and `po` 1, on pieces alone. A rules Worker's patch with a malformed one is refused (checkPatch: the rules end); a save's is dropped loudly at load, the piece kept — face down, hidden from everyone. `stackable` (join, split onto) also asks for the same `vis` | 5f, 5h, 3f.6 (Phase 5 part 1) |
| D261 | `hiddenFrom(p, it, holder)` (core, exported) takes who holds each named seat (a seat ref resolves to its holder, offline or not, as owners do); inside the table it is `hidden(p, it)`. A guest has no `vis` to resolve: on its view a piece it sees carries `t` (and, hidden from others, `up: false` and `vis`), one hidden from it `b` | 5a (Phase 5 part 1) |
| D262 | PROTO 6, STATE_V 6; MIGRATE[5] only sets `v` (no older piece has `vis`, `pv` or `po`). MODULE_V stays 1 | 5b, 5h (Phase 5 part 1) |
| D263 | The 🙈 cue as built (§5g): a piece a screen sees while the others see its back — its full form, `t` with `up: false` (pieces.js `veiled`) — is drawn face up with 🙈 on its bottom-right corner, always shown (turned upright and grown with the other badges: `--view`, `--bz`), over a faintly hatched corner of its face (`.veiled .pface::after`, clipped to its shape), and its tooltip names who else sees it ("Hidden from the others: only you can see it" / "…: you and Bob can see it"). It shows in a private zone too: the zone's label may be off a phone's screen, and each tile must read as yours. Such a piece is zoomable on its owner's screen (🔍, the long press; captioned "Only you can see this"): pieces.js `zoomable` no longer asks `up !== false` of a face it is given | 5g (Phase 5 part 2) |
| D264 | The bar's private-material buttons as built (§5g, on Phase 2's Flip). A hidden piece's Flip reads **Reveal** (still `flip`): on a piece hidden from the player as before (whether it is private can't be told from its back: an unowned piece a script hid for a seat is refused by the host, uniformly), and on the player's own private piece, a cupped die included (a shown die has no Flip). **🙈 Hide** (`hide`, key **H**) on a shown piece whose type has a back that the player may move; on a die it cups the die's handful — the dice 🎲 Roll throws with it, those that can be hidden. **Peek** on every piece hidden from the player but a board, whoever owns it (D255). The group bar gains 🙈 Hide (the members that can be hidden: a coin with no back is never sent), its Flip reads Reveal when every member it turns is hidden, and a cupped die is one it turns. t-p2-pieces' exact bar lists gain `hide` (a chit, a hand tile) and `peek` (three hidden pieces) | 5g, 2g, 4g (Phase 5 part 2) |
| D265 | (Amended by D297: the label is an HTML `.btext.zlabel`, outlined by `-webkit-text-stroke` and turned and grown about its own centre; the WebKit transform-box workaround is gone with the SVG text.) Private zones on the screen as built (§5g): drawn per board item and per screen, after the grid and spaces (pieces.js `boardSVG(type, zoneLook)`: the rest stays cached per type). Active — hatched in the owner's colour (a player's, or the seat's for a seat ref, as owner dots are), a dashed edge, and the label "🔒 Alice's rack" (`reveal`) or "🔒 Alice's screen" (`keep`), "🔒 Your rack" on the owner's own screen, "🔒 Camp · Alice's" for a zone with its own `label`; it stands just outside the zone on the side of the table's centre (`cy`, the centre in the board's frame: pieces set in a rack would cover a label inside it, and a rack at its seat's edge keeps its label off the seat label), white on a dark outline, grown with the badges (at most 2×) about its own origin — a `translate` group puts it there, and `transform-box: view-box` turns and grows it about that point: WebKit turned and scaled an SVG text about the SVG's origin, not its fill box, and the label flew off its zone — and moved away from the zone by half what it grew. Inactive (its board owned by nobody, no such seat) — drawn as any zone, "🔓 Nobody's rack". A board is drawn again when what its zones say changes — its owner, a seat taken or left, a rename (app.js `zoneBoards`, redrawn on a change of players) | 5g (Phase 5 part 2) |
| D266 | (Amended by D287: a full rack takes a piece half a step on.) "🔒 Draw to my rack" as built (§5g): on a bag with pieces that the player may handle, while they own an active private zone (racks first, then screens); a `pull` at the first free slot — each zone's bounding box on the table scanned row by row in steps of the piece's size and a 6-unit gap, a slot counting when its centre lies in the zone (`zonesUnder`, as place() reads it) and no item's box overlaps it; all taken, the first slot (overlapping); a zone smaller than a piece, its middle. The piece's size is the largest back among its bag's box's piece types (it lands hidden: its back's size), else a placeholder's: a bag shows which box made it (D88), never what it holds | 5g (Phase 5 part 2) |
| D267 | The terminal's private material as built (§5i): a snapshot's item a player sees while the others don't carries `hiddenFromOthers: true` and its full fields, and `table` ends its line "🙈 hidden from others"; `hide <id…>` sends `hide`, `group hide` a group; `reveal <id>` reaches the tab as `reveal`, which sends `flip` — and is said in the terminal for a piece face up, which a flip would hide ("reveal …: it is not face down"); the Bridge API has `hide(...ids)` / `hide(*ids)` and, beside §5i's list, `reveal(id)`; `peek <id>` of a piece the player sees is said at once with no action (as a face-up card's), else the host answers. A piece's peek reads `peek: 3\|4 Bone` — its face's label (or pips), then its type, as the REPLs print a piece (`cliPiece`) — where §5i's `peek: {name}` would have said "Bone" of every tile | 5i (Phase 5 part 2) |
| D268 | §5l's t-p5-private as built: two seated players (a desktop host, a phone guest upright and sideways) and Mallory, a raw peer, seated; §5j's attacker cases 1–9 and 11 through the bar, the keys, taps and drags, and a recursive scan of every body Mallory got. Case 10 (the order of Veiled Ranks' hidden units over 20 setups) needs that demo, and is part 3's. Case 3's "if `vis` refs that seat, Mallory now sees those pieces" covers every piece seen by that seat — the screen's unit and the seat's rack tiles alike | 5j, 5l (Phase 5 part 2) |
| D269 | Dominoes and Veiled Ranks are 🎲 games as well as 📦's built-in boxes (§5g's "the demos (`BOXES`)", 4g): `GAMES` gains `{k: 'dominoes', box: 'dominoes'}` and `{k: 'ranks', box: 'ranks'}` after Backgammon, set up as every box game is (`pickCleared`: one `loadBox {setup, clear, rules: true}`, built in, no trust dialog). Amends D231: `currentGame` marks a box game playing while the rules of the built-in box it names run (`rules.box`), and still marks nothing for the rules of a box 🎲 doesn't offer (Hexfront, 📦's alone). t-fun-games' strip list and dialog count gain the two (13 → 15 entries) | 5g, 4g (Phase 5 part 3) |
| D270 | (Amended by D294: the table is 1000 × 1500 and the rack 600 × 258, two rows of nine.) Dominoes as built (§5g): **two seats, South and North** (bottom, top), the draw game's seven tiles each — `forEachSeat` places an entry in each seat's frame but turns it by the entry's `rot` alone, so a rack can't face a side seat; along the long edges both racks lie square to their players' views. A 1000 × 1300 table (a phone held upright draws a tile 23 px wide). **28 types, one face each**, under one back `bone` (60 × 120: a face-down tile says nothing, and no `face` turns a tile into another), `stack: 'none'` (a tile set down by the line never piles), `hand: false` (§5g's decision), the face's `name` "a\|b" for the log. **The rack is 600 × 140**, not §5g's 520: nine slots of 60 × 120 at the 6-unit gap 🔒 Draw to my rack scans (D266: x₀ + 6 + 66k), where 520 holds seven exactly and an eighth tile drawn would land over the first; Draw 7 fills slots 0–6. The boneyard is a bag, face down | 5g (Phase 5 part 3) |
| D271 | (Amended by D284: the turn is a seat's, a rack's tiles are where they lie, a play is the tile taken off a rack, the round's end shows the racks.) Dominoes' script as built (§5g's light rules). **The leader is drawn by lot** (`t.random`), then the lead goes round a round each — not "the highest double leads": a line or banner naming who holds the highest double would tell everyone something derived from hidden tiles (§0.1's model: nothing hidden reaches anyone, derived or not; a script may reveal, a demo shouldn't). A play is a `move` by the player to move that leaves a tile face up and that this round hasn't played (`t.data.played`): the turn passes (`t.nextSeat`, as `turns`); `validate` keeps the boneyard's pulls and a tile's way off its rack (its centre outside the rack's rectangle) to the player to move — rearranging your own rack is free — and vetoes every `peek` (looking at the other rack is cheating at a real table; the engine's own checks already keep a rack's tiles their seat's through `po`). ⏭ Pass is offered once the boneyard is empty; a round in which every seated player passes in a row is blocked; an emptied rack is 🏆. Button ids are per player (`deal-<pid>`, `new-<pid>`): the engine matches a press to the first button of its id, so two players' buttons can't share one. New round takes every tile and the bag off and makes a new bag where it stood (`t.remove`, `t.newBag`: the facade has no toBag) | 5g (Phase 5 part 3) |
| D272 | (Amended by D285: distinct labels, faces named.) Veiled Ranks' box as built (§5g), reconciled with the engine. (a) **One shuffled group a side**, not one `forEachSeat`: a forEachSeat entry names one type for every seat, and each side's units are types of their own under their side's back; each group holds twelve piece entries at squares (c1–h2, c10–h9), `up: false`, so cleanBox's sameLooks holds them to one look. (b) **A unit's owner is its seat from the setup** (`owner: 'seat:<side>'`), not one `po` gave: an owner a zone set follows the zone (D252), so a unit stepping into the other side's rows would become theirs, and a revealed one would lose its side. (c) **A 1160 × 1560 table**, not 1600 × 1600: the field (1040) and, as chess has, room by each edge for a seat label and its player's buttons — a phone held upright draws a square 34 px wide, where 1600 gave 24. (d) A unit's face is its rank, large (the Banner ⚑, a Trap ✕), and its name, small; `upright`; `meta: {side, unit, rank}`. The log calls a revealed unit by its label ("revealed 4 on d6"), and the script's own lines name it ("South Blade (3) beats North Pike (2) at e5"). (e) The two zones are the field's own (`owner: 'seat:south'` / `'seat:north'`, `keep`), so they stay active whether their seat is held or not (D252) | 5g (Phase 5 part 3) |
| D273 | (Amended by D285: every move unzoned — no setVis or reveal after it —, outcomes announced, a draw when neither side can move.) Veiled Ranks' script as built (§5g, strict). After each move the script keeps a unit its side's (`step`): a screen hides whatever is placed in it for the screen's seat (D252), so a hidden unit stepping into the other side's rows is given back to its own seat (`t.setVis`: "changed who sees a hidden piece" follows the move), and a unit combat revealed is revealed again (`t.reveal`; its move says "moved a hidden piece" — what place() left a moment). Beyond §5g's text: a Herald's parley comes first — it parleys with a Trap or the Banner too, and nothing is removed; a Lancer's two-square step may end on an enemy (an attack); a side left with no unit that can move loses; at the end every unit is revealed; `onSelect` hints; ✓ Ready locks a side's deployment; ♻ New game for the players and the host lays both armies out again with `t.layout(box, ARMIES)` — the very entries of the box's setup, written into the script's text (`templates.js` ARMIES), the box's id kept in `t.data.box` (an export remaps it, §4c). `peek`, `flip`, `hide` and the rest are strict's "Not a move in this game" | 5g (Phase 5 part 3) |
| D274 | §5j case 10 measured in Node before the suite: over 400 fresh setups of Veiled Ranks (real random ids), a per-position best guess of a North unit's rank — by its place in z order, in key order, or by its square — scores 0.250, the best constant guess's (three Pikes of twelve). The group shuffle deals identities among places whose z, id and square stay theirs (lay, D232's "an id names a place"). t-p5-demos and Mallory's scan of real bodies are the test author's | 5j (Phase 5 part 3) |
| D275 | (Corrected by D283: the round trip held only for the cases checked; a unit in the other side's rows and one revealed behind its own screen came back wrong until then.) Phase 5 is done (TABLETOP §7), and with it the build order: both demos played in Chromium by two players and a watcher — a desktop host, an iPhone 13 held upright, a phone held sideways — Dominoes from Draw 7 through plays, a draw into a rack and a play out of turn refused, Veiled Ranks from deployment through a Lancer's double step and its blocked first square, a parley, attacks, a trade of equals, a Trap and the Banner; each exported mid-game and set up again in a fresh room with every piece's `up`, `vis`, owner, `pv` and `po` the same and its rules resumed | 5l, 5m (Phase 5 part 3) |
| D276 | Two test races found by full runs, fixed in the tests (mechanism changes, no check weakened): t-p4-hexplay read the "rolled 2 dice" line on the host's screen and the dice faces on the other player's at once, so the roll's patch could still be on its way; it now waits (up to 5 s) for that view to show the faces before the same equality check. t-p5-private (section 4) had Bob stand up — a guest's action, still on its way — and the host seat Mallory north at once, refused while north was still his ("🚫 That seat is taken"); it now waits for the host to see Bob standing first | 4l, 5l (Phase 5 part 3) |
| D277 | (Amended by D301: `mayPlace` asks the private-piece rule of any private piece a zone would act on, whoever its vis names.) Reconciles §5a ("entering another owner's private zone re-applies the entering rule") with §5j ("private zones never expose anything; they only hide"), amending D252: **a zone never widens who sees a piece.** A zone acts on a piece set down in it (`zoneActs`) unless the piece is that owner's already (`pv`, its `vis` naming the zone's ref) or is set down `unzoned` (D278); a **screen** (`keep`) never takes over a private piece whose `vis` doesn't name it — it keeps its `vis` and owner, and its `pv` (another zone's) goes; a **rack** (`reveal`) takes one over — a tile handed from rack to rack — only when the one who sets it down sees it or owns it (`mayPlace` asks seen's private-piece rule, before anything changes: "🚫 That piece is hidden", a group's member alone). A face-down piece hidden from everyone (no `vis`) enters as before: anyone who may handle it may turn it over (§5c), and a hand shows its holder what it holds. Closes the reviewers' take-over (Mallory dropping South's unowned private unit on her rack saw it, South lost it) and Veiled Ranks with its rules off (a unit stepping into the other side's rows was shown to them) | 5a, 5j (Phase 5 fix-up) |
| D278 | **`unzoned`**: a piece set down as it is — no private zone where it lands hides it or changes who sees it. The setup grammar's piece entries take `"unzoned": true` (laid out as written: up, `vis`, owner; an export writes it, D283); `t.move(id, at, {unzoned: true})` (its only option; anything else is a TypeError); and a bag's draw whose member has no back lands shown, unzoned — **a pull is never refused for what it drew**: D252 refused a person's pull into a private zone when the pending member had no back, and since a refused draw stays pending (D114) the refusal told what the bag's next pull would be (the reviewers' pull oracle) | 5a, 5h, 5e (Phase 5 fix-up) |
| D279 | **A hidden piece snaps by its back** (closes D210's case, carried in the 4B notes): a piece face down (or drawn by its back, `b`) whose back a die of its box wears never snaps, whatever its type — before, a hidden token set on a spot took an address and a hidden die under the same back didn't, so its landing told a die from a token. `snaps` reads it alike on the host and every viewer (`dieBack`); a hide or a turn face down drops the address of a piece that no longer snaps (`facedown`), a reveal gives a token back its spot's address by containment (`unveil`), and a save's token hidden under a die's back loses its address quietly at load. core-p4's D210 check is a mechanism change: the tokens of its shuffled group keep their spots and carry no address. No built-in box shares a die's back with a token (D286's cup is the dice's own) | 2d, 3a, 5d (Phase 5 fix-up) |
| D280 | **The private-piece rule on everything that would show a private piece or strip who sees it** (extends D254): `privy` (a piece with no `vis` passes; else seen's: a viewer, or its owner, or the uniform "🚫 That piece is hidden") guards `flip`, `toHand`, a claim, and now `stack` (the piece stacked and the one stacked onto), `toPile`, `toBag` and a split onto a bag — a pile drops `vis` (D249) and a bag hides from everyone, so a later draw would show the piece to whoever drew it (the reviewers' launder: stack South's tile onto a loose one, draw the pile's top into a hand) — and a placement on a rack (D277) | 5c, 5j (Phase 5 fix-up) |
| D281 | checkPatch's gate on `pv` and `po` as the engine writes them (`visProblem`, amends D260): `pv` only on a piece face down with a `vis`, `po` only on one face down with an owner — a Worker's patch with either on a shown piece is refused whole (the test author's CP′). What keeps the engine's own writes so: `setOwner` (a claim, the host's give, `t.setOwner`) takes `po` (the owner given is real: a reveal must not strip it), and `t.hide` / `t.setVis` to nobody take `pv` (a zone hides a piece for its owner). A save's malformed ones are dropped loudly, as before | 3f.6, 5f, 5h (Phase 5 fix-up) |
| D282 | (Amended by D293: a `back` leaves out what the job wrote.) **A rules refusal of an action naming the actor's own hidden piece is the actor's alone** (`secretOf`: a piece the action names lies face down and the actor sees it): no "blocked {name}: {why}" line — a script's words may name what it is ("The Banner never moves", "A Lancer moves one or two squares") — and nothing re-sent to the others (`named`): the effect `{t: 'back', p, ids}` (EFFECTS; only to the job's actor, speakerProblem) draws the named items again on the actor's screen alone (the app's private note `back`, `letGoOf`: their drop is let go of at once, not after the 1.5 s hold), a hand action's hand going in their own part. A group's such vetoes, its member refusals, a ruled no-op and a flood refusal (`refreshFor`, drained by the app) take the same path. **A private piece's live drag is relayed to nobody** (`drag`): its way, and a refused drop's way back, would show the others which piece its player reached for; they see it where it lands. Veiled Ranks keeps its rank-naming refusals: only the unit's player reads them while it is hidden | 3f.4, 5d, 5j (Phase 5 fix-up) |
| D283 | **Export writes what re-placing would not give back** (amends D259; corrects D275's round-trip claim): a piece an active private zone holds goes without `up`, `vis` and its zone-given owner only when setting it up again re-derives it exactly (`rd`: face down, `pv`, its `vis` the zone's ref alone, a seat or a seated player, its `po` owner that ref); any other piece in a zone goes as it lies — hidden for whom it is (`up: false`, `vis`, owner, `po`) or shown — with `"unzoned": true` (D278), and a piece with `pv` and no zone under it (its rack moved away) goes as an ordinary hidden piece. A viewer or owner that can't be written (not seated) is left out with a warning: the piece goes hidden from more, never shown. The cases the test author and the reviewers found wrong now round-trip: a unit in the other side's rows, a unit revealed behind its own screen, a rack tile `t.setVis`'d to another seat, a gem on a rack given to someone else since, tiles whose rack moved away, a rack whose owner stood up (hidden from everyone) | 5h, 5l (Phase 5 fix-up) |
| D284 | Dominoes reconciled (amends D271). **The turn and the lead are seats** (`t.data.turn = 'south'`), `public.turn` the seat's holder: a seat that changes hands mid-round goes on with its new player (the reviewers' deadlock), and onLeave is gone (the seat keeps the turn for its player). **A rack's tiles are where they lie** (`rackAt`, by a tile's centre): `held` counts them whether hidden or turned up (a tile turned up on a rack no longer let its player go out with tiles left); another seat's hidden tile is left to the engine's uniform refusal, a shown one is refused ("That tile is on {name}'s rack"); a tile leaves a rack only by a move — a turn, a bag, a hide there is refused ("Play a tile by moving it off your rack"; `hide` anywhere: "Tiles hide in your rack") — on its seat's turn, and that move is the play (validate notes it, `t.data.taking`; onAction counts it once the tile lies on the table face up): nudging a line tile is no play, and a played tile never goes back onto a rack ("That tile is played"). The boneyard draws into the drawer's own rack only ("Draw into your rack"). **A round's end shows the racks**: a domino or a blocked line reveals every tile still on one, for the count. t-p5-bones reads the player to move from `public.turn` (a mechanism change; it read the old `t.data.turn` pid) | 5g (Phase 5 fix-up) |
| D285 | Veiled Ranks reconciled (amends D272, D273). **Every move is unzoned** (`step`: `t.move(id, sq, {unzoned: true})`, deployment swaps included): a unit keeps how it is seen wherever it lands — hidden for its side in the other side's rows, shown once combat showed it — so step() no longer re-hides or re-reveals, and the log no longer says "changed who sees a hidden piece" or a false "revealed 4 on c9". **Every combat outcome is announced** (`t.announce`: a banner on every screen — the defender learns what took their unit). **Neither side able to move is a draw** (`t.win([])`), the side to move alone stuck still loses. **Each kind its own label** (the Lancer 1», the Herald 1✉, beside ⚑, 4, 3, 2, ✕) and each face a name ("South Pike"), which the log calls a shown unit: `faceLabel` and `pieceName` prefer a face's `name` to its label (amends D161, whose name came only for a face without a label: no other box has both). A refusal of a hidden unit's move is its player's alone (D282) | 5g (Phase 5 fix-up) |
| D286 | **The built-in dice wear a cup** (`CUP`, `#7c2d12` with "?"; Backgammon's and Hexfront's die types): 🙈 Hide, the README's and the help's "on a die it is a cup", is reachable from the built-in material. No other piece wears the cup, so a hidden die and a hidden token never share a back (D210, D279). A saved table's box from before is a box of its own content (built in by content, D88's isBuiltin), and plays on unchanged | 5g, 2g (Phase 5 fix-up) |
| D287 | (Amended by D294: a rack of two rows; past its slots the half steps that leave no tile more than half covered.) **🔒 Draw to my rack on a full rack** (amends D266): with no free slot, the piece lands half a step on from a slot, where it covers the least of what lies there (`rackSlot`'s `cover`): a draw game's tenth tile lands between two, all three in sight — before, every tile past the ninth landed exactly on the first slot's | 5g (Phase 5 fix-up) |
| D288 | (Superseded by D297: board text is HTML and stays drawn while the view moves; `#table.moving` and `moving()` are gone.) (Amended by D295: the row's task budget is B4_SETTLE's.) **No board text is drawn while a gesture moves the view** (amends D246/D247, whose "a gesture frame lays nothing out" held only for a table with no SVG text): any `<text>` in a board's SVG — printed coordinates, a space's or a private zone's label — laid the page out in every frame of a pan, pinch, twist or wheel zoom (16 layouts a wheel, 49–101 a pinch with one rack on a 1,000-piece table, p95 33 ms), each followed by the hover hit-test of the whole table. `#table.moving` (app.js `moving`, written as `viewMoves()` changes: a pinch starts or ends, a felt drag first moves or ends, a wheel turns or rests) hides `.psvg text` (style.css). t-p1-bench's new B4 row: the pinch and sixteen wheel turns over 1,000 ×3 stacks beside a chess-labelled board and a rack, under B4's budgets and B4_LAYOUTS, the text hidden while the wheel turns and back at its rest | 2k, 4g, 5g (Phase 5 fix-up) |
| D289 | **Only a wheel over the felt zooms the view** (amends D248): #table-wrap's wheel handler takes an event whose target is the wrap itself or inside #table; over any popover — the bar, the inspector, the 🔒 For you card, the game strip, the seat menu — the wheel is the popover's (it scrolls the card: before, it zoomed the table behind it) | 4g (Phase 5 fix-up) |
| D290 | **🙈 Hide on a die cups the dice of its handful it can cover**: a locked die other than the one tapped stays out (CMDS.hide), as 🎲 Roll throws the handful — before, one locked neighbour refused the whole cup ("🔒 That is locked in place"), hide being all or none | 5g (Phase 5 fix-up) |
| D291 | Two face fixes (style.css). **A domino's halves each in its own half**: `.pips2 > .pips { grid-area: auto }` — the face layers' `grid-area: 1 / 1` put both halves of every two-value pip face in the first cell since Phase 2B (Dominoes is the first built-in to use one: 5\|6 drew a seven-dot union). **A 🙈 piece's name reads along the top of its face** (`.veiled .plabel + .ptext`), clear of the badge that holds its bottom corner (Veiled Ranks' "Herald" read "erald" on a phone) | 2g, 5g (Phase 5 fix-up) |
| D292 | The fix-up's tests: core-p5's section (F) (each closed leak, Dominoes by seat, Veiled Ranks' moves, combat and draw; it fails 28 times against the code before it), the new E2E suite t-p5-fix.js (a domino's halves on both screens, a full rack, a hidden unit's refusal kept to Alice while Bob receives nothing, a cup over unlocked dice, a wheel over the 🔒 card), t-p1-bench's board-text B4 row (D288). Mechanism changes, no check weakened: core-p4's D210 check (D279); t-p5-bones waits for a tile before reading it (a race the reviewers saw crash it under load) and reads the player to move from `public.turn` (D284); t-p5-veil-cli keeps every msg its tabs' snapshots carried (a msg rides one snapshot, the next one ≤ 500 ms later goes without it: reading the latest alone missed Alice's peek under a full run's load) | 5l (Phase 5 fix-up) |
| D293 | **A `back` leaves out what the job wrote** (amends D282): `named` emits `{t: 'back', p, ids}` only for the named items the job did not write (`J.first` holds no pre-image of them), and none when that leaves nothing. A handled action — every legal Veiled Ranks move, which the script's step() makes — wrote its unit: the broadcast patch carries it, and a `back` (a note, sent at once) outran that patch, so the guest's letGoOf drew the unit from a view that still had it on its old square: under prefers-reduced-motion a one-frame flash back on every legal deploy or move (the reviewers' flicker probe, 3/3 on desktop and iPhone; the host's own moves were not affected). A veto rolls the job back first, so its `back` still names the piece; a handled action that left the piece alone still draws it back. core-p5 F8 checks both; t-p5-fix §2 samples Bob's unit every frame of a legal step on his phone (reduced motion): 0 frames off its new square (1 of 128 before) | 3f.4, 5j (Phase 5 fix-up 2) |
| D294 | (Amended by D298: its "none more than 45%" is Dominoes' two-row rack's; a rack too small for what it holds must cover some.) **Dominoes' rack holds a draw game's whole hand in sight** (amends D270, D287): the rack is 600 × 258 — two rows of nine 60 × 120 slots at the 6-unit gap — on a 1000 × 1500 table (the play area between the racks stays about 600 units deep; the near edge of each rack is where it was, 140 from its seat). `rackSlot` takes the first free slot of the player's zones; with none, a half step on from a slot that lies wholly inside its zone's box (the last one overhung the rack before), choosing the spot that leaves the most covered item there least covered, counting what already lies over it (`worst`: the sum of what the items above an item cover of it, in whole percents; ties go to the first) — the half steps fill every other gap, none more than 45% over a tile. 18 slots and 8 such half steps: 26 tiles, more than the 21 a two-player draw game can hold. Before, a single row of nine and the least-covered candidate by area: from the 18th tile on, a draw landed exactly on another tile (3 of 21 hidden whole), and tiles between two half steps showed 6 units of 60. t-p5-fix §1 draws the whole boneyard into one rack: 21 tiles at 21 places, the most hidden 45% by all the tiles above it, every one wholly on the rack | 5g (Phase 5 fix-up 2) |
| D295 | (Superseded by D297, and corrected: the raster it measured depends on the scale the table's layer was last rastered at, not on the piece count — 52–91 ms on Veiled Ranks after a deep Dominoes pinch; and B4_SETTLE was a relaxed budget, not a mechanism change. D297 removes the cause and puts the row back on B4_LONG.) **The board-text B4 row's task budget is B4_SETTLE's** (amends D288; as the paused pinch's, D102): hiding the boards' text at a gesture's first frame and showing it at the lift repaint the boards — once each, never per frame. Measured on the bench's phone (CPU × 2, 1,000 ×3 stacks): the toggle's own restyle is 0.5–0.9 ms (so scoping the class to the boards, the reviewers' first suggestion, would save nothing), and the frame it lands in ran 56 ms once under run-all's load (none over 50 alone). On a view turned half round from a board's (the second player of every two-player box), the turned labels are cc layers of their own at rest, and every piece drawn after them goes into an overlap layer that hiding them merges back into the table's: a trace shows the first frame's 110–130 ms are the main thread waiting on one raster of the table layer (110 tiles), not style or layout — on a game's own few dozen pieces that raster is a few ms. Keeping the text drawn instead lays the page out every frame (D288's 33 ms frames), so the one raster stays | 2k, 4g, 5g (Phase 5 fix-up 2) |
| D296 | (Corrected by D299: t-p1-bench's board-text row on B4_SETTLE was a relaxed budget, not a mechanism change; D297 puts it back.) The second fix-up's tests. New checks: core-p5 F8 (a refused Banner step's `back` names it; a legal step has none, D293), t-p5-fix §1 extended to the whole boneyard with aggregate coverage (D294) and §2's every-frame sample of Bob's legal step (D293). Mechanism changes, no check weakened: t-p5-fix §1's rack geometry comes from the box's rack type (it hard-coded 600 × 140) and its pairwise coverage check became the stricter aggregate one; t-p1-bench's board-text row takes B4_SETTLE (D295); t-p4-select waits for the inspector to open before reading its box (the tap is handled a moment after Playwright's returns: under run-all's load the box was read while it was still closed — the reviewers' failure, which passed alone) | 5l (Phase 5 fix-up 2) |
| D297 | **A board's printed text is HTML** (supersedes D288 and D295; amends D91, D97, D265): `boardSVG` returns the board's SVG and, over it, a `div.btexts` of `span.btext`s centred on their anchors (`left`/`top` in board units, `translate: -50% -50%`) — `.coord` (`rotate` by −(view + rot), `scale: min(--bz, --lmax)`, `--lmax` on the layer), `.slabel` (by the nearest half turn), `.zlabel` (a private zone's: white on a 5-unit `-webkit-text-stroke` painted under it, moved away from its zone by half what it grew, `scale: min(--bz, 2)`). `#table.moving` and app.js `moving()` are gone: the text stays drawn while the view moves. Why: an SVG text is laid out again whenever the view's scale changes (D288's 49–101 layouts a pinch), and SVG text with a transform of its own — a turned coordinate, or a grown one under the old `.blabels` group's opacity — could not be drawn in the table's compositing layer: CDP's LayerTree showed 14 layers over Veiled Ranks at rest, at a view turned 180° and at 0° alike (the text, and the zone hatches over it as overlap layers), 10 with the text hidden; transform none and scale none on every text gave 10, either alone did not. So D288's hiding re-layerized the table as each gesture began and lifted, and the table's layer was rastered again at the scale it was last rastered at — after a pinch deep into Dominoes, 52–91 ms at the start of 11 of 13 Veiled Ranks pinches for the North player (the reviewers' flow; 79, 65, 52, 57 ms here before the change). Spans turned and grown by `rotate`/`scale` are drawn in the table's layer (10 layers at rest at either angle) and lay nothing out as the view moves: in the same flow, no long task in 7 pinches, 2–3 layouts each (3–5 before). t-p1-bench's board-text row is back on B4_LONG while the fingers are down and asks the text drawn at every wheel turn (alone: the pinch with no long task and 2 layouts, the wheel 1 layout in 16 turns); its new half-turned row runs the reviewers' flow on the bench phone under B4's budgets (no long task in its 6 measured pinches, nor in the unmeasured first one; 2–3 layouts each, 5 in the first; amended by D300: the row runs last in the suite). WebKit (iPhone 13 and a desktop) reads the HTML text as Chromium does: p2t-lib's `upright` passes over Veiled Ranks seated North and South | 2g, 2k, 5g (Phase 5 fix-up 3) |
| D298 | **🔒 Draw to my rack keeps every tile in sight only on a rack that can hold them** (amends D294, D287): its half steps find a spot where nothing ends up more than half covered while one is left — 26 tiles on Dominoes' two-row rack, 13 on a one-row rack of nine (a box's own, or a Dominoes table saved before D294 with its 600 × 140 rack, D88) — and past that a draw lands where it covers least, which must be something. README says so (it promised it for any rack). Finer steps were measured and left out: simulated on a one-row rack of nine with 21 tiles, steps of 6 units cut the tiles stacked exactly on another from 4 to 1 but still left 3 hidden whole by those above (4 with half steps); on Dominoes' rack they lowered the least-seen tile from 55% to 50% in sight. rackSlot's zone rectangle is `rect` (it shadowed the bag's `box`) | 5g (Phase 5 fix-up 3) |
| D299 | (Amended by D300: the half-turned row runs last in the suite.) The third fix-up's tests. New: t-p1-bench's half-turned row (D297). Mechanism changes, no check weakened: p2t-lib's `boardTexts` maps each HTML text to the screen with three zero-size probes put in it (as `badgeAngles` reads a badge), where `getScreenCTM` read an SVG text; the label selectors of t-p2-pieces, t-p2-demos, t-p2-tables, t-p5-demos, t-p5-private, t-p5-veil and t-p1-bench (`.btexts .btext`, `.btext.coord`, `.btexts .slabel`, a file's `y` read from its span's `top`); t-p1-bench's wheel check asks the text drawn at every turn (it asked it hidden, D288's mechanism); t-p4-fix §7 waits for each pick to show before reading the selection (`picked(p, n)`, as t-p4-select does since D296: Carol's two taps were read before they were handled under run-all's load) and stamps the bar's buttons going off and on in the `disabled` setter itself — a MutationObserver's callback runs once the task that armed the bar is done, late under load, and the 400 ms hold-off once read 390 — and asks ≥ 399 ms (it asked ≥ 390); t-p1-bench's `tapOne` taps each stack at the point of its face farthest from any ×N badge, where it tapped its centre — on the phone's fit of 1,000 ×3 stacks each grown badge covers its own stack's centre, a tap there opens the inspector, and all twelve tries could (the twist-with-a-bar row failed so in three full runs since Phase 5 part 3; a probe of that state: 12 of 12 centre taps opened the inspector, the first face tap the bar). A correction: D296 filed the board-text row's B4_SETTLE under mechanism changes; it was a relaxed budget, now reverted (D297) | 5l (Phase 5 fix-up 3) |
| D300 | (Corrected by D310: the seats taken on joining can be restored; the row still runs last. Since D311 the host's `endSeats` also ends named seats, and a card game from 🎲 ends them.) The fourth fix-up (amends D297, D299). **A board's text layer is aria-hidden**: `boardSVG`'s `div.btexts` carries `aria-hidden="true"`, as the SVG that held the text before D297 did — moving the text out of it into HTML had made a screen reader read out every coordinate of every board (16 on draughts' board, 20 on Veiled Ranks'), and the private zones' labels with them; nothing on the table is described to assistive tech (its items have no accessible names), so the labels stay hidden too, as they were. t-p2-pieces checks the board's one text layer aria-hidden on both screens and devices, t-p5-private every rack's and screen's. **t-p1-bench's half-turned row runs last**, after B11: it sets up Veiled Ranks, whose named seats put Bob among the watchers and Pat North, and the engine has no way back to the seats each player took as they joined (`clear` and `size` keep the seats; a box without seats ends the named ones but seats each watcher anew — `assignSeat` — and keeps the others' angles; no action sets an angle), so in the third fix-up every row after it — B12, B1′ and B3 (Bob's 50 moves as a watcher), the 1,000-card pan with the phone turned 180°, B6, B8, B15, B14 — ran on those seats, silently (their budgets passed). The card part now begins by checking that the host has no named seats and Alice, Bob and Pat sit at the angles they took as they joined (`seating()`, read after the three join). D297's account of the row is corrected: no long task in its 6 measured pinches nor in the unmeasured first one, 2–3 layouts each (5 in the first) — it said 7 pinches, 3–5 layouts | 2g, 2k, 5l (Phase 5 fix-up 4) |
| D301 | The final review, hidden information. **`t.setFace` and `t.setVis` never skip a piece lying hidden** (`up: false`): it is touched, logged and marked even when its face or its viewers are already the ones asked, so the line, the name bulb and the re-send are the same whatever it hid — skipping it told every player which hidden pieces already showed that face (four cupped dice, two at face 0: three re-sent, three bulbs, "turned 3 pieces") or were already seen by those refs. A face-up piece already right is still skipped. **Amends D277**: `mayPlace` asks the private-piece rule (`privy`: seen, or owner) of anyone whose placement an active zone would act on, whenever the piece is private (has a `vis`), whoever the `vis` names — it asked only for a piece foreign to the zone, so Mallory could drop a piece hidden for North (§5j case 9: nobody's) on North's own rack, which marked it `pv` and North's owner, and North's next ordinary drag off his rack turned it face up for everyone. A non-viewer now gets the uniform "🚫 That piece is hidden" (a group's member alone), and the owner or a viewer racks it as before. core-p5 (F9) | 5a, 5c, 5e, 5j (final review) |
| D302 | (Amended by D317: the refused wait in the order they first knocked. Amended by D318: a connection with no player yet is priced by the connection.) The final review, the network gate (app.js `actA.onMessage`, the one door for a peer's action). **Depth**: an action nested deeper than `MAX_DEPTH` (64) arrays or objects is refused ("🚫 Malformed action", `tooDeep`: an iterative walk) — JSON.parse takes any depth, a structured clone (the rules Worker's job) and every recursive walk (`frozen`, JSON.stringify) overflow the stack: one chat with a junk field 100,000 deep switched the host's rules off for everyone (a strict game's rules lifted by an unseated newcomer), and with them off it threw half-applied (the chat line written). A box, the deepest a guest sends, nests about 10. Behind the gate, a peer's job the Worker can't be posted is that action's refusal alone ("🚫 That action could not be read", what it named re-sent), never the script's failure; the host's own jobs still take the rules down. **Identity**: a seat key is 16 to 64 characters (ours are 32; the host saves every key it binds, so a 20 M-character one grew every save by 20 MB); a connection (Trystero peer id) registers one player for good — kept past a leave (`firstPid`), so a page that rejoins can't mint a player, a key and an image budget each time; and the table takes new players `NEWCOMERS` (20) at once, then one every `NEWCOMER_MS` (3 s), refusing the rest with a notice (they keep knocking). No hard cap on players: a churner would fill it and lock everyone out, and evicting players a script may know of is more than a final review should change. **Images**: `PEER_ASSET_BUDGET` (64 MB a minute) and "each image at most twice a minute" are kept per player, shared by all their connections and outliving a leave until a window has passed since its last send (`pulls`); and the whole table is sent at most `HOST_ASSET_BUDGET` (4 × 64 MB) a minute — whoever's request crosses it waits, told as for its own budget (the guest's note now says both figures) | 0.1, 1b.5, 1j, 3f (final review) |
| D303 | (Amended by D317: one that holds no table — a lost marker — never replaces the IndexedDB table, which resumes, `behind`. Amended by D318: what was left pending over the IndexedDB table it replaces goes with it.) The final review, upgrades. A pre-Phase 1 save (localStorage) written AFTER the room's IndexedDB save — a tab of the previous Card Table, left open across the deploy, went on playing and saving after a new tab moved the table to IndexedDB — is newer: `loadSave` resumes it through `migrateLegacy`, which replaces the room's IndexedDB save and its whole catalog in one transaction (`writeSave(…, fresh)`) before the old keys go, and the host is told ("Resumed this table's newer save, made by a tab of the previous Card Table"). Before, it was kept aside with a console warning while the older copy resumed, and deleted on the next load. One not newer is superseded and removed, as before | 1h (final review) |
| D304 | The final review, the version gate names the side that must reload (amends §1b.6's wording): an action of a NEWER wire version is refused with "The host runs an older Card Table — ask them to reload", and the host is told once "A player has a newer Card Table — reload this page to let them in"; an older or missing `_v` keeps "This table runs a different version of Card Table — reload this page". A body of another version tells a guest "The host runs a newer Card Table — reload this page" when it is newer, "The host's page runs an older Card Table — ask the host to reload it" when it is older or unversioned, and a hosting tab "Another tab hosts this table on another Card Table version — close it or reload it". After a deploy, a long-running host tab is the stale one half the time, and nobody told its player | 1b.6 (final review) |
| D305 | The final review: the catalog a host sends a new connection (`sendCatalog`) is marked whole (`'*': 1` among the ids of the decks and boxes messages): a guest drops what a whole catalog lacks — the host resumed without it (a reload that lost a box before its save, another hosting tab won, a fresh table) — and, for a box it uploaded itself, is told "The host's reload lost «…» — upload it again". Deltas still only merge | 1b.5, 4c (final review) |
| D306 | The final review, cache skew beyond the modules (§0.2's MODULE_V): `index.html` loads `style.css?v=MODULE_V`, so a cached stylesheet of the previous version never pairs with this page; and app.js, before it wires a single element, checks for one this version's page has (`#box-btn`): a cached `index.html` of the previous Card Table (which loads `app.js` with no `?v=`, so it gets this one) shows the "Card Table was updated while this page loaded — reload this page" banner and stops there (a top-level await that never settles: no uncaught error), not a TypeError toast. `tests/parse.js`, run first by run-all, fails a local import, or `index.html`'s `app.js` or `style.css`, without `?v=MODULE_V`, so a bump can't leave one behind | 0.2, 1b.6 (final review) |
| D307 | The final review, browsers. (1) A touch on a hand card is never `preventDefault`ed (a mouse's still is: no selection, no native drag): in WebKit (every iOS browser) a cancelled pointerdown loses its tap's click — no zoom, and a hand ask (`pick: 'hand'`) could not be answered on an iPhone. (2) The view sheet is a `<style>` element's: constructable stylesheets came to Safari only in 16.4, and app.js threw "Illegal constructor" on iOS 15.4–16.3, which main supported. (3) The one-row group bar is centred by two empty flex ends with auto margins (cancelling the gap), not `justify-content: safe center`, which Safari before 17.6 and Chrome before 115 drop — their `center` put ✕ and the chip out of reach on a 360 px phone. (4) `opaque()` counts alpha ≥ 250 as opaque: WebKit's smooth downscale leaves 254 on a few pixels of an opaque photo, which went to PNG at 4.6–7× the JPEG. (5) Hand cards and the hand ghost carry `-webkit-touch-callout: none`, and image faces `draggable="false"`. (6) `html` is `touch-action: pan-x pan-y` and `#table-wrap` `none` (iOS ignores `user-scalable=no`: a pinch beside a round felt or on the toolbar zoomed the page); desktop Safari's trackpad pinch (GestureEvents, not a ctrl+wheel) zooms the table as the wheel does (`wheelZoom`), unless pointers already pinch (iOS sends both). (7) A bridge reply that isn't JSON says so ("the bridge's reply is not JSON"), not Safari's "The string did not match the expected pattern". (8) `navigator.storage.persist()` is asked from a game box upload too (`askPersist`), and README's honest limits name Safari's 7-day storage cap and the supported browsers | 2g, 4g (final review) |
| D308 | (Amended by D317: any page's upkeep sweeps the marks no boot needs. Amended by D318: a pending state applies only over the IndexedDB table it was made over, `behind` or not. Amended by D319: a seq alone is said in the boot's one toast; over a pre-Phase 1 table migrated with no IndexedDB record, it applies.) The final review, amends D10 and D99: a host's `flushSave` leaves in `ct-pending-<room>` the whole state it meant to save (`{seq, state}`, through `snap()`), when that names no deck or box the room's saved catalog lacks and fits in `PENDING_MAX` (2 M characters), else its seq alone, as before. At boot (`checkPending`), a pending state ahead of the IndexedDB save — of this STATE_V or older — is resumed (with that save's catalog) and saved at once; a seq alone still says "the last moment of play before the reload wasn't saved". In WebKit a pagehide's IndexedDB write never commits (3 reloads of 3), so every Safari reload lost up to a second of play; the localStorage write is synchronous | 1h (final review) |
| D309 | The final review, performance on the 1,000-piece table. (1) **Live glides end together**: `endLive` queues the element and one microtask (`endLives`) reads every glide's place, then writes them all, then flushes once — each `getComputedStyle(el).translate` after another element's writes laid the whole table out again (one layout per member: a 200-member group drop a phone watched dragged was a 652–924 ms task of 282 layouts; now 5 layouts, no long task). (2) **A dragged piece moves by `translate`** from the left/top it had (as a group's members do), written as left/top once at the drop (`dropEl`, unanimated); the snap chip's text is written at most every `CHIP_MS` (150 ms; at once after a pause, the latest after it); `.item.dragging`, the snap ghost and chip, and the hand's ghost (`#ghost`, moved by translate too) have `will-change: translate`. A one-piece drag on the B4 phone ran 33 ms frames (239–276 layouts in 4 s, each followed by the hover hit test of the table); now 16.7 ms p95, about one layout in three frames. t-p1-bench adds both rows: a 3 s drag on the phone (B4's long-task and rAF budgets, at most one layout in two frames) and a watched 200-member drop after a live group drag (no task over B4_SETTLE, at most B4_LAYOUTS layouts) | 2k, 3g, 4g (final review) |
| D310 | The final review's tests, and a correction to D300: the seats the players took as they joined CAN be restored — a seatless box (with one type: `cleanBox` refuses `types: {}`), everyone to the watchers, then `sit` in join order (`assignSeat` gives a round table's first player 90°, the second 270°, the third 180°); the half-turned row still runs last instead, and tests/README and t-p1-bench say so. New: t-final-compat (the version gate both ways and two hosting tabs; a whole catalog dropping a lost box; a previous `index.html`; WebKit's lost pagehide write, simulated by a transaction that never completes; a touch on a hand card, no constructable stylesheets, the row bar's ends, a trackpad pinch, `persist()` from a box upload), core-p5 (F9), t-p3-attack's deep actions with the rules on, t-final-sec's gate (depth with the rules off, a million-character key, a rejoin under a new id), t-p1-flood's per-player budget (a second connection, then a reconnect, get nothing more that minute), t-p1-review-store (9), t-p4-boxes' WebKit alpha, t-p1-bench's two rows. Mechanism changes, no check weakened: final-lib's Mallory installs a raw-JSON send before Trystero loads (`{__raw}`; `M.deep`); p3-lib's `preview` waits up to 500 ms for the chip to show the spot's address (CHIP_MS); t-p1-bench and t-p2-tables read the view sheet from `document.styleSheets`; t-fun-motion reads where a card is drawn as left/top plus its translate; t-p1-flood expects the guest's new wording of the paced images | 5l (final review) |
| D311 | (Amended by D321: pieces on the table make it a board game's too, and the card game starts afresh there.) (Amended by D320: End the named seats asks first mid-game; a card game that deals from a deck gets one on the cleared table.) The final review's second fix-up, seats across games (no decision covered this). **A card game from 🎲 takes the table from a board game**: `GAMES` marks the games that deal to every player (`cards`: Hold'em, Cards Against Humanity, Bridge, the simple dealer); picked over a box set up (`lastSetup`) or named seats, the confirm says what goes ("Clear the table and start Texas Hold'em? The board, its pieces and the named seats (Light, Dark) go", and a kept game's state) and `pickGame` sends `clear`, `endSeats`, then `setRules` — kept, the two named seats left the third player watching, dealt nothing, with no way back but a seatless box. Turn order ("any game you like") and the free table keep the table: Draughts with turns stays possible. **`endSeats`**, a new host-only action (`HOST_ACTIONS`; a guest's gets "🚫 Only the host can do that"), is core's `setSeats(p, null)`: every watcher sits (`assignSeat`), the others keep their angles, the gone seats' pieces belong to nobody, the log says "removed the named seats: everyone sits where they like"; with no named seats it changes nothing. The host's seat menu offers it on any label ("End the named seats"). final.test (1), t-final-play (1) | 2a, 2g, 3g (final review B) |
| D312 | The final review's second fix-up, removals. **🗑 of one item that holds many asks first**, as a group's (D235, GROUP_DEL_ASK): a stack, pile or bag of more than 5, and any supply — the first press turns the bar's 🗑 into "🗑 Remove all 28?" ("🗑 Remove the supply?") for ARM_MS, the second removes; the Delete key removes at once (`armDel`, one helper for both bars). One tap removed a 28-tile boneyard. **Dominoes' rules refuse every `del`** ("The tiles and the boneyard stay on the table"): a deleted boneyard ended the round for both players ("set the box up again from 📦"). final.test (2), t-final-play (2) | 2g, 4g, 5g (final review B) |
| D313 | (Amended by D317: (2) keys on the named seats too, so a new game on a table of the same size starts the view afresh.) The final review's second fix-up, play on phones and desktops. (1) **The watchers' box places the labels again when its size changes** (`renderWatchers` says so, and `renderAll` draws the labels after it, placing them again on a new size): a game start that made a player a watcher drew the labels with the box's size 0, then nothing moved them, and the box covered the top label ("⏳ White — Ann") on a 360 px phone. (Placing them from `renderWatchers` itself read the labels of the table before — named seats just ended — and threw.) (2) **A new table shape or size starts the view afresh** (`setTable`: zoom 1, no pan, the seat's turn, as 🧭): the last game's pan — a drag on a piece one may not move pans (D66) — left the next game's own area off-screen. (3) **A pan that starts on another player's piece says whose it is, once per owner** ("That piece is Light's — only Ann moves or removes it"): a jumped man or a hit checker is taken off by its owner, which nothing said; the Draughts and Backgammon pitches say it too. (4) **The log follows its newest line by its own scroll state** (`logPinned`, read off its scroll events, kept by a ResizeObserver): measured as a line came, a log the hand bar's return had shortened by 140 px never followed again. (5) **A guest's box is said on the host's screen** ("Bo added «X» — 📦 to set it up") and 📦 is marked until it opens. (6) **The 📦 list is rewritten only when its markup changes** (the string written, not `innerHTML`, which the browser writes back its own way: a name with an apostrophe rebuilt the list on every patch, losing the focus and a Set up click). (7) **A setup is checked before anything is asked**: `setupRefusal` runs the setup on a copy of the table (createTable over the state without its rules, the page's hooks) and shows core's own refusal at once ("needs 4 seated players (3 are seated)") instead of the confirm and the trust dialog first. (8) Reveal on a cupped die lifts the whole cup (the veiled dice of its handful, one `group` flip), as Hide and Roll take the handful: two dice cupped together are shown together. (9) The 📜 dialog redraws while open when the rules start, stop or change (a guest's shows the new script). (10) Dialogs: 📦 and Help open at their heading (`autofocus`, not the first link, and 📦's list drawn before it shows); Help's and 🎲's Close are sticky at the bottom; the name offered is selected. (11) Touch targets of 44 px (`pointer: coarse`): the seat menu, the bar's buttons' width, a seat label's tap reach (`TAP_PX`). Not the rules row: 44 px buttons made Hold'em's row cover the board on a phone held upright (t-final-layout), so it keeps its height (D172, D174). (12) The keyboard and names: a seat label with a menu is `role=button`, Enter or Space opens the menu; the inspector's rows are buttons; icon buttons have `aria-label`s; an owner's dot names its owner. (13) The terminal bridge pushes between polls only while connected, and keeps at most 200 undelivered messages (the oldest go, said): a tab with no bridge logged 2.5 errors a second. t-final-play, t-p2-demos | 2g, 3g, 4g (final review B) |
| D314 | Extends D162 to the hand-played boards: **Draughts' table is 1000 × 1360** (the 840 board, 80 at its sides, a 260-unit band by each seat's edge) and **Backgammon's 1480 × 1520** (the 1400 × 1000 board, 40 at its sides, 260-unit bands; the doubling cube in Light's band by the trays, off every space), where §2g said 1400 × 1200 and 1800 × 1300: a phone held upright fits a table to its width, so the boards are drawn about 40% and 20% larger (men 31 px where they were 22). The cost, as Chess's since D162: seen from a side seat on a phone held sideways, the table is fitted to the screen's height with 28 px of felt beside the board, so a watcher's box opened there (D101: it wraps beside the felt only with wide margins) lies over the edge row's men for its 6 s; a board any less tall gives the upright phone back nothing (a margin that clears the box needs a table 1294 wide). core-p2 (8), t-p2-demos and t-p2-review read the new sizes | 2g (final review B) |
| D315 | The final review's second fix-up, code and docs. Core: one ask-list gate (`keptAsks`) for loads and seeds, one builder for a new piece (`pieceOf`) for prepare() and the ops that place it, one `shuffle`; dead members gone (`T.boards`, `T.snapPiece`, `T.display`, `T.checkpoint`, the exported `boxKey`, whose doc was wrong: the catalog keys on `storedText`) and names only their module reads no longer exported; the facade's malformed calls throw TypeErrors naming the call (`t.newDeck()`, an empty deck, `t.schedule('soon')`) and a failed `t.newDeck` mints no deck id; shadowing locals renamed (`def`, `boards`, `refuse`, `newName`, `nSeated`, `absent`, `isFile`); the module header lists every effect (`added`, `enable`, the live drags) and `env.mirror`. App: one `ingestFor` for decks and boxes; `pieces.js`'s face renderer is `pieceFace`, unexported; misattached docs moved, section headers and JSDoc added. Tests: one `sha256`, `dataURL` and `prng`; final-lib's `overlap` is `overlapPast1px`. Docs: README's *Game boxes* has a field reference (every field, its values and limits; a rack's `poly`); the overviews name every module and the boxes; TABLETOP says public domain or original, cards stayed decks, and points at SPEC.md; the Blank skeleton shows `handle`, `strict`, `allow`, `onChat`, `onAnswer`, `onSelect`; ENGINE §1's sketch runs as written. **This spec is in the repository** as `cardtable/SPEC.md` (without the build's working paths and commit trailer): the code, the tests and the docs cite its sections and D-numbers | all (final review B) |
| D316 | The final review's second fix-up's tests. New: t-final-play (seats across games, the watchers' box, the view reset, the log, 🗑's ask and Dominoes' refusal, Reveal's cup, a guest's box said, the 📦 list through patches, the setup preflight, the 📜 dialog, Help, the keyboard, the name dialog, a bridge that is down; its phones are Galaxy S5s, 360 × 640, where the watchers' box overlapped) and final.test.mjs (endSeats, Dominoes' del, the facade's TypeErrors). Changed by behaviour: t-p2-demos', t-p2-pieces' and t-p2-tables' pans on another player's piece expect the one notice D313 adds, its exact text (and none on a second pan), where they asserted none; t-p2-tables answers 🗑's ask for a deck (D312) and reads "End the named seats" in the host's menu, as t-p2-review does on the host's own label (D311); t-p5-private and t-p5-veil see a Reveal lift the whole cup (D313) and cup the dice again for the steps after; t-p2-demos, t-p2-review, t-p3-space and core-p2 read D314's sizes (t-p3-space's bare felt is above the board now: its sides are 80 units); core-p2's boxKey checks go with boxKey (canon's equality is still checked); core-p3 takes a savepoint by `T.savepoint()`; t-final-layout and t-p3-space import `overlapPast1px`. One check narrowed: t-p2-review's landscape watcher with the log open (no margin) allows the opened box over the edge row's two men (D314's cost), where it allowed none; with the margins (the log closed) it still allows none | (final review B) |
| D317 | (Amended by D320: (4) a room with no IndexedDB record keeps a mark ahead of its pre-Phase 1 save.) (Amended by D318: (2) a connection let in any way leaves the line; (3) a state left pending over the kept table is resumed; (1) a refused setup sends no seats.) The final review's third fix-up (amends D302, D303, D308, D313). (1) **A new game starts the view afresh, whatever its table's size** (amends D313 (2), which keyed on the table's shape and size alone: Chess, Reversi and Draughts all use 1000 × 1360 since D314, so a phone zoomed in on chess started Draughts with the same transform, every one of its own men off-screen). A body that sets the named seats — a patch carrying `seats` (a box set up or reset, a rules game's `t.setSeats` as it starts, End the named seats) or a snapshot whose seats differ from the view's — or brings a new shape or size resets zoom, pan and turn (`freshView`, as 🧭 does). A box without named seats set up on a table of the same shape and size keeps the view: no public body says a setup happened, and every bundled game names its seats. (2) **Newcomers wait in the order they first knocked** (amends D302): a connection the table-wide bucket refuses keeps its place (`knocking`, a Map in first-knock order) while it knocks — a guest knocks every `KNOCK_MS` (3 s) — and loses it after 3 × KNOCK_MS without a knock, or on leaving; it takes a token only when there is one for every connection ahead of it as well. The bucket gave each refilled token to the first knock after it: four fresh connections knocking every 150 ms took every one, and a newcomer knocking every 3 s waited indefinitely (a reviewer's probe: not in 45 s; t-final-sec: not in 30 s, 10 churned players ahead). Now it waits for the connections that knocked before it (t-final-sec: about 15 s, 4 ahead). The rate is unchanged — a churner still registers one player every 3 s, and the host keeps them (no eviction, as D302 says). (3) **A newer pre-Phase 1 save that holds no table never replaces the room's IndexedDB table** (amends D303): `migrateLegacy` with `newer` that finds a lost marker (`{ts, lost}`: the previous Card Table's tab whose own save failed, its image decks over localStorage's 5 MB), an unreadable save or its decks missing writes nothing (no `markLost`) and drops the old keys, and `loadSave` resumes the IndexedDB table, `behind` ("Couldn't resume this table's last save (browser storage is full) — resumed an older one"). It made the next load put a lost marker over a good table and start a fresh one, against the rule that a lost marker never stands for a table. (4) **What pages leave pending is swept** (amends D308): flushSave's pending state carries `at`, and every page's upkeep (with the image GC, 5 s after boot: `sweepPending`) reads the saves of the rooms that have a `ct-pending-<room>` (`store.savedSeqs`) and removes each mark its save holds (at or past its seq: in every engine but WebKit a pagehide's write commits, and the page that would have removed the mark is gone) or whose room has no table saved (no boot would use it), and cuts a state left over a day ago (`PENDING_MS`), still ahead of its save, to its seq, so that room's next boot still says its last moment wasn't saved. Before, every room whose host tab closed right after a move kept its whole state, up to PENDING_MAX (2 M characters), in the localStorage every app of the site shares, until it was hosted again. Tests: t-final-play (1), t-final-sec (D317: final-lib's `churner`), t-p1-review-store (10), t-final-compat (6); each fails on the commit before | 1h, 1j, 2g (final review C) |
| D318 | (Amended by D319: (3) the mark goes only over a pre-Phase 1 table that replaced the IndexedDB table or its lost marker, `replaced` — not over one migrated with no IndexedDB record.) The final review's fourth fix-up (amends D302, D303, D308, D317). (1) **A connection with no player yet pays for its actions by the connection** (amends D302; §0.1 (4)): flood control priced an action by the player id it names (`T.mayAct`), and a connection with no player may name a fresh one each time — every action passed with a fresh burst of 40 and reached the newcomer gate, and each left a bucket in core's `acts` that was never freed (a reviewer's probe: a connection waiting in line sent 20,000 keyed hellos in 4.9 s, all 20,000 reached the gate, the host's heap grew about 70 B a message). Now an action whose player the table doesn't know is priced first by its connection (`strangers`: core's exported token bucket `tokens`, 40 then 20 a second, dropped once the connection gets in or leaves), then meets the newcomer gate, and only an action that gets in opens a bucket for its player id; such a refusal re-sends nothing (`refused` is for players). **A flood of refusals is a few lines** (`refuse`): the peer is told once a 10 s window, as before, and the console gets the window's first 5 refusals a line each, then, as it closes, one line counting the rest by reason ("refused 1995 more actions from … in 10 s: 35 × Many players are joining…; 1960 × Too many actions — slow down"); every refusal was a line. (2) **A connection gives up its place in line however it gets in** (amends D317 (2)): one in line whose player then registered through another connection passed the gate without the newcomer bucket (its player known) and kept its place up to 9 s, so every newcomer behind it needed one more token; the gate now takes any connection it lets through out of the line. `__ct.waiting()` lists the line. (3) **A state left pending applies to the IndexedDB table it was made over** (amends D308, D317 (3), D303): `checkPending` skipped it for every `behind` save, a flag meant for a migrated pre-Phase 1 table, but since D317 (3) the room's own IndexedDB table is resumed `behind` too (when a newer pre-Phase 1 save holds no table), and the moment WebKit's pagehide never committed was dropped unsaid; and it applied a pending state over a newer pre-Phase 1 save that had just replaced the IndexedDB table (D303, `fromOld`) whenever its seq was higher — another table's state over the newer one, its catalog gone. Now `migrateLegacy`'s results are marked `migrated`, and the pending mark goes (logged) over a migrated table, and is applied as D308 says over the room's IndexedDB table, `behind` or not. (4) **A rolled-back savepoint puts back whether the next patch carries the table and the seats** (amends D317 (1)): `setSeats` marks the seats dirty, and `restore` kept them dirty while putting the old seats back, so a refused setup (a Reset, which has no preflight, or one that turned invalid after it) sent the unchanged seats and table, and every player's view started afresh for a game that never began; a frame now records `dirty.table` and `dirty.seats`, and a rollback restores them (no patch is built inside a job). Docs: README says which games start the view afresh (a box, a game that names its seats or sets its table — Chess, Go, Reversi — named seats ended, a new shape or size) and which keep it (a card game picked on the free table, a refused setup); the help line says "as a game that takes the table does". Tests: t-final-sec (D318, final-lib's `knocker`), t-p1-review-store (11) and (12), final.test (4); each fails on the commit before. Mechanism changes, no check weakened: t-final-compat (5) picks one checker a space its player may pick, read once the table is still, each pick waited for (a Shift+click picks the space's top checker: a second point on a space put it back, which flaked with the ids' order); final-lib's `churner` logs a `room.leave()` that throws instead of crashing the suite | 0.1, 1h, 1j, 2g (final review D) |
| D319 | (Amended by D320: (1) every boot notice joins one toast, a line each; (2) a seq over an `unrecorded` table says the play since the move was lost.) The final review's fifth fix-up (amends D308, D318). (1) **What a boot says of a save left pending is said with the rest, in one toast** (amends D308): `checkPending` toasted "The last moment of play before the reload wasn't saved (the browser closed first)" and becomeHost's own boot toast, set in the same task, replaced it (`toast()` keeps one text). Since D318 (3) applies D308 over a table resumed `behind`, a seq alone left over it was never shown (a reviewer's WebKit probe on an iPhone 13: both texts set, only the second displayed; the loss was a console warning alone). Now `checkPending` returns the save and whether the last moment was lost, and `becomeHost` says it: with `behind`, "Couldn't resume this table's last save (…) — resumed an older one, and the last moment of play before the reload wasn't saved"; on its own otherwise, as before. (2) **A pending mark goes only over a table that took the place of what IndexedDB held** (amends D318 (3)): D318 marked every migrated pre-Phase 1 table, but one migrated with no IndexedDB record at all (`loadSave`'s first branch: its migration, every save since and even the lost marker failed, storage full) replaced nothing — the mark was made over that very table — and the mark went with no toast, logged with a reason that was false there; before D318, D308 applied. Now `migrateLegacy` marks its result `replaced` (was `migrated`) only when it replaced the room's IndexedDB table (`fromOld`) or stands in for its lost marker (`behind`, where the boot's toast already says the last save is lost); with no IndexedDB record, D308 applies: a whole state resumed, a seq alone said. (3) **`A.seat` resolves once its page's view holds its own player** (tests, assets-lib; a mechanism change): a guest's first pile can come from the public snapshot that answers its anonymous knock, drawn before the host registers its keyed hello, so t-final-compat (1) read the host's log before Bob's own "joined the table" and failed "neither joined the table" under load (three full runs; a probe seating six guests in turn, the host's CPU throttled × 8 once and × 12 twice: 5 seats of 18 returned before the host logged the join, 0 of 18 now). Tests: t-p1-review-store (13) and (14), each failing on the commit before; t-final-compat checks that `A.seat` returns with Bob registered | 1h, tests (final review E) |
| D320 | (Amended by D321: (6) the card game starts afresh on the table it clears, and pieces on the table make it a board game's; toastLog records a notice an entry — by D322, an entry per `toast()` call.) The final review's seal round 1 (amends D311, D317, D319). (1) **What a boot says is said together** (amends D319 (1)): `toast()` keeps one text, so a boot's notices replaced each other within a few ms — with storage still full, store's "Couldn't move this table's save to the new storage: …", becomeHost's notice, then the first save's "Can't save this table (…)" about 15–150 ms later, the last alone on screen (a reviewer's probe, Chromium and WebKit on an iPhone 13: the lost moment up 15 ms). Now every toast from the page's start until 5 s after its role is decided (boot: `gatherTill`; none after a boot that said nothing) joins those up, a block each, ruled apart (its text a line per notice), at most 4, a repeat moved last, red if any is; a pinned one returns alone once they expire. One choke point for every boot notice — store's (a deck dropped, the move failed), boot's, becomeHost's, the first save's, the missing images — rather than store's failure passed back as data (it would have left the others replacing one another). (2) **A pending seq over a pre-Phase 1 table migrated with no IndexedDB record is said for what it is** (amends D319 (2), D308): there the record is missing because the move, every save since and the lost marker failed, so it is not "the last moment of play … (the browser closed first)" but all the play since the move: `loadSave` marks such a result `unrecorded` and becomeHost says "Couldn't resume this table's last save (it isn't in this browser's storage) — resumed the previous Card Table's save" (true too of a record pruned away). A whole state pending there is still resumed (only a table with no deck can leave one: its catalog was never saved). (3) **The upkeep keeps that mark** (amends D317 (4)): `store.savedSeqs` read IndexedDB only, so a room whose only table was its pre-Phase 1 save had "no table saved" and any page's sweep, 5 s after it booted, removed its mark — the room's next boot then resumed the old table silently (a reviewer's probe). Now a room with no IndexedDB record falls back to its pre-Phase 1 save's seq, the table its next boot migrates; a lost marker or a record with no table is still "none". The console says which ("removed: its room has no table to resume" / "the table its room resumes holds it (seq N)"). (4) **checkPending says why a mark over a `replaced` table goes, by case**: with `fromOld`, another table's (as before); with `behind`, "made over this table's last save, which was lost (…) — the boot says so, and resumes the previous Card Table's save" — it said "another table" there too, false in the lineage where the tab that left the mark played that very legacy table. (5) **End the named seats asks first mid-game** (amends D311): one tap in the host's seat menu, right below Stand up and Sit here, released every seat-owned piece to nobody, left every hidden piece only a seat may see unreadable to everyone (its player included) and a rules game that set the seats unable to go on — with no way back (a reviewer's probe: Dominoes after Draw 7, both racks "Nobody's"). The menu's entry now confirms when it costs anything (`endSeatsAsk`: "End the named seats (South, North)? 16 pieces a seat owns will belong to nobody; 14 hidden pieces only a seat may see will be seen by no one, its player included; Dominoes may not go on without them."); with nothing owned, hidden or ruled it acts at once. Handing each seat's pieces and `vis` refs to its holder instead (a core change of what ending seats means, which scripts may rely on) was not done. (6) **A card game that deals from a deck gets one on the table it clears** (amends D311): GAMES marks Hold'em, Bridge and the simple dealer `deck`; picked over a board game, `pickGame` adds a standard deck in the middle after the new rules start (a strict board game's rules would refuse it before), and the confirm says so ("…; a standard deck is put on the table") — the cleared table held none, and the first deal said "No deck on the table!". Cards Against Humanity brings its own. (7) Docs: README and Help say that 🗑 of a stack, pile or bag of more than five, or of a supply, asks first and that Delete removes at once (D312 had been documented for groups only); README says what a boot shows, the sweep's fallback, the seats' ask and the deck; the in-repo spec's index line, §0.2's `?v=` example and §10.4's constants (the final review's) are brought up to date. Tests: t-p1-review-store (1) reads `#toast` at the storage-full reload (three lines), (14) expects the `unrecorded` text and labels its whole-state half, new (15) (another page's upkeep first) and (16) (storage still full at boot 2, both lineages: the three lines on screen 2.5 s on, the console's reason); t-final-play (1) the ask, a cancel that changes nothing and the deck, (2) the mid-game ask. Each fails on the commit before. Mechanism changes, no check weakened: t-p1-review-store's `toasts` reads each toast as its lines and `toasted` takes a string; t-final-play no longer adds a deck by hand before Hold'em's first deal (it checks the deck is there); t-p1-store's toast recorder reads each `toast()`'s newest block (it hooked the `textContent` setter, no longer called) and its (2b) removes the pending mark (a) left, starting from the legacy keys alone as it says | 1h, 2g, 3g, 5g, 10.4 (final review, seal 1) |
| D321 | (Amended by D322: (3) toastLog records the notice each `toast()` call adds, once — not every line up on each change.) The final review's seal round 2 (amends D311, D320). (1) **A card game from 🎲 knows a board game by what lies on the table too** (amends D311): `pickGame` took the table for a board game's only by a box set up (`lastSetup`) or named seats, but a rules game that builds its own board (Chess, Go, Reversi) is set up by `clear` and `setRules`, with no `lastSetup` — so once End the named seats was accepted, as its ask invites ("…Chess may not go on without them"), Hold'em picked next asked "Stop Chess? …", kept the board and its 32 men, put out no deck, and New hand said "No deck on the table!" (a reviewer's probe; the same with Go and Bridge). Now a piece, supply or bag on the table (anything but cards and piles) makes it a board game too: the confirm says "The board and its pieces go, with Chess's game state; a standard deck is put on the table" ("The board, its pieces and the named seats (…) go" with seats), and the table is cleared and dealt from. (2) **On the table it clears, the card game starts afresh** (amends D311, D320 (6)): `setRules` keeps the state of a script with the same name, and a box with no rules of its own (Draughts, Backgammon) only switches the running rules off, so Hold'em picked again over Backgammon resumed the hand left in progress on the cleared table — its `validate` refused the deck the confirm had just promised ("🚫 Hand in progress — …") and every deal (a reviewer's probe; Bridge mid-bid alike). Now pickGame's `setRules` carries `reset` whenever it clears the table, and the confirm names the state that goes, the same game's too ("…go, with Hold'em (chips)'s game state; …"). pickCleared's "The current game is discarded" over a box with no rules, whose rules state is kept switched off, stays: 🎲 no longer resumes that state on a cleared table; only 📜's Enable does, which keeps a game's state by design ("Free table" keeps it for re-enabling). (3) **assets-lib's `toastLog` records a notice an entry** (tests, a mechanism change): since D320 a boot's notices join one toast, and toastLog recorded its joined text ("A\nB"), so an exact negative check — t-final-compat (4)'s "with no warning", `!includes(LOST)` — would pass with LOST shown beside another notice. It now records each line on its own; t-p1-review-store's `toasts`, which split each text itself, is `A.toastsSince`, and its (1) and (16), whose anchored texts arrive gathered, fail with the old recorder. (4) becomeHost's comment on `momentLost` no longer says a second toast would replace it. Tests: t-final-play (1) Hold'em over Backgammon with a hand kept (the confirm, one 52-card deck, no "Hand in progress", New hand deals all three) and Hold'em after Chess whose named seats were ended (the ask accepted, the confirm, no piece left, one deck, everyone dealt); each fails on the commit before | 2g, 3g, tests (final review, seal 2) |
| D322 | The final review's seal round 3 (amends D321 (3); tests only). **assets-lib's `toastLog` records an entry per `toast()` call, the notice it said**: D321 had it push every line of `#toast` on each change, so while the boot's notices are gathered (D320) each earlier one was recorded again as the next joined it — three notices said once each came out [A, A, B, A, B, C] (a reviewer's probe at t-p1-review-store (1)'s storage-full reload), and its docs' "a notice an entry" was false for any count. Every `toast()` writes `#toast` with one `replaceChildren`, the new notice its last node (a repeat moved last, a returning pinned notice a call of its own); that is one MutationRecord per call in Chromium, WebKit and Firefox, even for two calls in one task (a probe), so the observer records each record's last added node — not `lastElementChild` at callback time, which would miss the first of two calls in one task. A test's own `textContent = ''` adds no node and records nothing (before: an empty entry). Presence checks are unchanged (t-final-compat (4)'s `!includes(LOST)` still sees LOST shown beside another notice); a count now counts what the app said. Tests: t-p1-review-store (1) and (16) (both lineages) check that the reloaded page's log is exactly its three notices, once each, in order — each fails with D321's recorder (six entries) | tests (final review, seal 3) |

## 10. Appendices

### 10.1 Every action at the end of Phase 5

`PUBLIC_ACTIONS` (accepted from guests): every action below except those
marked "host" (which are accepted only when `p === env.pid`) and the
internal `_*` ones.

| Action | Since | Who | Ruled | Strict-refusable | Flood tokens |
|---|---|---|---|---|---|
| `hello`, `name`, `chat` | today | anyone | no | no | 1 (chat and name also `mayTalk`) |
| `rulesBtn` | today | anyone (offered buttons only) | no (`onButton`) | no | 1 |
| `setRules` | today (+`state` in P4) | host | no | no | — |
| `size` → `table` | today / P2 | host | no | no | — |
| `move`, `rot`, `flip`, `shuffle`, `draw`, `deal`, `play`, `handPile`, `toHand`, `toPile`, `stack`, `merge`, `del`, `addDeck`, `peek` | today | anyone | yes | yes | 1 |
| `snap`, `need` | P1 | registered players | no | no | 1 (+ rate or byte limits) |
| `roll`, `face`, `split` (+`onto`), `join`, `take`, `pull`, `toBag`, `lock`, `owner` | P2 | anyone (lock: host, or `lockable` + `mayHandle`; claim: unowned, unlocked, not a board) | yes | yes | 1 |
| `seat` (`id` \| `watch` \| `sit`) | P2 | anyone (`p`: host) | yes | **no** | 1 |
| `loadBox`, `clear` (`endSeats`: D311) | P2 | host | no | no | — |
| `drag` (`{id, x, y}` or `{ids, dx, dy}`) | P3 | anyone (`mayHandle`, `notLocked` per id; coordinates clamped) | no (no state) | no | 1 (any number of ids) |
| `select` | P3 | anyone (when `wants`; not on items hidden from them) | no | no | 1 (≤ 5/s) |
| `answer` | P3 | the asked player | no (engine-checked) | no | 1 |
| `addBox` | P4 | anyone (budget) | yes | yes | 1 |
| `setup` (+`shuffle`), `reset` (of `lastSetup`) | P4 | host | no | no | — |
| `group` | P4 (+`hide` in P5) | anyone | yes, per member | yes, per member | 1 + ⌊N/20⌋ |
| `hide` | P5 | anyone (`mayHandle`, `notLocked`) | yes | yes | 1 |
| `_join`, `_leave`, `_tick`, `_rulesOff`, `_name` | P3 | **host-internal only** | n/a | n/a | — |

### 10.2 Host state at the end of Phase 5 (v6)

```ts
{
  v: 6, seq: int,
  table: { shape: 'round' | 'rect', w, h, felt? },
  seats: SeatDef[] | null,
  items: { [id]: Card | Pile | Piece | Supply | Bag },
  players: { [pid]: { name, color, online, hand: HandEntry[], seat: number | null, seatId? } },
  keys: { [pid]: string },
  log: LogEntry[],
  rules?: { code, name, enabled, data /* engine key: _timers */, public,
            asks: { [pid]: Ask[] }, secret: { [pid]: JSON }, hints? /* not saved */, box?: boxId },
  guestDeckChars: int, zMax: int, boardSeq: int, lastSetup?: boxId,
}
// catalog (separate; records never change during play, only migrations rewrite them):
//   decks { [deckId]: Deck v2 }, boxes { [boxId]: { box: Box, src: 'host' | 'upload' | 'script', by?: pid } }
// assets (IndexedDB, content-addressed): { [AssetId]: { mime, size, data, used } }
Piece = { k:'g', t, f, x, y, rot, z, up?: false, n?, owner?, lock?, at?, vis?, pv?, po? }
Bag   = { k:'b', of, name, color?, hand?: true /* fixed at creation */, x, y, rot, z, owner?, lock? }
```

### 10.3 Host → guest bodies at the end of Phase 5 (`state` channel, sealed and bound)

```ts
Snap  = { v: 6, kind: 'snap', boot, seq, host, table, seats, handy,
          rules: { name, enabled, public, wants?, strict? } | null,
          items, players, log, fx, ann,
          to, tp, hand?, ask?, hint?, sec?, vis? }
Patch = { v: 6, kind: 'patch', boot, base /* per recipient */, seq, host,
          table?, seats?, handy?, rules?, items?, del?, players?, log?, fx?, ann?,
          to, tp, hand?, ask?, hint?, sec?, vis? }
// on the wire: prefix {to, tp, base, <per-recipient parts>} + the shared JSON (§1b.3);
// items objects in sorted-id order (§0.2)
```

The other channels:

- `decks` and `boxes`: `signed` deltas, from `hostPeer`;
- `rules`: `signed`;
- `note`: bound, `{msg?, peek?: {d, i} | {t, f}, missing?: AssetId[]}`;
- `asset`: unsigned binary plus `{h, mime}`, pull-only and hash-verified;
- `act`: guest → host, with `_pid`, `_name`, `_key` and `_v`.

### 10.4 Constants (exported from `core.js` unless noted)

| Constant | Value | Phase |
|---|---|---|
| `PROTO` | 2, 3, 4, 5, 6 | P1…P5 |
| `STATE_V` | 2, 3, 4, 5, 6 (the newest `MIGRATE` target) | P1…P5 |
| `MODULE_V` | an integer, bumped by every PR that changes a cardtable module (every module exports it) | P1 |
| `MAX_DECK_CARDS`, `MAX_DECK_BYTES` | 5,000; 24 MB (unchanged) | today |
| `GUEST_DECK_CHARS` | 1.5e6, shared by decks and boxes | today, P4 |
| `ASSET_MAX_BYTES` | 2e6 | P1 |
| `IMG_MAX_SIDE` / `IMG_MAX_PX` | 4,096 px / 16 Mpx (store.js) | P1 |
| `NEED_BATCH` / `PEER_ASSET_BUDGET` | 64 / 64 MB per 60 s, per player — shared by all its connections and outliving a leave until a window has passed (app.js, D302) | P1, final |
| `ASSET_INFLIGHT` / `NEED_TIMEOUT_MS` | 2 sends per peer / 20,000, one retry (app.js) | P1 |
| `SNAP_MIN_MS` | 3,000 (app.js) | P1 |
| `DATA_MAX_CHARS` | 4e6 | P1 |
| Asset GC | 14 days unused; 500 MB unreferenced cap; never `keep` or anything used in the last hour (store.js) | P1 |
| `MAX_ITEMS` | 5,000 | P2 |
| `MAX_N` / `MAX_BAG` / `MAX_ROLL` | 999 / 1,000 / 20 | P2 |
| `MAX_TYPES`, `MAX_BACKS`, `MAX_FACES` (die) | 500, 50, 64 (100) | P2 |
| `MAX_CELLS`, `MAX_SPACES`, `MAX_ZONES`, `MAX_POLY`, `MAX_LINKS`, `MAX_FILLS`, `MAX_MARKS` | 4,096, 1,000, 100, 64, 4,000, 4,096, 64 | P2 |
| `MAX_SETUP_ENTRIES` / `MAX_SETUP_ITEMS` / `MAX_SEATS` | 2,000 / 3,000 / 12 | P2 |
| `BAG_W` × `BAG_H` | 90 × 100 | P2 |
| `BOARD_Z0` | −1,000,000 | P2 |
| `MAX_HAND` / `MAX_PILE` | 1,000 / 5,000 | P2 |
| `SEAT_INSET` (setup `"at": "seat"`) | 120 | P2 |
| Table bounds | round 1300, 1800, 2400; rect w 800–6000, h 600–4000 | P2 |
| Zoom max | 4 · max(w, h) / 1300 (app.js) | P2 |
| `RULES_TIMEOUT_MS` / init | 4,000 (+ 10 ms per group member or setup item; visible time, 1 s grace) / 10,000 (app.js) | P3 |
| `MAX_QUEUE` | 500 (app.js) | P3 |
| `SELECT_PER_SEC` | 5 | P3 |
| Ask caps | 8 pending per player, 20 options, 200 `among`, a 200-char prompt, `count` ≤ 20 | P3 |
| `_timers` caps | 1,000 entries, tag ≤ 100 chars, finite `at` | P3 |
| `HINT_MAX` | 500 | P3 |
| `SECRET_MAX_CHARS` / rendered text | 8,000 / 1,000 | P3 |
| `MAX_GROUP` | 200 | P4 |
| Box caps | rules 200,000 chars; `meta` 8 KB; `rulesState` 4e6; `MAX_BOX_CHARS` 64 M (transport); `MAX_BOX_BYTES` 48 MB of images | P4 |
| Zip caps (boxio.js) | `ZIP_MAX_BYTES` 64 MB (the file); 2,100 entries; 64 MB inflated in total; per entry min(declared, 16 MB); `game.json` 16 MB, a rules file 600 KB (D188; §4j said 2 MB and 200 KB) | P4 |
| Image encoding (boxio.js) | boards 2,048 px, others 560 px; WebP 0.8, else JPEG 0.85 (opaque) or PNG; stepped down to fit `ASSET_MAX_BYTES` | P4 |
| `ASK_ARM_MS` / `BOX_WAIT_MS` | 500 (a 📦 question's buttons wake: D204) / 30,000 (a guest's wait for the host's answer: D209) (app.js) | P4 |
| `MAX_VIS` | 8 refs | P5 |
| `MAX_DEPTH` | 64 nested arrays or objects in a peer's action (D302) | final |
| Seat key length | 16 to 64 characters (app.js, D302) | final |
| `NEWCOMERS` / `NEWCOMER_MS` / `KNOCK_MS` | 20 at once, then one every 3,000; a refused connection knocks every 3,000 and keeps its place for 3 × KNOCK_MS (app.js, D302, D317) | final |
| `HOST_ASSET_BUDGET` | 4 × `PEER_ASSET_BUDGET` a minute, the whole table (app.js, D302) | final |
| `REFUSE_MS` / `REFUSE_LINES` | 10,000 / 5: a peer is told once a window; the console gets the window's first 5 refusals, then one count (app.js, D318) | final |
| `PENDING_MAX` / `PENDING_MS` | 2e6 characters / one day (app.js, D308, D317) | final |
| `CHIP_MS` | 150 (app.js, D309) | final |
| `TAP_PX` | 44 (app.js, D313) | final |
| `GROUP_DEL_ASK` | 5 (app.js, D235, D312) | P4, final |
| `CLI_MSGS_MAX` | 200 (app.js, D313) | final |
| Boot notices | gathered for 5 s after the role is decided, at most 4 lines (app.js toast, D320) | final |

### 10.5 Facade (`t`) by phase

| Phase | Added or changed |
|---|---|
| today | `data`, `public`, `players`, `hand`, `items`, `piles`, `deal`, `dealToAll`, `draw`, `takeHand`, `playFromHand`, `toHand`, `shuffle`, `flip`, `toPile`, `stack`, `newPile`, `merge`, `move`, `rot`, `remove`, `newDeck`, `addStandardDeck`, `geom`, `hostId`, `say`, `announce`, `win`, `tell`, `schedule`, `nextSeat`, `cardName`, `card` |
| P1 | `item(id)`, `find(q)`, and the `data`-size guard |
| P2 | `roll(id)`, `random()`, `type(ref)`; `geom` with shape, w and h; `players({all})` and `seatId`; `find` with type, owner and piece kinds; the existing ops on pieces |
| P3 | hooks `handle`, `strict`, `allow`, `onAnswer`, `onSelect` (no hook may return a thenable); `ask` (plain-string options accepted), `cancelAsk`, `asks`, `hint`, `secret`, `newBox` (with `decks`; deduplicated), `spawn`, `newBag` (`o.hand`), `take`, `pull`, `setFace`, `setCount`, `lock`, `setOwner`, `setSeats`, `setTable`; `move(id, addr)`, `where`, `at`, `find` with zone and at, `zones`, `spot`, `neighbors`, `distance`, `line`, `linked` |
| P4 | `boxes()` (with `builtin`), `box(id)`, `layout(boxId, entries?)` |
| P5 | `hide(id, refs)`, `reveal(id)`, `setVis(id, refs)`, `canSee(pid, id)`; `spawn` with `vis` |
