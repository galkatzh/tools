# Card Table tests

End-to-end suites drive real Chromium tabs with Playwright: each suite starts
its own tiny Nostr relay and static server on random ports, so suites (and
several checkouts) run in parallel without stepping on each other. Logic
suites run the rules templates and the state core (`../core.js`) in Node,
with no browser.

## Install

```sh
cd cardtable/tests
npm install                       # ws, for the local relay
npm install --no-save playwright  # unless /opt/node22/lib/node_modules has it
npx playwright install chromium   # once per machine
```

`h.js` uses a `playwright` installed here, else the one in
`/opt/node22/lib/node_modules` (preinstalled on the development machines).
Node 22.12 or newer is required: the logic suites `require()` the app's ES
modules. (The Node-only `*.test.mjs` and `*-bench.mjs` suites `import` them
and need only Node 22.7, which `node-lib.mjs` checks, failing loudly.)

CDN libraries (Trystero, QR codes) are fetched with `curl` on first use into
`.cdn-cache/` (gitignored), then served locally, so a run never depends on the
CDN once the cache is warm. `curl` honours `HTTPS_PROXY`.

## Run

```sh
./run-all.sh            # parse check + every suite in parallel; summary at the end
./run-all.sh holdem     # only suites whose name contains "holdem"
node t-smoke.js         # one suite, output on the terminal
```

- The suites test the checkout they live in: `h.js` serves the repo two
  levels up. Set `APP_ROOT=/path/to/repo` to test another checkout.
- At most two suites per CPU run at once (`JOBS=n` to change it): every
  end-to-end suite drives its own Chromium. `run-all.sh` runs the `t-*.js`
  suites and the Node-only `*.test.mjs` ones.
- **The serial list.** The benchmarks, and the suites with a timing budget
  (a host long task under 50 ms), run alone, one at a time after the
  parallel batch, under the same lock: `SERIAL`, a comma-separated list of
  suite names, default `t-p1-bench,core-p1-bench,core-p2-bench,t-p1-flood`. A listed suite
  that doesn't exist fails the run.
- Runs take a machine-wide lock (`CARDTABLE_TEST_LOCK`, default
  `/tmp/cardtable-tests.lock`): concurrent runs on a small machine starve each
  other into flaky timeouts, so a second run waits for the first.
- Each suite's log is kept in `out/<suite>.log` until the next run; failing
  checks are listed with the log's path.
- `parse.js` parse-checks `app.js` and every local module it imports as real
  ES modules (a stray `await` or a duplicate export fails there, not in a
  browser). Local imports carry the code version (`./core.js?v=1`, see
  `MODULE_V` in `core.js`); the check, like the test server, ignores it.

## Add a suite

Create `t-<topic>.js` here; `run-all.sh` picks up every `t-*.js`.

```js
const h = require('./h');
const { ok, section } = h;

(async () => {
  const env = await h.start();                       // relay + server + Chromium
  const { host, guest } = await h.hostAndGuest(env); // two seated players
  section('drawing');
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 1);
  ok(true, 'the guest drew a card');
  await env.done();                                  // summary + exit status
})().catch(h.crash);
```

- `ok(cond, msg)` records a check without throwing, so a suite reports every
  failure; `h.crash` turns an exception into a failed run.
- Pages run with reduced motion; pass `{ ctx: { reducedMotion: 'no-preference' } }`
  to `env.page()` to see animations.
- A logic suite needs no browser: import the core with
  `require(path.join(h.APP_ROOT, 'cardtable/core.js'))`, make checks with `ok`,
  and finish with `h.report()` (see `t-core-node.js`).
- Shared helpers: `fun-lib.js` (seated players, screenshots into `shots/`),
  `final-lib.js` (a raw attacker peer, and `table(template, players)`: a
  rules template running on a real `core.js` table in Node).

## The wire, for raw peers and state checks

The host sends each peer a snapshot (`kind: 'snap'`: the whole public
table) when it arrives, re-registers or asks for one, then patches
(`kind: 'patch'`: only what changed, built on the seq in `base`) — see the
top of `core.js` and README "How it works".

- **`_v` on every raw action.** The host refuses an action whose `_v` isn't
  the app's wire version (`PROTO`), so a raw peer (Mallory, a spy, a relay)
  sends `_v: h.PROTO` — read from `core.js`, never hard-coded — or its
  attack is refused before it reaches the code under test.
- **`h.bodies(raw)`** unwraps recorded `state` messages (`{b, s, k}`) into
  bodies, snapshots and patches alike; **`h.viewFrom(bodies)`** folds them, in
  order, into the view they add up to (`{items, players, rules, table,
  seats, handy, log, hand}`, the log untrimmed: everything that peer saw).
- **`window.__ct`.** `h.start()`'s pages set `window.CARDTABLE_TEST`, so the
  app exposes `{act, view, hand, log, boxes, perf}`: `act(a)` is a click's own path
  (on the host a Promise of `{ok, error?}`), `view()` the public view the
  screen draws (the host's own too: it takes its patches through the guest
  path), `hand()` and `log()` this player's hand and log, `boxes()` the
  game boxes this page holds (`{boxId: Box}`, each passed `cleanBox`: a
  guest's from the `boxes` channel, the host's its table's), and `perf` the
  counters (`snaps`, `patches`, `gaps`, `snapRequests`, and `drawn`: item
  elements (re)drawn since the page loaded) and the last durations:
  `lastApplyMs`, a received body folded into the view and the whole screen
  redrawn (items, seats, hand, log, buttons); `lastRenderMs`, `renderItems`
  alone, on any page; `lastSnapRenderMs` (B10), the last snapshot that drew
  items: its fold, its DOM and the style and layout they cost (read at
  once) — a guest's first snapshot draws the table, and the one that
  registers it a moment later redraws nothing, so it doesn't count: after
  a guest's (re)load this is its cold render of the whole table;
  `lastTickMs`, the host's broadcast tick (signing and sending start; its
  own screen's redraw is not in it).
- **The tick in Node.** `T.takeDirty()`, then `T.patchContent(d)` (or
  `T.snapContent()` in the same tick), wrapped in `{v, kind, boot, seq,
  host}`, serialized once (`sharedText`), and `spliceBody({to, tp, base,
  hand?}, text)` per recipient; a guest folds them with `viewFromSnap` /
  `applyViewPatch` (the app's own functions). `wire()` in
  `core-p1.test.mjs` is a worked example, with the spec's own fold
  (`specReceive`) beside core's.

## Phase 1 helpers

- **`node-lib.mjs`** (Node-only suites): the core and templates imported
  from `APP_ROOT`, `ok`/`section`/`report`/`crash`/`guard` in `h.js`'s
  format, a seeded RNG (`rng`, `SEED=n` replays one seed), seeded table envs
  (`env(seed)`: a clock, an RNG and sequential ids), `canon` and `quantile`.
- **`p1-lib.js`** (browser suites): `rtcHook`, an init script that wraps
  `RTCDataChannel` and exposes `window.__rtc`: bytes `sent`/`recv` per
  Trystero action, framing included (the B1' counter); `drop`, a queue of
  kinds (`'patch'`, `'snap'`, `'any'`, or `'reg'`: a snapshot addressed to a
  player) whose next incoming `state` message is swallowed whole before the
  app sees it; and `keep`/`bodies`, the incoming
  bodies recorded while `keep` is set. Also `player`/`trio` (seated pages
  with the hook), `view`/`pidOf`/`act` (over `window.__ct`), `saved(host)`
  (the host's save record, from IndexedDB) and `truthOf(save)` (the
  public table, hands and `handy`, recomputed from a save by core.js in Node), and
  `same`/`diff`, `prng`, `pct`, `until`.
- **Raw peers and images.** final-lib's Mallory also joins the `asset`
  channel: `M.send.asset(bytes, target, {h, mime})` sends an image, and
  `M.got.asset` records `{m, peerId, metadata}`. (Phase 2: she joins the
  `boxes` channel too — `M.got.boxes`, `M.send.boxes`; see p2-lib's `arm`.)
- **The suites.** `core-p1.test.mjs`: the seeded fuzz of the public view and
  the patch fold, trimLog, z, indexed reads, MIGRATE, refusals, the splice,
  imageDims and deck ingestion, the t.data cap, applyStatePatch, and the
  core regressions of both Phase 1 reviews. `core-p1-bench.mjs`: B1, B2, B5,
  B7. `t-p1-delta.js`: every screen converges through deltas (random play,
  reloads, drops, vetoes, the version gate, spam). `t-p1-review.js`: the
  regressions the Phase 1A review found (states out of order, refusals that
  re-send too much, a refused snapshot request, no-op drops, log rebuilds, a
  lost registration snapshot, a newer save, module skew). `t-p1-store.js`:
  saves, the legacy migration, quota, a blocked IndexedDB, the pending
  marker, a newer save, module skew, upkeep (spec §1l). `t-p1-assets.js`:
  the image pull, a warm rejoin, damaged and missing images, late arrivals,
  attacker cases 2, 8 and 9, a guest's own upload, pacing.
  `t-p1-review-store.js` and `t-p1-review-assets.js`: the regressions the
  Phase 1B review found (a migration whose images can't be stored, and a
  reload while storage is still full, a save that can't be read, a lost
  marker's catalog, a function in t.data, the image cache evicted before
  saves, no BroadcastChannel, a lost marker beside a legacy save it never
  replaced, a save record that holds no table; refused decks leave
  nothing, a lost image heals, serving keeps no copies, a database upgrade,
  3,000 images, a host away for 45 s). `t-p1-bench.js`: B1', B3, B4, B6, B8
  (serial). `t-p1-flood.js` (serial): attacker case 3 (1,000 `need`s), no
  host long task while ingesting 34.6 MB or a guest's 4,999 images, and an
  honest 69.2 MB pull paced past the budget.
- **`assets-lib.js`** (image suites): PNGs written in code (`png`,
  `tinyPngs`, `distinctPngs`, `bigDecks`, the `bomb`), `sha256`, `dataURL`,
  `imgDeck`; init scripts `hostWire` (hold, damage or swap the host's
  `asset` frames), `needLog`, `toastLog`, `decodeWatch`, `dropMissingNotes`,
  `paceMonitor`, `longTasks`; page helpers `seat`, `pileOf`, `addDeck`,
  `assetBytes`, `asked`, `stored`, `decodedBomb`, `startMoves`/`stopMoves`,
  `toastsSince`. **`img-lib.js`**: PNG, GIF, JPEG and WebP headers made in
  code, each with the byte count its size needs (`hdr`), for imageDims.

## Phase 2 (2A: the engine, wire, persistence and CLI of pieces)

- **The wire, PROTO 3.** Bodies carry `table` (`{shape, w, h, felt?}`),
  `seats` (named seats, or `null`) and `handy` (whether anything on the
  table can be held in a hand) where they carried `size`; a patch carries
  each only when it changed. Game boxes travel on their own signed `boxes`
  channel (a delta, or the whole catalog for a new connection), without
  their setups. A hidden piece's public form is `{k:'g', b: '<box>/<back>'
  | null, x, y, rot, z, n?, owner?, lock?}`: never its `t` or `f`; a bag
  is `{k:'b', name, n, hand?, box?, …}`: never its `of` (`box`, the box
  whose setup made it, is public since D88: it decides who may lock the
  bag, and names no content).
- **Loading a box** (the host): `__ct.act({t: 'loadBox', box, setup: true,
  clear: true})`, with `box` in the shape of `templates.js` `BOXES`
  (`BOXES.draughts`, `BOXES.backgammon`: import `templates.js` in Node and
  pass one to `evaluate`). Every action of spec §2c is in `PUBLIC_ACTIONS`
  but `table`, `loadBox` and `clear` (`HOST_ACTIONS`: a guest's gets "🚫
  Only the host can do that"). A piece in a play or handPile payload is
  named `{type: '<box>/<type>', f}` — its type ref can't travel as `t`,
  the action's own name.
- **Exact texts** (refusals): "🚫 That piece is hidden" (face, roll, join
  on a hidden piece, before any other check), "🚫 That belongs to {name}"
  (a seat-bound owner: the seat's name), "🔒 That is locked in place", "🚫
  The table is full (5,000 items)", "🚫 Dice are rolled, not turned", "🚫
  Those don't stack together", "🚫 Some of those pieces have no hidden
  side", "🚫 Those pieces can't be held in a hand", "🚫 Roll 1 to 20
  different dice", "🚫 Your hand is full (1,000)", "🚫 That pile is full
  (5,000)", "🚫 Box rejected: {cleanBox's message}"; a guest whose
  box fails `cleanBox` toasts "A game box from the host couldn't be read:
  {message}" once per box.
- **Drawn pieces** (`pieces.js`): `.item.piece.shape-{shape}` sized w × h
  (`.supply`, `.board`, `.pile.multi` for a pile of pieces), `.item.bag`, a
  face `.pface` (`.pback` for a hidden piece's back) holding its layers
  (`img.face` / `.face.loading`, `.plabel`, `.ptext`, `.pips`), and
  `.pface.placeholder` ("?") when its box isn't here.
- **The core suites.** `core-p2.test.mjs` (Node, spec §2l 1–7): grid.js's
  formulas and address round trips; cleanBox (defaults, shorthand, every
  cap at n and n + 1, backs, addresses, a 2,000-mutation fuzz checked by
  its own field-by-field oracle `boxProblems`), canon, boxKey, isBuiltin;
  every action of §2c with the mayHandle / notLocked table row by row,
  cap(), the hidden-item rule, the bag flag; setup order (Spearman over 20
  seeds); the public reduction against §2d's table (`specPub`, `specHandy`)
  after 500 random piece ops; seats; MIGRATE[2] and the board z band;
  randInt; the built-in boxes; and (R), one regression check per issue the
  Phase 2A review found (a board's back, a bag's fixed box, missing boxes,
  the hand and pile caps, t.takeHand (also onto an empty pile, a piece
  first in the hand), the card games with a piece in a hand (Hold'em's
  set aside, fold and showdown; CAH's refill, with `globalThis.window`
  holding stub `CAH_CARDS`; Bridge's deal beside a bigger pile of tiles),
  the bridge script with a watcher,
  seats that are gone, rotation snapping, flagsOf on public piles and bags,
  …). Its tables are built by `mk(items, o)` from
  the test box `TESTBOX` (one type per behaviour) and `run(T, p, a)` returns
  what an action did (notes, log lines, effects, changed). Ids are random
  hex, as `uid()` makes them: a JS object lists integer-like keys
  ("12345678") first, so key order is checked against sorted insertion
  (`inOrder`). `core-p2-bench.mjs` (serial): B9, a 20-dice roll on the
  1,000-piece bench box of §2k.
- **`p2-lib.js`** (browser suites): `act(page, a)` (the page's own act),
  `loadBox(host, box, {setup, clear})` → the box's catalog id, `items(page)`
  and `at(items, x, y, pred?)` (test boxes give every item its own top-left,
  so tests find even hidden ones by place); the test boxes `SPY` (a 3000 ×
  2000 table, three named seats, `lockable: 'anyone'`, the `SECRETS` types
  only ever face down or in bags), `GHOST` (one hidden piece, one shown,
  three hidden tiles: a face-down pile and a hand piece once stacked) and
  `PARLOUR` (spec §2i's `table` examples). **`arm(M)`** gives Mallory's page
  `M.fold()` (her view, folded as a guest folds), `M.scan(needles, refs)`
  (the recursive scan of every key and string of every body on `state`,
  `note` and `boxes`; on the public catalog only full type refs count),
  `M.forms(hiddenIds)` (§2d's public forms), `M.unsorted()` (bodies whose
  items aren't in sorted-id order), and returns `send` (paced under the
  flood limit), `barrier(marker)` (she turns a piece of hers to a fresh
  angle and waits for it: everything she sent before is applied),
  `attempt(a, marker, quiet?)` → `{notes, since}`, `view(expr)`, `marks`,
  `notesSince`, `bodiesSince`. final-lib's `mallory(env, invite, peers)`
  waits for `peers` other peers (2 by default; 1 with a host alone).
- **The browser suites.** `t-p2-hidden.js`: spec §2j's attacker cases 1–14
  as Mallory (the host's own refusals of a guest's host-only actions come
  one per 10 s, so case 6 is spread out; case 13 deletes a box's catalog
  record on `h.plain` and reloads the host, then deals from a face-down
  pile of that box and plays a face-down hand piece of it: both stay
  `{b: null}`; case 8 fills the table to 4,990 with two setups first).
  `t-p2-cli.js`: cli.js and cli.py in parity (§2i)
  — each new command's action through a fake tab and, through real tabs,
  as the host received it (a probe script's `validate()` records every
  ruled action in `t.public`); the bridge API; the snapshot captured from
  the tab's `/state` POST (`page.route`); `table`, `players` and `hand` as
  text, the same in both REPLs, control characters stripped (a supply of a
  box the tab lacks: `? unknown piece`); a double-click on a locked board
  or on another player's die sends nothing, the die's bar stays empty and
  the host's bar on the board offers only `lock` and `give` (2B's full bar);
  `roll all` over more than 20 dice is said, and sends nothing. Case 13's
  host reload waits 45 s for the reloaded host's WebRTC link to Mallory;
  a link that never formed (a full run's load can stall signalling for
  minutes, as t-p1-delta notes) is tried again with a fresh side — the host
  reloads again, then Mallory is replaced by a fresh raw peer who keeps
  what she received and her seat (so `M` and `X` are `let`) — and each
  failed try logs what both sides saw (her peers and relay sockets, the
  host's status line); linked but without a snapshot fails at once. `t-ui.js`'s
  "seat labels follow a new table size": at a 1600 × 1400 view (no size
  draws small labels there, which are redrawn anyway), every seat label
  stays centred on its seat, `seatR(w)` from the centre, as the host's size
  selector goes 1300 → 1800 → 2400 → 1300, on the host and the guest.

## Phase 2 (2B: the interaction UI, rect tables, seats, the demos)

What `t-p2-pieces.js`, `t-p2-tables.js`, `t-p2-demos.js` and the
1,000-piece bench variants drive (spec §2g, §2k):

- **Items.** `.item.piece.shape-{rect|round|disc|hex|meeple|pawn}` sized
  w × h, plus `.supply`, `.board`, `.die`, `.pile.multi` (a pile of
  pieces); `.item.bag` (a `.bagbox` holding the drawn `.pouch` SVG, `.bname`
  and `.bn`, the count); a board's structure is the `svg.psvg` in its
  `.pface`. Badges: `.count` ("×N" from 2, "∞" on a supply, a pile's
  count), `.odot` (the owner's dot: `background` is the player's colour, or
  the seat's for a seat-bound owner), `.lockb` (🔒, displayed only under
  `.item.selected`). A roll puts `.tumble` on every rolled die's element for
  450 ms on every screen, the roller's too (its animation is off under
  reduced motion, which `h.start()` sets by default: the class still comes).
- **`pieces.js` in Node** (B11): `import('../pieces.js')` works without a
  DOM; `boardSVG(type)` takes a cleanBox'd board type (`cleanBox(box).types.x`)
  and returns the SVG string, cached per type object (the same string, at
  once, the second time).
- **The bar** (`#action-bar`, built from the public view): each button has
  `data-cmd` — pieces `flip`, `roll`, `rl`/`rr`, `split` (✂ Take 1), `all`
  (✥ Move all: `.on` while armed, 5 s), `hand`, `zoom`, `lock` (🔒 Lock /
  🔓 Unlock), `claim`, `release`, `give` (the host; opens `giveTo` buttons
  with `data-to` = a pid or `seat:<id>`), `del`; supplies `take`,
  `takeHand`; bags `pull`, `pullHand`; cards and piles as in Phase 1 (`flip`,
  `zoom`/`peek`, `rl`, `rr`, `hand`, `draw`, `dealup`, `dealdn`, `shuffle`,
  `del`), plus the host's `lock` on a locked one. Only what this player may
  do appears: an item someone else owns offers no move, a locked one
  nothing that moves, turns or removes it, and a die no rotation; a bar with
  nothing in it stays hidden. Keys (not in an input, nor on a button; a press on the table
  lets go of a focused button) run the bar's own commands when it shows them: R → `rr`, Shift+R → `rl`, F →
  `flip`, Space → `roll`, Delete / Backspace → `del`; Esc deselects.
- **Gestures.** A drag on a ×N stack splits one off (`split {n: 1}`, at the
  drop or `onto` a matching stack); Shift, or ✥ armed, moves it all; a plain
  drag on a supply sends `take {x, y}` (onto the hand bar: `{hand: true}`).
  Drops of a moved piece: a matching ×N stack → `join`, its supply → `join`
  (returned), a bag → `toBag`, a same-size pile piece → `stack`, a pile it
  fits → `toPile`, the hand bar (a hand type) → `toHand`, else `move`.
  A drag that starts on what the player may not drag (locked — boards are —
  or someone else's) pans the view and sends nothing; a click still selects
  it. Double-click: a die → `roll {ids}` of its handful (every die this
  player may handle within one die-width, transitively, ≤ 20; the clicked
  die first), a piece → `flip`, a supply → `take` next to it, a bag →
  `pull` (into the hand when it has `hand`), a card → `flip`, a pile →
  `draw`; nothing on a board or on someone else's item. A double-click
  toggles the selection twice: select with one click. Touch: a long press
  (≈ 450 ms) on a piece whose face has an image, a text or a label opens
  `#peek` with that face until the finger lifts.
- **Tables.** `#table.rect` for a rectangle. The host's `#size-sel` holds,
  on a rectangle, a first option `value="rect"`, selected and disabled,
  "▭ {w} × {h}"; choosing a round size confirms ("Switch to a round table?
  Items outside it are pulled in.") and sends `table {shape: 'round'}`.
  Zoom goes up to 4 · max(w, h) / 1300 on a rectangle (4 on a round table);
  a rectangle's seat view turns in quarter turns, the seat's nearest edge at
  the bottom.
- **Seats.** A named seat nobody holds is a `.seat.ghost` label ("White —
  empty", dashed in the seat's colour); a held one reads "White — Alice"
  (its border the seat's colour; 🂠 counts only on a table with hand items or
  for a non-empty hand). Labels let the pointer through; a click on one
  (not on an item under it, a board aside) opens `#seat-menu` (buttons:
  "Stand up (watch)", "Sit here", the host's "Seat ▸ {name}" and "Move to
  watchers"). `#watchers` ("👀 Carol, Dan": online watchers) and, for a
  watcher, `#watch-me` ("👀 You are watching — tap a free seat to sit"
  with named seats; "👀 You are watching" and `#sit-btn` "Sit down" with
  automatic seating), all in `#watch-box`, top right.
- **The hand bar.** `body.nohand` (then `#hand-bar` is `display: none`)
  iff the view has arrived, `!view.handy` and the hand is empty.
- **The demos.** `GAMES` entries `draughts` and `backgammon` (`box`: their
  `BOXES` key): `#games-list [data-game="draughts"]` (and the strip's) asks
  "Clear the table and set up Draughts? The current game is discarded." on a
  table with items or a rules state (accept the `dialog`), switches enabled
  rules off, then sends `loadBox {box: BOXES.draughts, setup: true, clear:
  true}`; the dialog then marks it playing.

**Changed for 2B** (mechanism only; no assertion removed or weakened):
`t-fun-games.js` lists the two box games in the strip and the dialog (9
entries); `t-p2-cli.js` expects the host's bar on a locked board to offer
`lock,give`; `core-p2.test.mjs` (R) checks that the public bag carries its
`box` (D88; `specPub` adds it); `t-p2-hidden.js` case 13 waits for the
reloaded host's link as above, with a fresh Mallory as the last resort.

## Storage and images (Phase 1B)

The host saves in IndexedDB (`../store.js`, database `cardtable` v1: stores
`saves` {room, ts, v, state} or {room, ts, lost}; `catalog` {room, id, kind:
'deck', deck} or {room, id, kind: 'box', box, src, by?} keyed [room, id]
(decks and boxes share one id space); `assets` {h, mime, size, data, used} keyed by
the image's SHA-256). localStorage keeps only `ct-pid*`, `ct-name`,
`ct-hostkey-*`, `ct-sort`, `ct-handh` and `ct-pending-<room>`; a legacy
`ct-save-<room>` / `ct-decks-<room>` is migrated on the host's next boot
(planting one still works).

**Helpers in `h.js`:**

- **`h.idb(page, store, key?)`**: the page's records of `store` as plain
  JSON (all of them, or the one under `key`; catalog keys are `[room, id]`;
  `null` when absent). Assets come as `{h, mime, size, used}`, no bytes. It
  never creates the database.
- **`h.plain(env)`**: a same-origin URL with no app on it (a script file
  shown as text): where a test plants storage a running app would overwrite.
  Navigating there from the app also fires its `pagehide` save.
- **`h.plantSave(page, room, state, decks?, ts?)`**: writes `{room, ts, v:
  state.v, state}` and one catalog record per deck of `decks` (`{id: v2
  deck}`), on a `plain()` page. A planted `v: STATE_V + 1` is a "newer" save.
- **`h.withStore(page, fn, arg)`**: runs `fn(store, arg)` in the page with
  store.js imported and opened (the database created with the app's own
  schema) — e.g. `S.putAsset(bytes, 'image/png')` plants an image of
  another room. On a page running the app it is the app's own module, so
  `S.holds(id)` tells whether the app holds an image in memory. `fn` is
  serialized: it sees only its arguments.
- **`h.quotaStub`**: an init script. While `window.__quota` names a store
  (`'saves'`, `'catalog'`, `'assets'`) — or is `{store, heal: n}` —
  `IDBObjectStore.prototype.put` into it throws `QuotaExceededError` for
  every record but a lost marker; with `heal: n` the n-th delete from that
  store (pruning, GC) lifts it. Set it before boot with an init script of
  your own (`t-sync-net.js` `fullOnce`), or at any time with `evaluate`.
- **`h.MODULE_V`**: the modules' code version (`store.js?v=…`).

**`node-lib.mjs`** also exports `store` (imageDims, checkImage, sha256hex,
putAsset and ingestDeck — which stores nothing: it resolves `{deck, cost,
assets}` — all run in Node; IndexedDB does not) and
**`FIXTURES`**, the directory of image fixtures: `37x23.png`,
`37x23-baseline.jpg` (SOF0), `37x23-progressive.jpg` (SOF2), `37x23.gif`,
`37x23-vp8.webp`, `37x23-vp8l.webp`, `37x23-vp8x.webp` — each 37 × 23 px,
made with ImageMagick (`convert -size 37x23 xc:red …`, `-interlace JPEG` for
the progressive one, `-define webp:lossless=…` for the WebP chunks, an
alpha colour for VP8X).

**What the app exposes and says** (for checks; texts are exact):

- `window.__ct.perf.lastSaveSyncMs`: the main-thread part of the last save
  (B6): the save transaction's `put()`s, which clone the state. A new deck's
  images are stored just before, in batches of their own, so the catalog
  never names an image the store lacks.
- The `asset` channel carries image bytes with metadata `{h, mime}`; a
  guest's image request is the action `{t: 'need', a: [≤ 64 ids]}`; the
  host's note `{missing: [ids]}` names the ones it lacks. A guest gathers its
  requests for 50 ms and sends at most 8 a second, only while the host is
  connected; it asks again once after 20 s without an answer
  (`NEED_TIMEOUT_MS`; the clock restarts whenever an image arrives, stops
  while the host is away, and waits out a `wait` the host gave), then gives
  up. Past a guest's 64 MB a minute the host keeps its queue for the next
  minute and sends one note `{msg: '🚫 Too many image requests — slow down',
  wait: ms}`.
- Faces: `img.face[src^="blob:"]` once drawn, `.face.loading` while on the
  way, `.face.missing` (or `.back.missing` for an image back) for good. An
  item's `data-sig` ends with the image's state: `u` drawn, `l` loading, `x`
  missing.
- Toasts: "This browser blocks storage (IndexedDB: …) — the table can't be
  saved; reloading the host tab will reset it" (a guest: "… — card images
  will download again next time"); "Couldn't move this table's save to the
  new storage: …"; "The last moment of play before the reload wasn't saved
  (the browser closed first)"; "This table was saved by a newer Card Table —
  reload this page" (pinned: it stays); "Browser storage was full — deleted
  N old table save(s) to keep this one"; "Can't save this table (browser
  storage is full) — reloading the host tab would reset it"; "Couldn't cache
  card images on this device (storage full) — they'll download again next
  time"; "Card Table was updated in another tab — reload this tab to keep
  saving" (a guest: "… to keep caching card images"; both pinned);
  "Couldn't read this table's save (…) — this tab won't save over it;
  reload this page to try again" (pinned: the tab hosts by its host key,
  and saves nothing); "Rules disabled — error in t.data / t.public: they
  hold a value that can't be saved (…) — keep them JSON"; "Card images are
  coming slowly — the host sends at most 64 MB of them a minute" (a guest
  told to wait); "N card images of this
  table are missing from this browser's storage" (host boot); "N card images
  are missing on the host — ask them to re-add the deck"; "A card image from
  the host was damaged in transit — retrying", then "A card image from the
  host arrived damaged again — it shows as missing". A refused deck: the note
  "🚫 Deck rejected: card 12: image is 30000 × 30000 px (max 4096 per side,
  16 Mpx)" (or "…: not a PNG/JPEG/WebP/GIF image", "the image claims to be
  image/png but is image/jpeg", "image is 2.4 MB (max 2 MB)", "the image's
  header can't be read"); a host over a
  guest's image budget sends "🚫 Too many image requests — slow down".
- Limits: `IMG_MAX_SIDE` 4,096 px and `IMG_MAX_PX` 16,000,000 px (store.js;
  a 4096 × 4096 image is over), `ASSET_MAX_BYTES` 2,000,000 (core.js); per
  guest the host keeps at most 2 image sends in flight, sends one image at
  most twice a minute, and at most 64 MB a minute (the rest waits for the
  next minute).
