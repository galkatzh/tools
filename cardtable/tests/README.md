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
  (a host long task under 50 ms; a move that reaches a guest pulling 34 MB
  within 1 s; go's stone #300 within 10 ms of Worker time), run alone, one
  at a time after the parallel batch, under the same lock: `SERIAL`, a
  comma-separated list of suite names, default
  `t-p1-bench,core-p1-bench,core-p2-bench,t-p1-flood,t-p1-assets,t-p3-go,t-p4-bench,t-p4-box-bench,t-p4-resume-bench`.
  A listed suite that doesn't exist fails the run.
- Runs take a machine-wide lock (`CARDTABLE_TEST_LOCK`, default
  `/tmp/cardtable-tests.lock`): concurrent runs on a small machine starve each
  other into flaky timeouts, so a second run waits for the first.
- Each suite's log is kept in `out/<suite>.log` until the next run; failing
  checks are listed with the log's path.
- `parse.js` parse-checks `app.js`, `rules-worker.js` (a Worker app.js
  starts by URL, never imports) and every local module they import as real
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
  items: its fold, the catalog held for it (the host sends a new
  connection its decks, boxes and rules in its lane just before its first
  snapshot, and the guest reads them once that snapshot shows the sender
  hosts), its DOM — every piece with its face, never a "?" waiting for its
  box — and the style and layout they cost (read at once) — a guest's
  first snapshot draws the table, and the one that registers it a moment
  later redraws nothing, so it doesn't count: after a guest's (re)load
  this is its cold render of the whole table;
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
- **Raw peers.** Every raw Trystero peer (Mallory, Eve, the spies) opens
  its page with `h.rawPage(env, label)` (a same-origin page with no app on
  it, plus an init script that sets `window.RawRTC` to app.js's own
  `WholeOffers` class, cut from app.js's text: `rawRtc` throws if it can't
  find `class WholeOffers extends RTCPeerConnection { … }`, and `rawPage`
  if the page has no `window.RawRTC`) and joins with `rtcPolyfill:
  window.RawRTC` (D95): without it a raw peer open for over a minute makes
  empty offers, and the page that answers one never links.
- **Links fail loudly.** A page's WebRTC links form in under a second, or
  never (D95, before the fix); no suite retries a link any more (they used
  to, as "the harness's signalling stall", which hid that bug). The app's
  own watchdog would retry one, though: a guest with no table reloads after
  20 s, and the join helpers (`h.hostAndGuest`, p1-lib's `player`, p2t-lib's
  `join`) wait up to 30 s, so a second page's link could hide a first that
  never formed. So `env.page` counts a watchdog reload (a page's console
  saying "reconnecting via reload: …") as a failure of the suite, printed
  with the page's label as `[label WATCHDOG RELOAD]`, as it does an
  uncaught error (`[label PAGEERROR]`) — on every tab of that player's
  browser: the page it opens, and any the test opens later with
  `context().newPage()` (t-bridge's rejoining guest, t-sync-relay's twin
  tab, the returning hosts of t-sync-ui and t-p2-review). Only a tab that a
  test means to lose its host or relays opts out, by `watchdogOK`, from the
  moment it may reload: from the start with `env.page(label, {watchdog:
  true})` (t-p2-review's Dan and Hana), or set just then (t-p2-review's Bob
  and Carol, as the host leaves). `t-harness.js` checks this: a child suite
  whose page, or second tab, logs the watchdog's line or throws must fail
  saying so, and one whose tab opted out must pass. t-p1-bench,
  t-p1-delta and t-p2-hidden (case 13) also fail a join or reload whose
  links don't form within 15 s at once, saying what both sides see (their
  "● n" and relay status). `t-p2-link.js` is the regression. Of two pages
  the one whose Trystero id sorts first makes the offer, and the id is the
  page's first 20 `Math.random()` calls: its `idFirst` init script makes
  the first one pick the id's first character (`sessionStorage`
  `t-id-first`, 'M' by default; it throws if the id didn't take it), so
  every run covers both sides. A guest reloaded beside a host open for
  over a minute, as 'z…' (the host offers) and '0…' (the guest does), twice
  each, gets the table within 5 s each time; a host reloaded beside a guest
  open for over a minute, as 'z…' (the guest offers) twice and '0…' once,
  reaches her within 8 s; and an init script on each page sees no offer
  without an `m=` line (on the app before D95 it fails all three).
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
  1,000-piece bench box of §2k, then B5, B1, B2 and B7 on it (2B).
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
  host reload must link to Mallory within 15 s, and then send her its
  public snapshot within 30 s; either failing fails at once, with what both
  sides saw (her peers and relay sockets, the host's status line). (It used
  to try again with a fresh side: the stuck side was the long-lived raw
  peer, whose aged pooled offers went out empty — D95.) `t-ui.js`'s
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
  the seat's for a seat-bound owner; always in the DOM, displayed only under
  `.item.selected` or, where the pointer hovers — `@media (hover: hover)`,
  not the iPhone descriptor — under `.item:hover`: D90), `.lockb` (🔒,
  displayed only under `.item.selected`). ×N, ∞, a pile's `.count`, `.lockb`
  and a bag's `.bagbox` turn (CSS `rotate`) by −(`--view` + `--rot`), so
  they read upright on every screen (D91; `--rot` is the item's `rot`,
  inline on every item element whose `rot` isn't 0); a pile's `.pname` is
  anchored at the pile's centre (`left`/`top` 50%, `translate` −50%), turned
  the same way there, and moved down by its `transform` past the pile's
  corners and its count (`--pr`, half the pile's diagonal), so it sits under
  its pile on every screen (D97). The view sheet (app.js) has three rules:
  rule 0 sets `--bz`, the badges' growth (`scale` of `.count`, `.odot`,
  `.lockb`; a `.pname` at most 2×; the rings' widths: it matches a selected
  item too; a coordinate's, capped by its board's `--lmax`), rule 1 a
  board text's `--view`, rule 2 the badges' `--view`. While two fingers
  move the view, rules 0 and 2 are left as they are; once the fingers rest
  (`PINCH_REST_MS`, 300 ms without a move: a hesitation is shorter), rule 0
  takes the view's exact growth if it differs from rule 0's by more than
  25% (`BZ_STEP`) and the zoom's growth at the fit the fingers landed on
  does too (so a twist alone never resizes); both are exact once the
  fingers lift (D96, D102, D103). Tests read `PINCH_REST_MS` from app.js's text
  (`p2t-lib.js`). A selected
  piece or card pile shows a ring: `outline` on a card pile's `.cardbox`
  and a rect's `.pface`, a `box-shadow` ring set off
  by a dark edge on a round or disc one, and `filter: drop-shadow(…)` on the
  `.item` itself for a hex, meeple or pawn (whose `clip-path` cuts an
  outline off), all in multiples of `--bz` px. A roll puts `.tumble` on every rolled die's element for
  450 ms on every screen, the roller's too (its animation is off under
  reduced motion, which `h.start()` sets by default: the class still comes).
- **`pieces.js` in Node** (B11): `import('../pieces.js')` works without a
  DOM; `boardSVG(type)` takes a cleanBox'd board type (`cleanBox(box).types.x`)
  and returns the SVG string, cached per type object (the same string, at
  once, the second time). Its coordinates are the `<text>`s of
  `g.blabels` (files in the margin strip right under the grid: `y` =
  grid bottom + min(margins) / 2), its spaces' and zones' labels
  `text.slabel`. On the table each coordinate turns about its own centre
  (`transform-box: fill-box`) by −(`--view` + `--rot`): the view's angle,
  set by the view sheet's rule 1 (its second), and the board item's `rot`, inline on
  its element; each `.slabel` by that angle rounded to the nearest half turn
  (CSS `round()`), so it is never upside down (D91). The coordinates also
  grow: `scale: min(var(--bz), var(--lmax))`, where `g.blabels` carries
  `--lmax` (its margin over the widest label's box, an em tall and 0.6 em a
  character wide; 1 to 1.6: D97). A board's `.pface` and `svg.psvg` don't
  clip (`overflow: visible`).
  p2t-lib's `boardTexts(p, id)` reads each text off the screen (its angle
  from `getScreenCTM`, which composes every transform; its box's distance to
  its own anchor and to the nearest other one; its font size in px, its own
  scale included; how far its ink — its glyphs' bounds, measured on a canvas
  in its font and centred as it is — mapped back into board units, stands
  past the board's edge) and the angle the first coordinate would show with
  its turn taken off for a moment; `upright(p, id, bare, who)` checks them
  all (each coordinate upright within 0.5° and inside the board within 0.5
  units, each label at most 90° off upright and inside the board, each
  within half a font size of its own anchor and nearer it than any other,
  `bare` the view's turn plus the board's). `badgeAngles(p)` reads each
  shown badge's on-screen angle from two probes at its top corners (and
  with `--view` and `--rot` zeroed on it, less its item's `rot`: the view's
  turn), and for a pile's name how far below the pile's lowest corner on
  the screen its top is, how far across from the pile's centre, and how
  much of the pile's count it covers; `badgesUpright(p, turn, who)` checks
  them (upright, the live turn, a name under its pile, centred, clear of
  the count).
- **The bar** (`#action-bar`, built from the public view): each button has
  `data-cmd` — pieces `flip`, `roll`, `rl`/`rr` (not on a die, nor on a
  circular — round or disc, `w === h` — piece whose side up is a plain colour: D92), `split` (✂ Take 1), `all`
  (✥ Move all: `.on` while armed, 5 s, a teal button whose bottom line
  drains), `hand`, `zoom`, `lock` (🔒 Lock / 🔓 Unlock), `claim`,
  `release`, `give` (the host; `.on` while open; its `giveTo` buttons, in a
  `display: contents` span, have `data-to` = a pid or `seat:<id>`), `del`;
  supplies `take`, `takeHand`, `all` (✥ Move: the touch way to move one);
  bags `pull`, `pullHand`; cards and piles as in Phase 1 (`flip`,
  `zoom`/`peek`, `rl`, `rr`, `hand`, `draw`, `dealup`, `dealdn`, `shuffle`,
  `del`), plus the host's `lock` on a locked one. Only what this player may
  do appears: an item someone else owns offers no move, a locked one
  nothing that moves, turns or removes it, and a die no rotation; a bar with
  nothing in it stays hidden; nor does a full hand (`hand`, `draw`,
  `takeHand`, `pullHand` need room under MAX_HAND). The bar follows every
  redraw (`syncBar`): a seat taken or left, a player joining, a hand
  filling up redraws it. Keys (not in an input, nor on a button; a press on the table
  lets go of a focused button, and a clicked or tapped bar button lets go
  of the focus itself; auto-repeats ignored) run the bar's own commands when it shows them: R → `rr`, Shift+R → `rl`, F →
  `flip`, Space → `roll`, Delete / Backspace → `del`; Esc deselects.
- **Gestures.** A drag on a ×N stack splits one off (`split {n: 1}`, at the
  drop, or `onto` a matching stack, its supply or a bag); Shift, or ✥ armed,
  moves it all; a plain drag on a supply sends `take {x, y}` (onto the hand
  bar: `{hand: true}`), Shift or ✥ moves it. A piece taken out and dropped
  back on its own stack or supply sends nothing. Drops of a moved piece: a
  matching ×N stack → `join`, its supply → `join` (returned), a bag →
  `toBag`, a same-size pile piece → `stack`, a pile it fits → `toPile`, the
  hand bar (a hand type) → `toHand`, else `move` — and a full bag, pile or
  hand (MAX_BAG, MAX_PILE, MAX_HAND, from the public counts) gets a `move`.
  A drag that starts on what the player may not drag (locked — boards are —
  or someone else's) pans the view and sends nothing; a click still selects
  it (a board only when nothing else is selected: then the click just
  deselects). The click a browser sends after a drag or a pan is no tap: it
  opens no seat menu. Double-click: a die → `roll {ids}` of its handful (every die this
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
  watchers"); a label's hit box is at least 32 px tall. `.seat.inky`: a
  near-black seat colour's label gets a light outline. `#watchers` ("👀
  Carol, Dan": online watchers) and, for a watcher, `#watch-me` ("👀 You
  are watching — tap a free seat to sit" with named seats; "👀 You are
  watching" and `#sit-btn` "Sit down", ≥ 32 px, with automatic seating),
  all in `#watch-box`, top right
  — moved just below a seat label that would lie under it there. A
  watcher's view of a rectangle is squared to its nearest quarter turn. A
  click on a bar button that redraws the bar (✥, Give ▸) is the bar's, even
  over a label: the wrap's click handler reads the event's path.
- **The hand bar.** `body.nohand` (then `#hand-bar` is `display: none`)
  iff the view has arrived, `!view.handy` and the hand is empty. `#turn-cue`
  lives in `#table-wrap` (bottom right, just above the hand bar), so it
  shows either way.
- **The table frame.** `#table` has no border (the rail is an inset
  shadow): its padding box, where items are placed, is the whole w × h, so
  a probe element at `left: x; top: y` in `#table` sits at table point (x, y).
- **Badges** (`.item > .count`, `.item > .odot`) are scaled up on a table
  drawn small (`scale` by `--bz`, 1 to 3), so a ×N pill's text shows at
  about 8 px or more: the view sheet's rule 0, which also grows the rings
  and a board's coordinates; see its three rules above (D91, D96, D97).
  `#table-hint` lies in `#table-wrap`, outside `#table`: screen space, a
  fixed 24 px (18 px on a phone), above the seat labels, whatever the view.
- **Watchers on a short screen** (`max-height: 500px`, a phone in
  landscape): `#watchers` reads "👀 N" and `#watch-me-text` "👀 Watching"
  until a tap on the box opens them (the whole texts); another, a tap on
  the table or 6 s (`WATCH_OPEN_MS`) close them.
- **The demos.** `GAMES` entries `draughts` and `backgammon` (`box`: their
  `BOXES` key): `#games-list [data-game="draughts"]` (and the strip's) asks
  "Clear the table and set up Draughts? The current game is discarded." on a
  table with items or a rules state (accept the `dialog`), switches enabled
  rules off, then sends `loadBox {box: BOXES.draughts, setup: true, clear:
  true}`; the dialog then marks it playing.

**`t-p2-pieces.js`** (spec §2l items 1–11, the rest of §2g's gesture
table, the keys, the bar). Two passes: a desktop host and guest (mouse,
Shift, double-clicks, keys; the guest with motion on, so the tumble really
plays), then both on the iPhone 13 descriptor (CDP touches; the bar stands
in for double-clicks). Its box `KIT` holds every kind — ×N stacks of a
2-face coin, a chit with a back, a 6-face wheel, a 60° hex tile, tiles with
a back that pile and go in hands, plain tiles without one, dice, a hidden
die and a hidden token sharing a back, a coin supply and a tile supply, a
bag of coins and a hand bag of tiles, a locked chess-labelled board — on a
1200 × 800 table, Alice South and Bob North (his view turned 180°: screen
points are read from the page, a probe element in `#table` mapping a table
point to the screen and three of them inverting it); `LOCKABLE` (lockable
`'anyone'`) adds a gem and a bag (D88). Every gesture is then read on both
screens: `__ct.view()`, the item's DOM (classes, the ×N / ∞ pills, the
`.odot` colour, the `.lockb` display, the pouch's count, the turn) and the
log (the entry after a mark in `view.log`, and its `#log` row). Which owner
dots show (`dotsShown`: those displayed, with a box) is read on both
screens (D90): only on the selected item, none once it is deselected (on
the phone too, whose tap leaves a stale `:hover`), under the desktop mouse
and gone with it, and on someone else's piece once a click or tap selects
it. The badges read upright on both screens (`badgesUpright`: Bob's view is
turned 180°), and a selected hex tile and yellow coin show their rings
(the computed `filter` and `box-shadow` hold the ring's yellow and the dark
edge). The bar is
checked exactly per kind and permission (guest and host, locked, someone
else's, seat-bound, a hidden piece's flags from its back, a bag's 🔒 by its
public box); 🔍, which the bar adds on a face with a label, text or image
(not in §2g's list), is expected there. "Nothing sent" is read off the RTC
hook (the guest's `act` bytes, the host's received ones) and the logs (no
line by either player), "no notice" off assets-lib's `toastLog`, a roll's
tumble off a MutationObserver (which dice get `.tumble` and for how long;
where motion is on, the 450 ms CSS animation). A piece keeps the spot it
was grabbed by, so what is moved or taken out lands at the item's place
plus the pointer's drag in table units; a piece played from the hand lands
centred under the pointer. Touch drags hold still 150 ms before lifting
(lifted while moving, Chrome starts a fling, and the next tap only stops
it: no click). A failed check saves both screens as
`shots/p2-pieces-<pass>-fail<k>-<name>.png` (a crash: `…-crash-<k>.png`);
each pass ends with `shots/p2-pieces-<pass>-<name>.png`. `ONLY=desktop` or
`ONLY=phone` runs one pass.

**The 2B suites.** `t-p2-tables.js` (spec §2l items 1–7: a desktop host
and guest and an iPhone 13 guest): a 2400 × 1200 table with a seat on each
edge, each seat's view turned by its quarter turn and fitted (scale = min(W
/ bw, H / bh), the table centred and filling the area's width or height,
the player's label at its bottom middle), the pan stopping at half the
table's on-screen width across and half its height down, the wheel zoom
stopping at 4 · max(w, h) / 1300; named seats (the joiner's free seat, a
watcher, the 👀 chip and notice, the seat menu's exact entries, `t.players()`
and `{all: true}` from a script's button, Sit down under automatic
seating); a seat-bound pawn moved by whoever sits its seat and panned by
the one who left it (nothing sent: the RTC hook's `act` bytes); the hand
bar with draughts, a deck, a held card, on all three screens, and the
refit; D91 on a round table whose named seats turn the three views 90°,
235° and 120°, with a chessboard turned 30° that has a labelled zone and
space below its grid, a ×4 stack turned 45°, a supply, a bag and a deck
(`TURNED`): p2t-lib's `upright` and `badgesUpright` on each screen, and
the files' anchors in the 20-unit strip under the grid; a v2 save (`size: 1800`) planted and resumed;
the size selector's "▭ 2400 × 1200", its confirm declined, then accepted
(the corner pegs pulled in). `t-p2-demos.js` (a desktop host, an iPhone
13 guest): draughts and backgammon from the 🎲 dialog, played with real
drags, double-clicks and taps (see its header); the draughts board's
coordinates upright on both screens, the Dark phone's turned 180° (D91:
`upright`), and grown there as far as their 20-unit margin holds (`scale`
1.25, 5.5 px or more: D97); the standard backgammon start is
read off the board's own points (each checker by the triangle under it),
either home-board side accepted; screenshots `shots/demo-*.png` and
`shots/tables-*.png` are for review, never asserted. `t-p1-bench.js`
re-runs B1', B3, B4, B6 and B8 on §2k's bench box (first, then the cards) (`p2t-lib.js` `BENCH`,
the B4 baseline an empty 6000 × 4000 rectangle), then B10 — three new
guests joining on a desktop, and three on the iPhone 13 at CPU × 2 (each
a fresh page: its snapshot render, `lastSnapRenderMs`, and whether that
render drew the pieces or "?" placeholders: `placeholderWatch` records the
most at once), and a snapshot asked for after a lost patch (`__rtc.drop`),
when the boxes are already there — and B11 in the host's page (eight 64 × 64 boards, square
and hex, every draw mode, 4,096 fills, 64 marks: the first `boardSVG` call
and the cached second). `core-p2-bench.mjs` adds B5, B1, B2 and B7 on its
own 1,000-piece table (a move patch of a token; 50 `t.find({kind: 'die'})`).
A join or reload whose WebRTC links don't form within 15 s fails at once,
with both sides' status (no retry: see "Links fail loudly" above); one
linked to everyone that gets no table fails too. After the bench box, B4
also takes five two-finger gestures on the phone (two touch pointers, 3 s
of moves, CPU × 2, from the fit at its seat: `gestureB4`) over 1,000 ×3
stacks: a twist of half a turn and a pinch from the fit to 12× on 6000 ×
4000, and a half-turn twist on 1800 × 1200, whose fit — and the badges'
exact size — changes by over 25% as it turns. Each: no long task over 50
ms while the fingers are down, the rAF p95 within the pan's budget (after
one gesture not measured: the table's first turn off its axes, or first
zoom that far, redraws its layer once, a 60–200 ms frame with these
badges), then no task over 150 ms as the badges settle once they lift, at
the view's exact angle after the twist, at the zoom's size after the pinch
(D96). Then the same pinch in four legs (D102): with the fingers
hesitating 200 ms between them (`--bz`, read from its rule at the end of
each pause, never changes: the check a rest too short fails; no task over
150 ms, as a hesitation alone can let the browser raster the layer again
at the new zoom, which the next move waits for — 50–65 ms with `--bz`
unchanged, in 3 of 52 measured pinches), and resting
`PINCH_REST_MS` + 50 ms (at each rest `--bz` takes the zoom's size if it
differs from it by over 25%, and the fingers move on 50 ms after that
write: no task over 150 ms while they are down — a resize at a rest costs
what the settle at the lift does). These two skip the p95 check: their
moves are the pinch's, their pauses idle frames. The p95 rows compare
against the empty-table pan measured once, near the start: on a box short
of CPU for raster (another heavy job beside the run), a gesture's or a
pan's p95 can read 33 ms (every other frame) with no long task at all, on
the app before a change as after it (at the Phase 2 close-out's fifth
review the 6000 × 4000 twist failed so in 3 runs of 8, and the 1,000-card
pan once). A red p95 row with no long task points at the box, not the app.
**`p2t-lib.js`**: `join` (a player, once the host knows it; `o.rtc` adds
the RTC hook, `page.pid`), `waitView`/`viewOf` (an expression over `v`,
`me`, `a`), `tf` (#table's pan, turn and scale), `wrap`, `fit` (§2g's
formula), `labels`/`label`/`openMenu`/`pick`/`menu` (the seat labels and
their menu, by click or tap), `feltPoint`, `mouseDrag`/`touchDrag` (CDP
touches)/`dragOn`, `itemXY`/`clickItem`, `sentActs`, `rgb`, `shows`,
`inViewport`, `boardTexts`/`upright` (a board's texts as the screen shows
them, D91: see "`pieces.js` in Node" above), `badgeAngles`/`badgesUpright`
(the same for the badges), `PHONE`, `BENCH` and `PINCH_REST_MS` (read
from app.js's text: a rest of the fingers, D102).

**`t-p2-review.js`**: the regressions of the 2B review, one section per
issue (a desktop host, a desktop guest, an iPhone 13 watcher; see its
header): a hand piece lands where the pointer let go and a centred board
sits mid-felt; a joining guest never draws a "?" and draws each item once;
a drop or a pan ending on a seat label opens no menu, nor does a click on
a bar button over a label that the click redraws; a board tap with a piece
selected only deselects; Give ▸'s buttons are spaced; ✥ looks armed and disarms after 5 s; one
coin off a stack onto a bag or its supply goes in or back, a take or split
dropped back on its source sends nothing, an overflowing bag is not
offered the drop; a held Space rolls once; after a click on a bar button
(⟳, Flip, ⟲) R turns again, Space does not press ⟳ again, F flips and
Delete removes (the tile type has two faces for it); after ? then Close and
+ Deck then Cancel, clicked, the focus is on the body (not back on the
button that opened the dialog), R turns the selected tile and Space opens
no dialog; after a chat message sent with a click on ➤, the focus is in the
chat box and " r", Backspace and Delete go there (nothing sent, the tile
unchanged); a seat change redraws (and
empties) a selected seat-bound piece's bar, and Delete then sends nothing;
on the phone, the near-black seat's halo, a seat label's 32 px hit box, the
watchers box clear of the labels, badge sizes, the help dialog inside the
screen, ✥ Move moving a supply by touch, Sit down's height, a watcher's
squared view; the turn cue on a table without a hand bar; the watcher's
phone turned to 844 × 390 with the log open: two compact chips that cover
no piece nor the board, opened and closed by a tap; and the watchdog — the
host closes its page, its guest reloads itself after about a minute (not
before) with the notice "The host has been away for a minute —
reconnecting…", the new page shows the kept table again, paused (no
snapshot yet, no "?"; the hint never says "Connection lost", read by
`hintWatch`), keeps `ct-rejoin-<room>` (40 s) through its ticks, reloads again
40–52 s later saying "for 2 minutes" (the console: unreachable for 95 s or
more), where a wheel zoom leaves the hint at 24 px and inside the table
area; it goes live with the host's snapshot when the host returns, and
`ct-rejoin-<room>` goes. Last, a host alone (Hana, whose relay is a TCP proxy the
test cuts) reloads itself and keeps no `ct-paused-*` entry.

**Changed for 2B** (mechanism only; no assertion removed or weakened):
`t-fun-games.js` lists the two box games in the strip and the dialog (9
entries); `t-p2-cli.js` expects the host's bar on a locked board to offer
`lock,give`; `core-p2.test.mjs` (R) checks that the public bag carries its
`box` (D88; `specPub` adds it); `t-p2-hidden.js` case 13 waits for the
reloaded host's link as above.
In the 2B fix-up: `t-p2-pieces.js` expects ✥ Move (`all`) in a supply's
bar, and its "a drag pans" check resets the view (🧭) before the tap that
selects (on the phone, Bob's 40 px pan now takes the lone die, drawn where
it really is, wholly off the screen); `core-p2.test.mjs`'s split section
replaces "split {onto} a supply of the type is refused" by the new rule
(onto its supply the pieces go back, onto a bag they go in, atomically; a
supply of another type, a full bag, a hand bag and a hidden stack onto a
supply are refused whole). In the second fix-up, `t-p1-bench.js` measures
what its budgets name: B4's long-task observer starts in a task of its own,
after the probe's search for bare felt (on the 1,000-card table that
search's thousand `elementFromPoint` calls were the 53–62 ms "long task",
reported because it ended after the observer started in it: a CPU profile
of six pans put every one of them before the pan's first event), and B6
makes one unmeasured move and save before the measured ones (after the
idle pan, that one ran slow alone in some series: 10.0 ms once). After the
close-out review B6 measures both paths a save takes: ten moves right after
the last save (rapid play: the throttle makes each wait), and five each
1.1 s after it (unhurried play: no throttle; the app now starts that save
250 ms after the move, out of its burst of work, where it had run at once
at 2.4 ms median and once 11.5 ms under a full run's load; a page's first
save still starts at once, which t-p1-review's "newer" and t-p2-tables'
v2-save sections rely on: they leave a fresh table right away), each
against the 8 ms budget. `t-p1-review.js`'s log section counts the lines the three
moves really added (a move whose line repeats the one before collapses
into it: with 20 decks, two of the cards can share a name, which had made
it see 2 rows for 3 moves now and then) and expects one row in and one out
per line.
`t-uxfix.js`'s UX-14 reads a live name bulb's place from `style.translate`
(the app now places bulbs by a translation, not `left`/`top`: a pan frame
lays nothing out — a trace of the card B4 pan showed each of its first ~50
frames re-run a 7 ms hover hit test of the 1,000 cards, set off by the
bulbs left from B1'/B3's moves, until they faded). At the Phase 2
close-out (D90: the owner dot shows only on the selected or hovered item),
`t-p2-review.js` taps North's pawn on the phone before it measures that
pawn's dot (a hidden dot has no box), and taps the felt after. After its
review (D92: no ⟲ ⟳ on a plain disc), `t-p2-pieces.js` expects no
`rl`/`rr` in the bars of the plain coins, the chit and its hidden stack,
and the gem, and turns the 6-face wheel (a disc with a label) instead of a
coin to check a free rotation; `upright` checks a coordinate's `bare` turn
(the first `.blabels text`), and the labels' own rule.
After the close-out's second review: `t-p2-link.js` is new (D95, above); the
raw peers open with `h.rawPage` and join with `window.RawRTC`; t-p1-bench
(B8, B10's joins), t-p1-delta (its raw peers and reloads) and t-p2-hidden
(case 13) no longer retry a link that never forms, they fail within 15 s;
`t-cli-edge.js`'s Python driver prints READY once its listeners are on (the
suite sends a state the moment it reads READY: under load the state came
before the STATE listener, and no STATE line was ever printed);
`t-p1-assets.js` joins the SERIAL list (its section 9 holds a 1 s budget,
which a CPU-starved parallel batch once broke at 1.7 s with no long task on
either page). `t-p2-review.js` adds ? closed with Escape and a guest's +
Deck → Add deck (which closes after an await) to its dialog-focus cases;
Dan, on a relay that drops every connection, with an old backoff of this
room's planted in his tab: his page reloads for its relays only (never
blaming the host), the first time after its own 20 s, and his hint says
"Can't reach the signaling relays"; and in landscape the watcher's box
opens in the right margin, says every seat is taken, and closes on a tap
on the table or after 6 s. `t-p2-tables.js` expects "every seat is taken"
while both named seats are held, and "tap a free seat" once one is free;
on a round table with four named seats it checks a 10 × 10 board's
two-digit ranks inside the board on the phone, and that the paused hint's
plate covers no seat label (desktop, phone in landscape). `t-p2-pieces.js`
expects ⟲ ⟳ on a plain oval (round, 120 × 50). `t-p1-store.js` hides the
host's tab right after a move: marked pending, in the save 200 ms later
(D99). `t-p2-demos.js` expects the draughts coordinates at 1.25× on the
phone (D97).
After its third review: `env.page` fails a suite on a watchdog reload
(above); `t-p2-link.js` chooses the pages' ids rather than drawing them
(about one run in six covered only one side before); the raw peers' class
is app.js's own text. `t-p2-review.js` slows Dan's Trystero by 16 s from
his second page on: his backoff still doubles (80 s or more), since the
page a reload opened is told by `performance.timeOrigin`, not by when it
booted (D100); and two first-time players linger on the name dialog, then
join through a relay that takes 6 s to answer: Ivy (12 s, a guest) is
never told her relays can't be reached, Jay (25 s, a new host) is not
reloaded, nor told his connection struggles (the clocks start at the join,
D100). `t-p2-tables.js` checks every text the hint can show on its plate,
the iPhone held upright included, and at the plate's 140 px floor; on the
phone a selected deck's ring is 3 × `--bz` table px (D97), and a pinch
from the fit to 3× keeps the badges' growth within 25% of the zoom's while
the fingers move, exact after (D96); a 1100 × 1800 table seen from its
West seat on a phone in landscape keeps the notices, a toast and the
opened watchers' box in the margins beside the felt as the view shows it.
`t-p1-store.js` hides the host's tab while a save is in flight, moves,
and hides it again: one save open at a time, and the last move saved (D99).
After its fourth review: `env.page` watches every tab of a player's
browser, not only the page it opens, and a tab opts out (`watchdogOK`) from
the moment it may reload — t-p2-review's Bob and Carol as the host leaves,
no longer from their first join; `t-harness.js` is new (above). The badges'
size waits for the fingers to rest (D96): `t-p2-tables.js` pinches from the
fit to 3× in three legs, resting after each — `--bz` never changes while
the fingers move, and takes the zoom's size at each rest — and, on the tall
table in landscape zoomed in 2.5×, twists a quarter turn resting halfway:
`--bz` stays until the lift, though the new fit changes the exact size by
1.6×. t-p1-bench's B4 adds a pinch from the fit to 12× and a half-turn
twist on an 1800 × 1200 rectangle (it failed both at the third review's
fixes: long tasks of 52–83 ms and 669 ms while the fingers moved).
After its fifth review (D102: a rest is 300 ms, and resizes by the badges'
size): `t-p2-tables.js`'s pinch goes in five legs — a first rest at a zoom
just past 25% from the fit whose size is within 25% of the fit's ×3 (it
keeps ×3), a 200 ms hesitation (no resize, though a rest there would),
rests of `PINCH_REST_MS` + 200 ms that resize or keep by the 25% rule, and a
lift that is exact; at 182d588 the first three fail (it wrote 2.44 at that
first rest, which the hesitation still showed; with a 120 ms rest alone,
the hesitation's check fails on its own, a 2.06 write). t-p1-bench's B4
adds the paused and rested pinches (above); at 182d588 the paused one
fails on `--bz`, written at the hesitations (it also had a 61 ms task as
the fingers moved on: since the sixth review the row's task budget is
150 ms, as a hesitation's raster alone can cost 50–65 ms).
After its sixth review (D103: a rest writes the view's exact size, when
both it and the zoom's at the fit the fingers landed on differ from the
badges' by over 25%), `t-p2-tables.js` adds, on the tall rectangle in
landscape, a zoom after the quarter turn (to 3.67×: the badges keep 1.31,
within 25% of the exact 1.46) and a second gesture from the fit: a
quarter turn while zooming by the refit (they keep ×3, the exact size)
and a zoom on to 2.5× (the exact 2.14). At c48b966 the three fail: it
wrote the landing fit's size, 1.00, 2.00 and 1.31.

## Phase 3 (3A: space)

What `core-p3.test.mjs`, `t-p3-space.js` and `t-p3-review.js` drive (spec
§3a–§3e, §3g, §3i; decisions D104–D118). Wire version 4, state version 4:
raw peers import `PROTO` from `core.js` (`h.PROTO`), saves use `STATE_V`.

- **`grid.js` in Node**: `gridSpot(g, x, y)` → `{c, r}` or null (cells: the
  one holding the point; points: the nearest within `cell / 2`, Euclidean;
  hexes: pixel → axial → `hexRound`), `spotAt(B, x, y)` → `{local, x, y}`
  (spaces first: distance 0 inside a space's `w × h` rectangle, else from
  its centre, within `r`: D104), `parseLocal`, `canonLocal`, `spotOf`,
  `zonesAt`, `pointInPoly` (an edge or corner is inside), `neighbors(B, s,
  {diag})`, `distance(B, a, b, {metric})`, `line(B, a, b)`, `linked(B, id)`;
  a board's frame: `toLocal(b, x, y)`, `fromLocal(b, x, y)`, `onBoard`,
  `turn` (quarter turns exact). Everything board-local, as `cellCenter`.
- **`core.js` exports**: `tableBoards(entries, boxes)` → `{list, byId,
  primary, prefix}` (shown boards with a grid, spaces or zones, oldest
  first; the same function over host items or a public view),
  `displayAddr(TB, q)`, `resolveAddr(TB, s)` → `{b, local, at, x, y}`,
  `{ambiguous: [display forms]}` or null, `snapAt(TB, cx, cy)` (the spot in
  reach of a centre: snapping's and containment's), `snapTo(TB, table, w, h,
  x, y, {free, at})` → `{x, y, at}` (where a piece put at top-left x, y
  lands: the host's place, the page's preview, `__ct.snap` and the CLI's
  `place` — one rule, D112), `snaps(it, boxes)` (whether an item snaps:
  a piece, neither a board nor a die), `clampShift(table, centres, dx, dy)`
  (a group drag's shift, cut so every member stays on the table),
  `zonesUnder`, `boxFromDef` (game.json → a box for `cleanBox`), `liveFx(fx,
  d)` (a tick's fx less the live drags its commit overtook), `gateTimers`,
  `MAX_TIMERS`, `TIMER_TAG_MAX`, `AGG_MIN` (4), `AGG_NAMES` (8),
  `MAX_GROUP` (200). On a table: `T.byAt` and `T.byZone` (getters that
  bring them up to date), `T.boards` (its `tableBoards`), `T.snapPiece(it,
  x, y, o)` → `{x, y, at}`, `T.display(q)`, `T.drag(p, a)` → whether an fx
  `{p, id, x, y, live: 1}` (or `{p, ids, dx, dy, live: 1}`) was queued.
  Host items keep `at` QUALIFIED (`'<board id>:<local>'`); the public
  piece, the log and every script-facing value show the display form.
  `MIGRATE[3]` reads a v3 save's addresses off its boards by containment
  (`s.boxes`: createTable migrates the state with its catalog).
- **`__ct` (Phase 3)**: `resolve(addr)` (this view's boards: `{at, local,
  x, y}` with `at` in display form, `{ambiguous}`, or null), `snap(id, x,
  y)` (where a move of item `id` to top-left x, y lands as this view sees
  it: `{x, y, at}`; t-p1-bench waits for its moves there), `drawn(id)`
  (`{x, y, tx, ty}`: its element's left/top — fanned — and translate — a
  live drag), `lives()` (`{id: {x, y}}`: the live drags it shows), `spot()`
  (the snap preview during a drag, else null: `{x, y, to, slot}` — the
  top-left the drop sends, the address, and `slot`, where it will be drawn:
  its place in the spot's fan, where the ghost is).
- **DOM**: the snap preview is `#table > .snap-ghost` (table units,
  `translate`d; `.round` for round and disc pieces; `hidden` when off a
  spot) and `#table-wrap > .snap-chip` (screen px, its text the display
  address); both `pointer-events: none`. A crowded spot's top piece
  carries `.item > .fanb` ("×k", amber, bottom left: a stack's `.count` is
  blue, top right); `.fanb` joins the view sheet's rules 0 (`--bz`) and 2
  (`--view`), like `.count`. Fanned members' `style.left/top` are their
  drawn places (the state keeps them centred on the spot), laid out from
  the spot's centre; a member off the centre (a board moved under it, a v3
  save) is drawn where it lies and only counted (D116), until a member
  centred there joins it: then the spot fans all of them (D120). A live drag is the
  element's `style.translate`; when it ends, its left/top jump to the new
  place and the translation alone runs out (endLive).
- **The wire**: a guest's drag sends `{t: 'drag', id, x, y}` every 60 ms
  (`LIVE_MS`), never a `move`; the drop is the one `move`, carrying the
  snapped `x, y` and an advisory `to`. The host relays a drag outside its
  queue (no state, no seq): a patch with only `fx`. Whatever a payload says
  of `to` (but an `owner`'s, the new owner), `from`, `pick` and `handled` is
  dropped at the top of `act`; `prepare` sets the host's `to`, `from` and a
  pull's `pick` (a vetoed pull's draw waits for the bag's next pull: D114).
- **`t-p3-space.js`** (spec §3l items 1, 2, 7, 8, 10, 11; §3j attacker
  cases 4 and 7; its 3C sections, items 3, 4, 6 and 9, are under "Play on
  the screens and the terminal"): Alice on a desktop, Bob on an iPhone 13, Carol on an
  iPhone 13 in landscape, Mallory raw; every interaction a real drag or
  tap. Draughts (cells, the snap preview and the chip, the three log
  forms, live drags both ways, a locked piece), backgammon under snapping
  (t-p2-demos's script: the fan along each point's `dir`, "×k", a tap or a
  drag on a crowd takes its top checker, 15 on one point), then a script's
  table (`t.newBox`, `t.spawn`: go points, pointy and flat hexes, spaces;
  a.to / a.from / a.pick echoed by validate and onAction; a lying `to`; a
  rack and a second map; moving and turning a board), and Mallory's drags.
  Its expectations come from the spec's geometry, written out again in
  **`p3-lib.js`**: `spotXY`, `addrOf` and `expectSpot` (§2a's centres and
  grammar, §3a's snapping and D104, by brute force rather than grid.js),
  `onTable` (a board's turn); on the screen, `screenOf` / `tableOf` (a
  probe in `#table`: exact under any view turn), `svgLocal` / `svgScreen`
  (through a board's SVG, as drawn), `centreOf`, `preview` (the ghost, the
  chip and `__ct.spot()`, two frames on: touch moves arrive frame-aligned),
  `topAt` (what is painted on top at a point, overlays included);
  `gesture` / `dragTo` (a mouse or CDP touches, a pause per point, `mid()`
  with the pointer still down); `actTap` (an init script: the actions a
  page sends, decoded, in `window.__acts`), `join` (with it and p1-lib's
  rtcHook, bodies kept), `liveFx` and `scanLive` (the live-drag fx in
  recorded bodies).
- **`core-p3.test.mjs` (R)**: the 3A fix-up's regressions, each failing on
  the code before it: a veto keeps a pull's draw (300 aimed pulls fish no
  Big tile out of a bag of mixed sizes), host-set action fields on every
  action and a deal's `a.to`, `t.newBox`'s deck cap and `__proto__` ids,
  the load gates on items that never snap, dice, an explicit address kept
  until a board under it changes, one snapping rule past the playing
  area's margin, hexes at the grid's rim (brute force), a round table's
  group drag; from the second review, a piece on an edge spot past the
  margin unmoved by a reload (snapshot → createTable → resume), a new felt
  and a resize there and back (D119). Its reference `snapper` leaves dice
  out (D112).
- **`t-p3-review.js`** (the fix-up's regressions on real screens; Alice on
  a desktop, Bob on an iPhone 13, Carol on one in landscape with motion
  on): a v3 backgammon save resumed (`h.plantSave`) draws every checker
  where it lies, on its point; a checker put back on one of them makes
  that point fan all five (where Phase 2 spread them), a press on an
  off-centre checker takes that checker, and one brought to a point with a
  bare base closes its fan up, none drawn over another (D120); a checker of each colour on the bar (both
  show; each player's press takes their own); a guest's drop drawn at the
  preview's slot in every frame from the release; a live glide's end on a
  watcher (no step back; left/top stand still: translate alone); a die
  dragged over a point (no ghost, no address); a board move (pieces off a
  spot's centre drawn where they lie, `perf.drawn` unchanged).
- **Existing suites changed for Phase 3A** (mechanism changes, no check
  dropped): `core-p1.test.mjs` (`migrate` runs on through `MIGRATE[3]`;
  `t.find`'s unknown-filter example is `color`, as `zone` is known now),
  `core-p2.test.mjs` (PROTO 4, STATE_V 4, `drag` in `PUBLIC_ACTIONS`),
  `t-p1-bench.js` (B1', B3 and B6 wait for a move where it snaps:
  `__ct.snap`), `t-p2-cli.js` (a pull's `validate` sees `pick`),
  `t-p2-tables.js` (the save is `STATE_V`); in the fix-up, `t-p2-demos.js`
  (a lone checker on the bar is drawn at the bar's top end: the bar fans,
  D115), `t-fun-motion.js` (a remote move's glide may be a `translate`
  transition: a live drag's end, D116) and `t-p3-space.js` (its bar check
  reads the bar's fan, `fanned`); in the second fix-up, `t-bridge.js`
  (`dragItem` waits until the card is drawn where the state has it: another
  player's refused drop shows at its live spot until the host's next tick,
  and a press measured there landed on the felt). `core-p2-bench.mjs` is as Phase 2 left
  it: dice never snap (D112), so B9's roll of 20 dice on the board is back
  under 3 KB.

## Phase 3 (3B: the engine and the rules Worker)

What the 3B suites drive in core (spec §3c–§3f, §3h, §3j; decisions D121
onward). On a page, rules run in the rules Worker (`../rules-worker.js`,
next section); core is the same there, in the page and in Node.

- **The journal** (on a table): `T.begin()`, `T.savepoint()` → a token,
  `T.rollbackTo(token)`, `T.rollback()` (to the begin), `T.checkpoint()`
  (a savepoint), `T.commit()` → the StatePatch of §3f.2 (`items` — whole,
  null when removed, sorted ids — `players`, `decks`, `boxes` (`{box, src,
  by?}`), `rules` (the fields that changed), `table`, `seats`, `log` (the
  lines appended), `zMax`, `boardSeq`, `guestDeckChars`, `lastSetup`,
  `refresh`, `refreshHands`). Every write records a pre-image the first
  time it touches an item, a player, a deck or a box; each savepoint keeps
  `rules.data`, `public`, `asks`, `secret` and `hints` as JSON. The patch
  holds the table's own objects: `structuredClone` it (as postMessage
  would) before applying it to another table. `T.apply` inside an open
  journal is a savepoint of it.
- **The pipeline** (`T.apply`): handle → `strict` / `allow` → validate →
  the default effect → a checkpoint → the hooks the action implies →
  onAction (`a.handled` after a handled one) → buttons → the gates
  (`t.data` ≤ `DATA_MAX_CHARS`, `t.secret`, asks). Hooks get a frozen deep
  copy of `a`. `T.rulesError` names the failing hook ("handle(): …"); a
  thenable from any hook counts as a throw. `T.inHook` is true while one runs.
- **Internal actions**: `T.apply(p, {t: '_join', name})`, `_leave`,
  `_tick` (p: `'RULES'`), `_rulesOff {reason}`, `_name {name}`; `T.join(p,
  name, key)` is `T.bindKey(p, key)` plus a `_join` when p is new, offline
  or unnamed; `T.leave(p)` and `T.runTimers()` are `_leave` and `_tick`.
  `PUBLIC_ACTIONS` gains `answer` and `select`, never a `_` name.
- **Asks, hints, secrets**: `cleanAsk(spec)` (exported: the normalized ask,
  or a TypeError), `gateRules(r)` (the load gates: asks, secret, timers;
  hints dropped), `t.ask`, `t.cancelAsk`, `t.asks`, `t.hint`, `t.secret`;
  the caps `ASK_MAX` (8), `ASK_OPTIONS`, `ASK_AMONG`, `ASK_PROMPT`,
  `ASK_LABEL`, `ASK_COUNT`, `ASK_RANGE`, `HINT_MAX`, `SECRET_MAX_CHARS`,
  `SECRET_TEXT_MAX`, `SELECT_PER_SEC`, `STRICT_ACTIONS`. `{t: 'answer', id,
  v}` (v: an option's index, an item id, an address, `[{idx, d, i} | {idx,
  t, f}]`, a number) and `{t: 'select', id}` are ordinary actions
  (`__ct.act` sends them).
- **Each player's own parts**: `takeDirty()` gains `asks`, `hints` and
  `secret` (sets of pids, found by comparison); `T.mine(to, d)` is what a
  patch carries for `to` alone (`hand`, `ask`, `hint`, `sec` — those that
  changed, null when cleared), `T.mine(to)` a snapshot's (the non-empty
  ones); nothing for a peer that isn't a registered player. A view
  (`viewFromSnap`, `applyViewPatch`) holds `ask` (a list, `[]` for none),
  `hint` and `sec` (null for none); `sharedText` refuses all three. The
  rules view gains `wants: ['select']` and `strict: true` while on.
- **The Worker side**: `T.job(p, a)` → `{changed, patch, out: {effects,
  error?}}` or `{fatal, detail?}`; `T.applyStatePatch(patch, out, job)`
  (true when changed: it renumbers; it checks the whole patch first and
  throws, applying nothing, on a field the engine wouldn't write — against
  `job`, who acted, too); `T.digest()`; `T.guard()` (`{why, detail?}` when
  the script broke the rules between jobs, or null).
- **`core-p3.test.mjs` (3B sections)**: spec §3l core-p3 items 2, 3, 4
  and 7, with a fake script whose every hook hands over to a function of
  the test (`fake(hooks, flags)`, through `globalThis.__p3b`); `rtable`
  enables it with `T.job`, as a Worker would, on a table whose clock stands
  still until the test moves it (`T.clk.t`). (2) The journal: each
  mutation helper rolled back exactly (state, indexes, `T.pub`) and
  committed onto a twin table; savepoints nest; the StatePatch's shape.
  (3) Every row of §3f.4's atomicity table (handle and validate fail closed
  on a throw, an async hook, a Promise or a thenable; the nine hooks after
  the checkpoint, and buttons(), keep the action and lose their ops;
  `group` is Phase 4's), strict / allow / seat, the order, `a.handled`, a
  frozen `a`, the handled drop's refresh, the hint a veto puts back, `this`
  not journaled. (4) cleanAsk accepted and refused for each form, t.ask /
  cancelAsk / asks / hint, setRules keeping or resetting the state, the
  gates on load and at commit. (A) answer, (Sel) select, (I) internal
  actions, (P) each player's own parts and a host reload mid-ask, (G) the
  live facade and guard(), (7) three seeded runs of 300 random jobs through
  a Worker-like mirror (`T.job`) and a host that only applies its
  structured-cloned patches: the digests equal after every job,
  the whole tables and logs equal, every effect delivered; applyStatePatch's
  gates and steps. Two traps for such checks: notices are flood-limited
  (10, then 5 a second) and the log collapses a repeated line, so a check
  that expects either again moves the clock, or logs something between.
- **Existing suites changed for 3B part 1** (mechanism changes, no check
  dropped): `core-p1.test.mjs` (a ruled move serializes `t.data` three
  times — the journal's snapshot as the job begins, after validate, at the
  end — where it was two), `core-p2.test.mjs` (`answer` and `select` in
  `PUBLIC_ACTIONS`, and no `_` name), `t-engine.js` (its probe of the timer
  loop reads core's `_tick` job, which replaced `runTimers`'s body).

### The rules Worker (3B part 2)

A host page never runs a rules script: Enable starts a module Worker
(`rules-worker.js`) over a copy of the host's state (no seat keys) — it
evaluates the script and runs every queued job on its mirror (`T.job`),
and the host applies each job's patch (`T.applyStatePatch`). So, in an
E2E test:

- **Enable is asynchronous.** `__ct.act({t: 'setRules', code, enabled:
  true})` resolves once the Worker is ready AND the setRules job (setup
  included) is applied: `{ok: true}`, or `{ok: false, error}` when the
  code didn't evaluate (the running rules unchanged). The 📜 dialog's
  Enable says "Starting…" until then; `h.enableRules(page, {tpl | code})`
  waits until the dialog closes or shows an error. Every queued action
  waits while a Worker starts (an Enable, a host reload with the rules on).
- **A script can't see the page.** Its `window` is the Worker's global
  scope (`window.CAH_CARDS` is copied in, `WORKER_GLOBALS` in app.js), so a
  test can't hand a script a page function (`window.TEST`): it sends what
  the script needs inside an action (t-engine's probe reads `a.code` from
  a `rulesBtn` press), and reads what it did from the log, the view or
  `__ct.lastRulesError`. A script's `console.log` shows as the page's
  console (Playwright reports Worker console messages on the page).
- **`__ct` (host)**: `workerDigest()` → a Promise of the running Worker's
  `T.digest()` of its mirror, taken after the jobs posted before it (null
  with no Worker); `digest()` the host table's — equal once those jobs are
  applied (`await` the actions, or `jobs() === 0`); `lastRulesError` (a
  getter) the 📜 dialog's error: a hook's failure ("onAction(): …"), the
  watchdog's "the script took longer than 4 s (stopped)", "the script
  crashed: …" (a fatal: "… outside a hook", "the script changed t.data
  outside a hook", or the message of an error the script let escape — the
  public log then says only "rules disabled — the script crashed"), or an
  Enable's evaluation error ('' after a good Enable); `jobs()` how many
  jobs wait in the host's queue or are in flight (a Worker starting
  counts).
- **`__ct.perf` (host)**: `workerStarts`, `workerStops` (every Worker ended:
  replaced, disabled, crashed, stopped by the watchdog, or by a demotion),
  `workerJobs` (jobs the Worker ran), `lastRulesRoundtripMs` (B12: the host
  posting a job to its patch applied), `lastRulesWorkerMs` (that job's time
  in the Worker, `done.ms`), `lastRulesInitMs` (B15: spawn to `ready`),
  `digestChecks` / `digestMismatches` (a test build compares the host's
  digest with the Worker's every 50 jobs; a mismatch is also a
  console.error), `saves` (saves that reached IndexedDB: a demoted tab's
  count stops).
- **The one-writer rule** (CARDTABLE_TEST): while a Worker runs or starts,
  the host table's `T.apply` throws (only the Worker's patches change the
  table); `_rulesOff` and a Disable run on the host table after the Worker
  is gone. A refused action's re-send (flood control, a full queue) is no
  state change, and is made at once, outside the queue.
  The host table's script runner (`pageHooks`) throws if a hook is called.
- **The watchdog** counts the host page's visible time: 4 s per job (+10 ms
  per item a box setup lays out), 10 s for a Worker to start; hidden or
  frozen (`visibilitychange`, `freeze`/`resume`: CDP
  `Page.setWebLifecycleState`), the clock stops, and it restarts with a 1 s
  grace; a timer that fires over 1 s late gives one more second. A job it
  stops is dropped (the actor's notice "🚫 The rules stopped responding —
  your action was not applied", what it named re-sent), the rules go off
  ("rules disabled — the script took longer than 4 s (stopped)", a toast),
  and the queue goes on. A `_join`, `_leave` or `_name` in flight is not
  dropped: it runs again on the host's table, with the rules off.
- **The wire**: a guest's actions beyond `MAX_QUEUE` (500) waiting jobs
  are refused ("🚫 The table is busy — try again"); `_join` is queued (the
  seat key binds at once, on receipt); `hello`, `snap` and `need` never
  reach the queue; `answer` and `select` do (to the Worker while the rules
  are on).
- **Version skew**: the Worker compares `init.proto` / `init.mv` with its
  own `PROTO`, `MODULE_V` and core's; a mismatch is an `evalError`
  "version mismatch — reload this page", and the host toasts "Card Table
  was updated — reload this page to run rules" (a test can route
  `rules-worker.js` to a copy exporting another `MODULE_V`).
- **The benches** (t-p1-bench, on the 1,000-card table): B12, B14, B15.
  B12 is the round trip of a host move on an otherwise idle host (each
  move paced 60 ms and a frame apart): a `done` that lands behind a
  guest's move, its broadcast and sealing, or a burst, waits for the main
  thread (14–23 ms p95 in the 3B review's probe), while the Worker's own
  share stays under 0.5 ms.
- **Existing suites changed for 3B part 2** (mechanism changes, no check
  dropped): `t-engine.js` (its Probe ran `window.TEST(t)`, a page function,
  from `onButton`; now a press of "run" carries the code, which `onAction`
  runs in the Worker), `h.js` (`enableRules` waits for the asynchronous
  Enable), `parse.js` (also parses `rules-worker.js`), `t-p1-bench.js` (B12,
  B14, B15 added; its 1,000-card table's script now runs in a Worker).

**`t-p3-worker.js`** (spec §3l t-p3-worker items 1–12, and t-p3-space item
5, strict, as a section of its own; Alice hosts, Bob plays, both on a
desktop; `ONLY=3,5` runs some sections, the fixture always). Section 1
enables every template from 🎲 on a four-player table (Carol and Dave
leave after it): turns, dealer, Hold'em to the flop, a Bridge deal (Hold'em
comes first: a Bridge deal leaves every card in the hands, and Hold'em's
New hand wants a deck pile), a CAH round (the white and black decks it
defines are as long as the page's `window.CAH_CARDS`, and the next round
comes from a timer), blank from the 📜 dialog, and the free table (no
Worker); each enabled template's `workerDigest()` equals the host's
`digest()`. Then a cleared table's fixture, made by a script (a deck and
two face-up cards, A and B, whose ids it puts in `t.public`), serves every
other section: strict and `allow` (and a strict `handle` returning true);
atomicity (`handle` throws after `t.move`, `onAction` after `t.flip`); the
`setTimeout` stub; the async guards (a stray `t.say`; a stray `t.data`
write, after which the job that let it loose is dropped and the next one
runs on the free table, and a re-enable keeping the state shows `t.data`
without it; an async `validate`); the page APIs (`document`, `alert`,
`localStorage`, `globalThis.setTimeout`, `sessionStorage`, `fetch`); a syntax
error on Enable (the dialog, "Starting…", a job queued behind a starting
Worker, Disable); the dialog's errors on an iPhone 13 (Phoebe hosts a room
of her own: on screen, inside the dialog, wrapped, clear of the buttons;
`shots/p3-worker-phone-*.png`); 300 seeded actions (200 the host's, 100
Bob's under flood control) under a script that writes `t.data`, `t.public`,
`t.secret`, asks, hints and timers, then the digests and the test build's
own checks; the B14 loop; the watchdog (below); a host reload (one Worker
start, the timer fires after it, no setup line since the mark); module skew
(`rules-worker.js` routed to a copy exporting another `MODULE_V`: on
Enable, then on a host's resume); demotion (a second tab of the host's
context opens the room while 12 `select` jobs — each a 2.5 s `onSelect`
that changes nothing — keep the first tab's queue busy and its save as it
is, so the second resumes one step fresher and wins). Log lines are read
by their time stamp since a mark (`__ct.log()` entries' `ts`), never by a
count over the whole log, which keeps only its newest lines.
**The frozen host page** (item 10): CDP's `Page.setWebLifecycleState
{state: 'frozen'}` takes no effect on a page headless Chromium keeps
visible (its timers run on, no `freeze` event), so the suite checks first
(the page still answers) and then does what a frozen tab does to the page
— hidden, `freeze`, no task runs for 6 s (its main thread stalled: the
Worker's `done` waits), `resume`, visible — and prints which it used. It
also hides the page (visibility only) for 3 s of a 5 s hook, and times a
genuine loop with the page visible (4–5 s, from a MutationObserver on the
toast).

**`t-p3-attack.js`** (spec §3j attacker cases 1, 2, 3, 5, 6, 8 and 9, and
the rules Worker's hardening tried by the author of a pasted script). Alice
hosts; Bob is an honest guest (p3-lib `join`: his incoming bodies are
kept); Mallory is final-lib's raw peer, seated; Eve is a raw peer who only
knocks anonymously, never registered. The "Attack probe" script counts its
hooks in `t.public.c` and runs the code a host press of "run" carries, in
`onAction` (as t-engine's Probe). The texts that must stay private (each
player's prompts, option labels and values, secrets) are random and reach
the Worker as character codes, so a scan can only find them where the
engine put them; Bob's hint names a second board's spaces
(`qzhintmap:a1`), an address nothing else shows. Case 3 goes first (an
unknown action's notice comes once per 10 s per peer). Case 2: 400
`select`s in 4 s at 80 ms of Worker time each — at most 5 a second plus
one second's burst run `onSelect`, and the host's own moves meanwhile apply
in under 2 s (loose bounds: an unthrottled select would leave the Worker
seconds behind). Case 5 scans, at the end, every message Mallory and Eve
received on every channel but `asset` and `act` (what peers send the host:
Mallory's own crafted answers travel there), and Bob's bodies for
everybody else's texts. After each case and every Enable, the Worker's
`workerDigest()` must equal the host's `digest()` (§3f.3). The escapes: a
survey of the Worker's globals (logged), a server outside the table (a
local HTTP server: dynamic `import()` reaching it is README's stated limit;
any other API reaching it, or OPFS keeping a file, fails), the script's
own `postMessage` (a `done`, a `ready` while evaluated), its own
`self.onmessage`, a `MessageEvent` it dispatches to its own Worker (a fake
act of Bob's with the next job's id, and one with an id never posted), a
fake `init`, and three ways to keep the Worker from answering (a capture
listener, `self.close()`, `Atomics.wait` on a shared WebAssembly memory —
`SharedArrayBuffer` is undefined, but such a memory still gives one): each
must go on, or end loudly through the watchdog — `self.close()` now throws
at once, naming itself (the 3B fix-up took it away; this entry checked the
silent hang before: a mechanism change, no check dropped). The Worker's
console reaches the host page's (`QZ…` lines).

**The 3B fix-up's regressions** (the reviews of 3B; SPEC D132–D143):
`core-p3.test.mjs` (RF) replays app.js's Worker lifecycle in Node — a host
table that only applies patches, and a mirror built from its state on each
Enable as `rules-worker.js` builds it (`lifecycle()`): the hints an Enable
clears reach the host; the host keeps the addresses the Worker read (an
explicit one under a newer board, then a new felt, a table resize or a
board under it moved — with no read on the host between two patches); a
pull a script's `handle` made itself, then vetoed, leaves the same member
next; a typed array, a `Map`, a `Date`, `NaN` or a class instance in
`t.data` / `t.public` fails its hook, naming it; `applyStatePatch` throws
on a patch's bad secret key, ask, hint or timer and applies nothing.
**`t-p3b-review.js`** (Alice hosts, Bob and Carol play, Mallory floods):
hints after an Enable; the running rules crashing while new ones start
(the start begins again and ends with the rules on; a top level that never
ends still fails at its start's 10 s); a reconnect while its `_leave`
waits behind slow hooks (online at the end; the suite prints whether the
race happened); an `onLeave` that never ends (the departure is kept);
Mallory's flood during a 3 s hook (the host's queue peaks at what flood
control lets through, ~90 jobs, not her 8,000 actions); a crash's words
(one line for the host, "rules disabled — the script crashed" for
everyone); one evaluation per Enable (a 4.5 s top level enables); a host
reload that meets a skewed `rules-worker.js` (the rules stay on in the
save, and the next reload runs them); an explicit address under a newer
board kept across a new felt.

**The second 3B review's regressions** (SPEC D144; each fails on the app
before it): `core-p3.test.mjs` (RF2) — a `-Infinity`, a `Date`, a `Map` or
a `Uint8Array` whose JSON equals what `t.data` held fails its hook, and the
mirror keeps what the host keeps; `guard()` names a write outside a hook
that JSON can't see (a function into `t.secret`, a `Date` over its text,
`NaN` over `null`) before the next job, which is not blamed; a job's patch,
forged as a script that replaced a built-in could forge it (a line
re-signed by Bob, a chat line moved or reworded or added, a frozen name, a
name bulb of Bob's, a line that isn't one), is refused whole by
`applyStatePatch(patch, out, job)`, while real rots, chats, renames and
departures go in; a patch's `t.data` / `t.public` holding a `Map`, a
`Date`, `NaN` or a cycle throws. The seeded 300-job digest runs (7) and
`lifecycle()` now pass the job too, as app.js does, so every real patch of
those runs passes the speaker check. `t-p3-attack.js`, the protocol
section: a script that replaces `Function.prototype.call` (the host's own
rot still applies as hers, the mirror equal) and one that replaces
`Array.prototype.push` to re-sign the host's chat as Bob's (the host
refuses the patch, the rules go off, nobody's log has the line).
`t-p3b-review.js` section 10: an `onLeave` whose patch the host refuses
(the script defeats its own gate with `RegExp.prototype.test`) ends the
rules and keeps the departure; a rot whose patch is refused is dropped,
its player told, the pile as it was on both screens.

**The third 3B review's regressions** (SPEC D145–D147; each fails on the
app before it): `core-p3.test.mjs` (RF3) — `notJSON` sees a hole, an
`undefined` in an array, a non-enumerable or symbol-keyed property (a
property hung on an array passes since D153, as JSON leaves it out), and a hook that leaves one in
`t.data` fails; a function in `t.data` whose JSON is unchanged fails the
hook that wrote it; a real job's patch, forged as a Worker past its
lockdown could forge it, is refused whole by `applyStatePatch` with the
table as it was — names swapped, a player who never joined, a colour or
`online` changed, a rename to another name, a player without a hand, a
pile without cards, a bad table after a real change (nothing
half-applied), the rules' code or name rewritten, the rules off without a
word, a field of its own in the patch or the rules, the guests' deck
budget spent or grown outside a guest's `addDeck`, `zMax` going back, a
deck over a catalog entry, a box from nowhere, a last setup that is no
box, a 1,001-character line, a line with a field of its own, a frozen name
`undefined`, 400 lines, 50 peeks on the record in a rot, fifty renames in
one, a notice that is no text, an unknown effect, a peek shown in a rot,
an error that isn't one — while a rename, a new player's join, a peek, a
departure, a guest's deck and a Disable go in; the host keeps the asks as
`cleanAsk` leaves them; a patch brings at most the newest lines the log
keeps, and a veto's reason is cut as `t.say`'s; a save with a broken item
or player loads without it, loudly. RF2's `guard()` checks now read its
`{why, detail}`: the script's key path only in `detail`, and (7)'s
catalog check refuses the whole patch where it skipped a bad deck.
`t-p3-attack.js`: the survey checks the allowlist (`navigator` is five
plain values, `scheduler.postTask` throws the `t.schedule` message,
`Notification`, `MessagePort`, `Request`… are gone) and uses each page
API (a value whose every use throws: WebKit's inspector reads `document`
off the global scope, and a getter that threw there took the page down
whenever the Worker logged); the protocol section tries replacing
`Function.prototype.call`, `Array.prototype.push`, `Object.entries`, an
`Object.prototype` getter and setter, the arrays' iterator, the global
`Object` and `JSON.stringify` (each throws a `TypeError`; a script's own
`toString` and its error class's `name` still work), and the host's rot
and chat then apply as hers (replacing the second review's two cases: the
lockdown makes them throw). A new section, **a Worker that lies**, has the
host page rewrite its Worker's next `done` (p3-lib `liar` / `forge`: a
`Worker` subclass in the host's realm — what a script past the lockdown
could post): Alice's and Bob's names swapped, a player who never joined,
a pile without cards, a bad table after the turned stone, a notice that
is no text — each refused, the rules off with the public line only, the
stone as it was on both screens, the forged part nowhere. `t-p3b-review.js`
section 10 now makes its refused patches with `forge` (the lockdown keeps
a script from defeating its own gate); section 11: a `Map` over `{}`, and
a cycle, written from a stray continuation under a key of the script's
private `t.data` ("Alice: Q of hearts") — the host's dialog and toast name
it, Bob's log says only "rules disabled — the script crashed: the script
changed t.data outside a hook", and nothing Bob received names the key.
The lockdown was also checked by hand in WebKit and Firefox (the
reviewers' probes, and one that tries each replacement and lists the
globals left): the same outcome as Chromium, the site's service workers
untouched.

**The fourth 3B review's regressions** (SPEC D148–D153; each fails on the
app before it): `core-p3.test.mjs` (RF4) — no export of `core.js`,
`grid.js` or `templates.js` holds a Set, a Map, a Date or a typed array
(the lockdown can freeze them all), and the lists the engine reads are
frozen arrays; a guest's deck forged in the patch (renamed, a card
renamed, their line reworded, a second line in their name) is refused,
the honest one goes in; a name bulb with a live drag's fields hung on it
reaches the host's queue as the engine writes it, one with no item is
refused; `{t: 'rot', id: 12}` marks "12", and after item "12" goes into a
bag a board move reads whole indexes; `zMax` or a `z` past `Z_MAX`, and
an address that is an object, are refused; a forged `zMax` of `Z_MAX` is
taken, the host's next move tops a card past it, and a reload keeps every
item, renumbered 1…n in their order; a save's unreadable items and
players are said in `resume()`'s toast; a rename to 0 (and 7.5) is taken
by the host, a join named 0 leaves the name empty and the next join fills
it; `t.tell` to undefined, null, 0, an unknown id or an id not at the
table fails the hook alike on both sides ("t.tell: no player …"). The (7)
digest run adds facade calls with odd arguments, renames and joins named
0 or 7, and an action naming item "12" by the number: the host takes every
patch, the digests agree. `t-p3-attack.js`: Mallory renames herself 0
(the rules stay on); the lockdown section's tally takes the keys
`__lookupGetter__` and `__defineSetter__`, and a script that imports
core.js, grid.js and templates.js tries `CTRL`'s `Symbol.replace` and
`exec`, `PID_RE`'s `exec`, pushing to `RULED_ACTIONS` (and adding to it
as a Set), `LOG_CAPS`, `MIGRATE`, a function's property, grid's
`parseAddr` and `BOXES` — each throws a `TypeError`, and `str()` still
strips a control character; the lying Worker adds a name bulb with no item
(refused) and one with a live drag's fields hung on it (taken as the
engine writes it: Bob's screen follows both turns).

## Phase 3 (3C: play — the UI and the terminal of asks, hints and secrets)

What a player sees of their own parts (spec §3g, §3i; D154 onward), and
how a test reads it:

- **The ask panel** is `#ask`, a sheet between `#main` and `#hand-bar`
  (not over the table: the table refits above it). `#ask-prompt` is the
  first ask's prompt (textContent), `#ask-of` "1 of N" (empty for one),
  `#ask-body` its form — `button[data-k]` per option (`.glyphs` when every
  label is one or two characters), `.how` text for a table or hand pick,
  `#ask-ok` (Confirm (k/n) / OK, disabled until the answer is valid),
  `#ask-v` and `button[data-step]` for a number — `#ask-min` (▾) folds it
  (`#ask.min`, the card hidden) to `#ask-chip` ("❓ Rules ask (N)"); a new
  first ask unfolds it. Hidden (`#ask.hidden`) with no ask. An answer
  sent disables the buttons (`#ask.sent`) for `ASK_WAIT_MS` (3 s) or until
  the asks change. A hand pick: `#hand.picking`, picked cards `.hcard.picked`.
- **Picks on the table**: offered items carry `.item.offer`; offered spots
  are violet marks (`circle.o`) on the hint layer. A tap (not a drag) on
  the table while a table pick is open answers, or toasts "Pick one of
  the highlighted pieces" / "… spots" and selects nothing.
- **Hints**: `.item.hint` (dashed cyan), and per board a
  `#table > .hint-layer` (table units, rotated with its board, `z-index`
  99998, `pointer-events: none`) holding an SVG of `circle.hd` (a disc on
  an empty spot) and `circle.hr` (a ring round a piece there) — numbers
  only, no text node. Gone when the hint is null and no pick is open.
- **Select**: with `view.rules.wants` holding `'select'`, a tap on an item
  and the start of a drag each send `{t: 'select', id}` (never for a
  piece whose public view is its back). Strict rules that want selections
  show no action bar on a tap (`#action-bar.hidden`; the item is still
  `.selected`).
- **`#secret`** ("🔒 For you", `#secret-head` toggles `.shut`) in
  `#rules-row`, the column that now holds it above `#rules-btns`
  (`placeSeats` moves the column: `#rules-row`'s `translate`); its text
  is `#secret-text` (pre-wrap, at most 1,000 characters).
- **The 📜 button's title** ends "— strict: only the moves the rules
  allow" while they are; the dialog's `#rules-status` ends "· strict". An
  error while the dialog is open shows in `#rules-err` at once.
- **The terminal**: the snapshot gains `asks` (a hand pick's `count`
  given, 1 by default), `hint`, `secret` and a top-level `strict`; the tab
  pushes `❓ …` (each new ask, as `cliAsk` writes it), `💡 hint: …` and
  `🔒 for you: …` into `msgs`, which both REPLs print with "✉"; `asks` is
  a tab command (the same text in both REPLs); `answer <id> <value>` sends
  `{t: 'answer', id, v: '<text>'}` and the tab converts it (`answerV`, the
  panel's own); errors come back as `error: <id>: answer …`.
- **`t-p3-ui.js`** (spec §3l t-p3-space items 3, 4 and 6 on the screens):
  Alice hosts on a desktop, Bob plays on an iPhone 13 upright, Carol
  watches on one sideways; a strict "UI probe" with `allow`, whose host
  press of "run" carries code its `onAction` runs (asks, secrets). Enable's
  "Starting…" (a top level of 600 ms), the strict titles, a tap's hint
  (discs, rings, where the eye sees them: `__ct.resolve` and p3-lib's
  `screenOf`), a drag's hint mid-drag, every ask form by real taps and
  clicks, a forged unoffered answer, the panel's place on all three
  screens (`askLayout`: two frames on, as painted — inside the viewport,
  above the hand bar, finger-sized buttons, clear of the seat labels, the
  turn cue, the watchers and the pieces asked about; a centred card on the
  desktop), a host reload mid-ask, the secret card, the rules going off
  (asks gone, secret kept) and an error shown in the open dialog.
  Screenshots: `shots/p3-ui-*.png`.
- **`t-p3-cli.js`** (spec §3i): the REPLs' `asks`, `answer` and `select`
  against a fake tab and the Bridge API's `answer` / `select` in both
  languages; then real tabs (Alice on cli.js hosting, Bob on cli.py) under a
  strict probe: the snapshot's parts, the printed hint, asks and secret,
  every answer form through both REPLs, and what isn't offered said with
  nothing sent.
- **`core-p3.test.mjs` (3C)**: a view's asks pass `viewAsk` (each
  well-formed form kept as sent, twenty malformed ones dropped loudly, in a
  snapshot and in a patch), and `pieces.hintSVG` writes numbers and fixed
  classes only, whatever it is handed.
- **`cli-lib.js`**: the bridge suites' helpers (a REPL or a Bridge API
  driver as a child process, playing the tab over HTTP: `repl`, `type`,
  `push`, `sent`, `api`, `viaApi`, `killAll`), moved out of `t-p2-cli.js`.
- **Existing suites changed for 3C part 1** (mechanism changes, no check
  dropped): `t-p2-cli.js` takes its helpers from `cli-lib.js`.

### The demos: chess, go and reversi (3C part 2)

What `t-p3-chess.js`, `t-p3-go.js`, `t-p3-reversi.js` and core-p3 item 11
can rely on (spec §3g "The demos", D160–D166). Each is a script in
`templates.js` — `RULES_TEMPLATES.chess`, `.go9` and `.go19` (both
`goTemplate(n)`, exported: the same text for the same n), `.reversi` — and
a 🎲 entry with `clear: true` (`GAMES` keys `chess`, `go9`, `go19`,
`reversi`; also in the 📜 dialog's `#rules-tpl`). Picking one (app.js
`pickCleared`) confirms "Clear the table and set up {title}? The current
game is discarded." on a table with items or a rules state, then sends
`clear` and `setRules {enabled: true, reset: true}`: a fresh game even when
the same one runs. The 📜 dialog's Enable does the same — with the
dialog's own text — for any text named as one of these four games
(`scriptName`: an edited copy too) that would start afresh: unless the
rules state is that game's and Reset is unticked (D169, D173); and each
one's fresh `setup` first removes every item not of its own box, in one
log line (`clearOthers`), so no other board stays primary under it (a copy
renamed does that unasked, and leaves hand cards). Each script is an IIFE whose hooks come first and its
helpers after; `strict: true`, no `allow`; every move is `handle` doing it
with `t.*` ops and returning `true` (the log says "📜 Rules moved ♙ e2 →
e4", "📜 Rules placed Black stone on D4"…). The pieces on the table are
the position: each hook reads it from `t.find`, so a test can plant a
position by moving pieces (see below). After the game a "♻ New game"
button for each seated player and the host (`id: 'new-<pid>'`, `pid`: a
watcher has none) starts over. What a phone's hidden log would keep is said
on the screen: a check and a go pass are banners (`t.announce`), a declined
or lapsed draw offer a notice to the offerer (`t.tell`).

- **Seats and table** (named seats, set in `setup`, guarded by
  `t.data.ready`): chess `white` (bottom) / `black`, reversi `dark`
  (bottom) / `light`, go `black` (bottom) / `white`; the first two players
  seated (`setSeats` re-seats in seat order, online first) play, a third
  watches. Tables: chess and reversi 1000 × 1360; go 9 × 9 1180 × 1620,
  19 × 19 1340 × 1780 (the board, `(n − 1 + 3) · cell`, plus 40 units at
  each side and 260 by each seat's edge). `public.turn` is the occupant of the
  side to move (null when that seat is empty or the game is over); the
  winner gets 🏆 through `t.win` (`public.winners`, `winSeq`).
- **Chess** (`chess`). Box «Chess»: `board` (840, an 8 × 8 `checker` grid,
  cell 100 from (20, 20), chess labels) and twelve tokens `wK wQ wR wB wN
  wP bK bQ bR bB bN bP` (88 × 88, `shape: 'round'`, `upright: true`, one
  face: White's outlined glyphs ♔♕♖♗♘♙ on `#f5f5f4`, Black's solid ones
  ♚♛♜♝♞ and `♟︎` on `#1c1917`), owned by `seat:white` /
  `seat:black`. `t.data`: `{ready, box, turn: 'w' | 'b', castle (a subset
  of 'KQkq'), ep (a square or null), half (the fifty-move clock), seen
  ({positionKey: count}, since the last capture or pawn move), over (the
  result text, or null), offer ('w' | 'b' | null), promo ({id, at} |
  null)}`. A move is a drag (`move` with `a.to`); `onSelect` hints the
  legal squares of the mover's own piece on their turn (`spaces`; a
  capture square shows as a ring). Refusals (toast "🚫 …", the piece
  snaps back): "It's not your turn", "That's not your piece", "Only the
  two players move the pieces", "The bishop can't move there" (any piece's
  name), "That would leave your king in check", "You're in check — that
  move doesn't get you out of it", "You can't castle out of check" /
  "through check" / "into check" / "on that side any more: the king or
  that rook has moved" / ": there are pieces in the way", "Choose what
  your pawn becomes first", "Drop the piece on a square of the board",
  "The game is over — press New game for another"; any other action:
  strict's "Not a move in this game". A drop on its own square is a no-op
  (handled, no toast). Castling is the king's two-square drag (the rook
  follows); en passant takes the pawn passed; a pawn on the last rank asks
  its player `{id: 'promo', prompt: 'Promote your pawn to', options:
  [{label: the side's glyph, value: 'Q' | 'R' | 'B' | 'N'}]}` (index 3 =
  the knight; the CLI's `answer promo 3`) and the turn waits for the
  answer (the opponent's moves meanwhile: "Black is choosing what the pawn
  becomes"). Buttons per seated side: `draw-w` / `draw-b` ("½ Offer a draw",
  while no offer is pending and the other seat is taken: asks the other
  player `{id: 'draw', options: ['Accept', 'Decline']}`; any move lets it
  lapse, "The draw offer lapses", and the offerer is told "Your draw offer
  lapses: White moved"; the offerer's own move withdraws it, "White moved:
  the draw offer is withdrawn" (the log, and a notice to the other player),
  the offerer told "Your move withdrew your draw offer"; a decline tells
  them "Black declines your draw offer") and `resign-w` / `resign-b` ("🏳
  Resign": asks `{id: 'resign', options: ['Resign', 'Keep playing']}`
  first). Endings, announced (and `t.data.over`): "Checkmate — White
  wins" (🏆), "Stalemate — a draw", "Neither side can checkmate any more —
  a draw", "Fifty moves without a capture or a pawn move — a draw", "The
  same position for the third time — a draw", "Draw agreed", "White
  resigns — Black wins". A check is announced: "White is in check".
  Dead positions: no pawn, rook or queen, and at most one minor piece or
  only bishops all on one colour of square (K+B v K+B on opposite colours
  and K+N v K+N play on). Repetition keys count the en-passant square only
  while a capture there is legal. Handy sequences: fool's mate `f2f3 e7e5
  g2g4 d8h4`; Loyd's stalemate `e2e3 a7a5 d1h5 a8a6 h5a5 h7h5 h2h4 a6h6
  a5c7 f7f6 c7d7 e8f7 d7b7 d8d3 b7b8 d3h7 b8c8 f7g6 c8e6`; threefold
  `g1f3 g8f6 f3g1 f6g8` twice; black promotes after `a2a3 h7h5 a3a4 h5h4
  g2g4 h4g3` (en passant) `b2b3 g3h2 b3b4 h2g1`.
- **Go** (`go9`, `go19`). Box «Go 9 × 9» / «Go 19 × 19»: `board` (a point
  grid, `draw: 'lines'`, go labels, the star points as `marks`, cell 100 or
  60, margin 1.5 cells) and tokens `b` / `w` («Black stone» / «White
  stone», 0.94 cell, round); one supply of each, owned by `seat:black` /
  `seat:white` (the bowls, in the bottom-right and top-left corners). A
  move is a `take` from your own bowl with `a.to`; the stone is spawned
  locked and ownerless (a drag of it: "A stone stays where it is played").
  `t.data`: `{ready, box, turn: 'b' | 'w', prev (the position before the
  last move, N × N of '.', 'b', 'w': ko), passes, over}`. Refusals: "It's
  not your turn", "Play from your own bowl", "That point is taken",
  "Suicide: that stone would have no liberty", "Ko: play elsewhere before
  you take back", "Put the stone on a point of the board", "Only the two
  players play stones". Captured stones go by one `t.remove(ids)`: one log
  line however many ("📜 Rules removed 2 pieces: A1, B1"; B16's 30, D167).
  Buttons: `pass` (the player to move, until two passes in a row; announced
  "Black passes — White to play"; after two, "Both players passed — press
  Count to score, or play on"), `count-b` / `count-w` (after two passes in a row:
  area scoring, komi 6.5: "Black 5 – White 8.5 (komi 6.5): White wins by
  3.5", 🏆), `resign-b` / `resign-w` (a `resign` ask first). A play after
  two passes resumes the game (passes back to 0). `onSelect` on a stone
  hints its group (`items`) and its liberties (`spaces`). No dead-stone
  marking. B13: `__ct.perf.lastRulesWorkerMs` at stone #300 measured
  0.3–0.9 ms while building these.
- **Reversi** (`reversi`). Box «Reversi»: `board` (840, `draw: 'cells'`,
  green, chess labels) and `disc` (84, round, faces `[{color: '#1c1917',
  name: 'Dark disc'}, {color: '#f5f5f4', name: 'Light disc'}]`: face 0
  dark, 1 light); one supply per seat with its face (`f`), owned by
  `seat:dark` / `seat:light`. `t.data`: `{ready, box, turn: 0 | 1, over}`.
  Start: light on d4 and e5, dark on d5 and e4, dark to move. A move is a
  `take` from your own pile with `a.to`; the disc is spawned locked, and
  the bracketed discs turned by one `t.setFace(ids, f)` ("📜 Rules turned
  Light disc to Dark disc on d4"; two or more: "turned 3 pieces from Light
  disc to Dark disc: c4, d4, e4"). Refusals: "A disc must
  outflank: close a line of the other colour", "That square is taken",
  "Play from your own pile", "It's not your turn". A side with no move
  passes: the announcement "Light has no move and passes — Dark plays
  again"; with neither able to move: "Dark 43 – Light 21: Dark wins" (🏆;
  equal counts: "…: a draw"). `public.badges` hold each seated player's
  count ("30 discs"); `onSelect` on your own pile on your turn hints the
  legal squares.
- **Planting a position.** In Node, drive the table with `T.apply` (the
  in-page path, as `final-lib.js` does): `T.job` runs the Worker's
  `guard()` first, which refuses a `t.data` changed between jobs. Then
  `T.api.remove` / `T.api.spawn(box + '/wK', {at: 'e1', owner:
  'seat:white'})` and `Object.assign(T.state.rules.data, {turn, castle,
  ep, half, seen})` set any position, and the next move runs `endTurn` on
  it (e.g. a capture leaving K+B v K). In a browser, wrap the template so a
  host-only button plants it inside a hook: `(() => { const r =
  <template>; return {...r, buttons: (t) => [...r.buttons(t), {id:
  'plant', label: 'Plant', pid: t.hostId}], onButton(t, id, p) { if (id
  === 'plant') { … t.data.box … } else r.onButton(t, id, p); }}; })()` —
  the same lockdown as any script, so plain `t.*` calls only.
- **`core-p3.test.mjs` (3C, the demos' box fields)**: `upright` kept only
  when true (a box without it is unchanged), a non-boolean refused, an
  upright type's shown label and text carrying `.uptext` (a back never); a
  face's `name` used by `pieceName` / `faceLabel` and never drawn.
- **Existing suites changed for 3C part 2** (mechanism changes, no check
  dropped): `t-fun-games.js` expects the four new games in the strip's
  order (`…bridge,chess,go9,go19,reversi,draughts…`) and 13 entries in the
  🎲 dialog.

### The go and reversi suites (3C tests)

`t-p3-go.js` and `t-p3-reversi.js` (spec §3l): Alice hosts on a desktop,
Bob plays on an iPhone 13 (upright; sideways for reversi's last game), and
Alice picks each game from 🎲. Each suite carries its own **referee**,
written from the rules of the game (go: no suicide, simple positional ko,
area scoring with komi 6.5; reversi: a disc must outflank, every closed
line turns, a side with no move passes, the most discs win), and every
expectation — legality, captures, flips, whose turn, the score — is the
referee's, never the template's. After each move both screens must hold the
referee's position, in their views and as drawn: every stone or disc
centred on its spot (≤ 3 px, through a probe in `#table`) in its colour
(the luminance of its face). A refusal must toast "🚫 …" on the mover's
screen and change nothing on either. Which page plays which side is read
from the seats (go) or from the pile showing the dark face (reversi).

- **`t-p3-go.js`** (in the serial batch: B13 is a timing budget). 9 × 9 by
  real drags out of each player's own bowl (mouse; CDP touches on the
  phone): a stone placed on its point, a taken point, a play out of turn,
  a single capture, suicide, a two-stone group capture, a ko refused and
  then allowed after a move elsewhere by each, Pass and Pass (Count is
  offered only then), Count's score and 🏆. The group capture also checks
  the task's "a capture of N stones is ONE log line" (D167). 19 × 19
  through `__ct.act` as both players (the spec says so): 361 alternating
  legal placements (`fill19`: White's 30-stone group taken by Black's L3 at
  #61, B16, one log line; each side then fills its half but its eyes; #300
  is White's C19 taking the stone Black threw in at B19: B13 reads
  `__ct.perf.lastRulesWorkerMs`, `done.ms`, after checking `workerJobs`
  moved by exactly one), then both screens agree stone for stone, and B17:
  Carol joins with the RTC hook keeping bodies, and her snapshot's UTF-8
  size, as received and carried on to 361 stones, is at most 70,000 bytes.
  Bob's moves are paced to at most 15 a second (a guest's flood limit is 20).
- **`t-p3-reversi.js`**: the board (8 × 8 cells, green), the two-faced
  disc and a pile per seat with its own face; the start (light d4 e5, dark
  d5 e4, Dark to move); refused placements (outflanks nothing, taken, out
  of turn); the line `d3 c3 b3 b2 f5 a3 a1 c1`, where a1 turns b2 c3 d4 and
  after c1 Dark has no move: the pass announced on both screens and Light
  plays again; then a near-end position (`NEAR_END`, from a legal game:
  six squares empty, Dark to play) planted by the template wrapped with a
  host-only Plant button (`planter`, the "Planting a position" recipe
  above) and played out on Bob's phone held sideways — a5 closes four lines
  at once — to a full board: the count announced, `t.win`, 🏆 on the winner.
- **`stones-lib.js`**: their shared helpers — `pickGame` (🎲, accepting the
  confirm), `playing` (the 🎲 entry marked as playing), `record` / `mark` /
  `seen` / `waitSeen` (every toast and banner a page shows, as they replace
  each other), `place` (a drag out of a supply onto an address, paced as a
  hand moves and held still before the release: a finger let go mid-flick
  leaves Chrome flinging, and it then spends the next tap on stopping the
  fling, with no click), `drawn` (each piece on a spot as drawn: its offset
  from the spot, its face's luminance), `buttons` / `press` (the rules'
  buttons), `seatTexts`, `newLines` (the log lines a move wrote) and
  `everywhere` (a view condition on every page).
- Screenshots: `shots/p3-go9-*.png`, `shots/p3-go19-*.png`, `shots/p3-rev-*.png`.

### The chess suites (3C tests)

Every expectation is the laws of chess (FIDE) or the spec's (§3g "Draws",
§3l); the template is only driven.

- **`t-p3-chess.js`** (spec §3l t-p3-chess): Alice hosts on a desktop (the
  mouse, reduced motion), Bob plays on an iPhone 13 upright (CDP touches,
  motion on), Carol joins on one held sideways (motion on) and watches;
  Alice picks Chess from 🎲, and which page is White is read from the seats.
  Every move a player makes is a real drag of the piece from its drawn
  centre to the square's, held still 120 ms before the release (a finger
  let go mid-flick leaves Chrome flinging, and its next tap only stops the
  fling: no click); a move counts once the piece stands there in every
  view. A refusal must toast "🚫 …" on the mover's screen (an init script
  records every toast, banner and confetti burst, as they replace each
  other), the piece drawn back on its square on every screen (≤ 3 px), and
  the board and the turn as they were. Five games, the first picked from
  🎲, each other started by "♻ New game": (1) the start position on both screens, each player's own edge at
  the bottom, the 📜 title strict, a tap's hint (f3, h3 for the g1 knight;
  f6, h6 on the phone); off turn, an opponent's piece (a drag of it pans
  the view and sends nothing, §3g; a forged `move` is refused), e2 → e4 and
  e7 → e5 on both screens and in both logs, a blocked path (Ra1 → a4), a
  pinned pawn (d2 → d4 under Bb4); O-O and O-O-O with their rooks; Carol
  joins as a watcher (no seat, no buttons, her drag sends nothing, a forged
  move is refused; after the draw she has no "New game", and her forged
  press of White's is refused); a draw offer is
  Black's ask, lapses when White moves, then Black's offer accepted on the
  desktop: a draw, no 🏆; (2) castling through check (Bh3 covers f1) and
  out of check (Bb4+) refused, then Black resigns (after the confirming
  ask): 🏆 for White; (3) fool's mate by drag: "Checkmate", 🏆 for Black,
  a confetti burst on Bob's and Carol's screens, the winner's bigger; (4)
  `a3 h5 a4 h4 g4`, h4 × g3 en passant, then h2 × g1: the promotion ask on
  Bob's phone alone (♛ ♜ ♝ ♞), any move refused while it waits, a host
  reload (the ask still on Bob's screen from the reloaded host's
  snapshot), ♞ tapped: a black knight on g1; Bob's forged `del` gets "🚫
  Not a move in this game"; the knights out and back twice: the draw by
  repetition at the 8th half-move, not the 7th; (5) Loyd's stalemate, its
  first 18 half-moves sent through `__ct.act` (set-up) and Qc8 → e6 by
  drag: "Stalemate", a draw, no 🏆; at the end the Worker's digest equals
  the host's. Screenshots: `shots/p3-chess-*.png`.
- **`core-p3.test.mjs` (11)**: the chess template on a Worker-like mirror
  (`T.job`, `guard()` included) whose structured-cloned patches a host
  table applies with the job (`chessGame`); a host-only "plant" press,
  wrapped around the template, lays out a position from inside a hook
  (`globalThis.__chessPlant`). Threefold repetition (the knights out and
  back twice: the 8th half-move, not the 7th; a rook out and back loses a
  castling right, so the same pieces are another position; a position
  where en passant is possible is another position; a double step no pawn
  can take changes nothing, FIDE 9.2.2), the fifty-move rule (kings walking
  cycles of 7 and 8 squares, so nothing repeats: the 100th half-move, not
  the 99th; a pawn move restarts the count), and each insufficient-material
  case of §3g reached by a capture (K v K, K+B v K, K+N v K either way
  round, K+B v K+B on dark and on light squares) end the game as an
  announced draw with no winner, the next move refused; K+B v K+B on
  opposite colours plays on.

### Play on the screens and the terminal (3C tests)

Written from spec §3g, §3i, §3l and D154–D159 by a test author of their
own, beside the implementer's `t-p3-ui.js` and `t-p3-cli.js`.

- **`t-p3-space.js`, its 3C sections** (spec §3l t-p3-space items 3, 4, 6
  and 9), after the 3A ones, with the same players (Alice on a desktop,
  Bob on an iPhone 13 upright, Carol on one held sideways, Mallory raw):
  Alice clears the table and enables the strict "Play test" (`PLAY`: an
  8 × 8 board, five stones, a glue stone on g2, a deck; `onSelect` hints
  the piece and the squares round it; `handle` keeps the glue stone where
  it is (`true`) and vetoes a move to h8; `onAnswer` records each answer
  in `t.public.ans`; a host press of "run" carries the code that makes the
  asks and the secret) from the 📜 dialog with Reset ticked. Item 3: a
  tap's `select` (p3-lib's `actTap`), the hint drawn on that screen alone
  (`hintShown`: the outlined piece, each mark within 2 px of its square's
  centre by spec §2a's geometry, a layer of its own of `svg`/`circle`
  with numbers only), every body scanned (`partsIn`: a recursive scan for
  `hint`, `ask` and `sec`): Mallory's carry her own hint alone, Bob's his,
  Carol's none; a refused card play and a vetoed drop keep the hint, a
  played move clears it. Item 9: a drag of the glue stone on each phone,
  every frame traced (`traceItem`): drawn where the finger let go, then
  back on g2 with the first patch naming it (≤ 200 ms after it, < 1.2 s
  after the drop: not the 1.5 s landing hold). Item 6: the 🔒 card's
  text exactly, markup as text, `pre-wrap`; no other screen, no other body.
  Item 4: five forms pending at once ("1 of 5"), answered by mouse on the
  desktop and by taps on the phone (`fiveForms`), each value against
  §3c's table; markup in a prompt and labels shown as text (sideways); the
  panel's place on all three screens (`layoutOf`, two frames on: inside
  the viewport, clear of the table area, the turn cue — shown by a turn
  given with the ask —, the watchers' box — Carol watching — and every
  seat label; above the hand bar with 44 px buttons on the phones; a
  centred card ≤ 720 px on the desktop); fifteen forged answers of every
  form and Mallory's answer to Bob's ask refused ("🚫 That answer wasn't
  offered", 250 ms apart: notices are flood-limited), no hook run; a host
  reload mid-ask: both prompts back, Bob's hint gone (never saved), his
  secret kept (his card folded first: upright, it stands over the board's
  near rows). Toasts are recorded with stones-lib's `record`.
  Screenshots: `shots/p3-play-*.png`.
- **`t-p3-term.js`** (spec §3i, D158): Bob is a bot on cli.js and Carol a
  bot on cli.py, each a REPL started with `--as` whose printed URL opens
  that player's tab (which records what it sends, and whose pushes to the
  bridge the test reads: `snaps`); both are asked the same questions, so
  the two REPLs are compared line for line. The snapshot (labels only, a
  hand pick's count — 1 when left out —, hint, the whole secret, `strict`
  at the top with `rules` still the name; the rules off: no asks, strict
  false, the secret kept; on again: the asks back), new asks printed
  unprompted, `asks`, `answer` in every form and spelling (an option's
  number or label in any case, an id, a spot in display or qualified
  form, hand indices, a negative number), every wrong answer said in both
  with no `answer` leaving the tab (each error found by the ask it names),
  `select` and its printed hint, the printed secret, no control character
  on the terminal; then the Bridge API in both languages with the same
  tabs re-paired (`select`, `answer` with a number, a list, a label and a
  spot, `place`; `snaps` keeps only what goes to the tab's bridge of the
  moment, so a push still on its way to the REPL just killed never passes
  for the table the re-paired tab has yet to receive — a race a loaded run
  showed in 4A). Since the 3C review it also checks an ask whose labels
  are digits (`answer dig 3` is the option labelled 3; `answer dig 0`,
  with no such label, index 0) and a `select` with no rules running: said
  as `error: select …: the rules take no selections` in both, never sent.

### The 3C review's fix-ups

- **`t-p3c-review.js`** (D167–D175): Alice on a desktop, Bob on an iPhone
  13 (upright, then sideways). (1) Chess from 🎲, then Go 9 × 9 from the
  📜 dialog: Enable asks "Clear the table and set up Go 9 × 9?"; declined,
  nothing changes and the dialog stays open; accepted, the go board alone
  and a stone on E5. (2) Go 19 × 19: Bob's bowl is 16 px wide; a touch
  press 12 px off its centre takes a stone (played on K10, no pan); one
  85 px away pans. (3) The ask panel: ▾ beside the rows (never a row of its
  own); a question asked again under the same id with its buttons working
  within 2.5 s (they waited 3 s before). (4) Sideways, three cards in
  hand, an ask open and a six-line `t.secret`: the 🔒 card's head below the
  toolbar, a tap there reaching it, folding and opening the card. (5) Over
  that card game (a pile, three cards in Bob's hand), chess's text with a
  comment line added asks first too: declined, nothing changes; accepted,
  "cleared the table (… 3 cards from hands)", chess alone, and the edited
  text is what Bob's 📜 dialog shows running; Reset ticked on the running
  chess asks again, and accepted clears the table for a fresh game. (6)
  Playwright's iPhone 13 sideways (750 × 342, the browser's bars shown),
  four buttons on two rows, a three-line secret, an ask, three cards: the
  🔒 card's frame holds its head (below the toolbar, a tap reaching it,
  nothing of the card under its frame), the buttons stay between the card
  and the ask panel with their first row whole, a touch swipe scrolls
  "Show my hand" into view and a tap presses it; the head folds the card.
  Screenshots: `shots/p3c-*.png` (`p3c-squeeze-sideways-phone`).
- **`core-p3.test.mjs`**: (5) one call given a list (`t.remove(ids)`,
  `t.setFace(ids, f)`) is one line from two items on, standing apart from
  the lines around it; a merged turn line names its two faces when they
  are the same for all. (RF4, D168) an addDeck patch that adds a deck adds
  the player's own and says so once in their name — a rewritten deck with
  the line dropped, or a Rules line in its place, is refused; the same
  deck added twice in a row writes its line twice (never folded). (3C
  review) the demos over another game (go over chess and a deck, chess over
  go, reversi over chess: only the new game's items, one log line, its
  moves played), a card pile under go's and reversi's rules (move, flip,
  shuffle, del: "Not a move in this game", the rules on), a two-stone
  capture one line, reversi's flips one line, and the cues: check
  announced, a declined and a lapsed draw offer told, an offer withdrawn
  by the offerer's own move told to both (never "White moved" to White as
  if the opponent had), the promotion's reason, go's pass announced, no
  third Pass, "New game" per player.
- **`t-p3-attack.js`**: D148's import case also calls `compile` on `CTRL`
  and `PID_RE` and checks their sources unchanged and that `PID_RE`
  refuses "not a pid" (a TypeError alone proved nothing: a frozen regex is
  rewritten before compile throws).
- **Mechanism change**: `t-p3-chess.js` section 4 — the watcher has no
  "New game" (D163: a seated player or the host), so the check that her
  press starts nothing presses, through `__ct.act`, White's own button
  (refused: "🚫 That button is not available to you right now").

## Phase 4 (4A: game boxes — the engine)

- **`core-p4.test.mjs`** (Node, §4l's core list but item 3, `group`, which
  is 4B's): the authoring format through `boxOfDef` and `checkTransportBox`,
  PublicBox, the setup grammar's refusals, every entry kind laid out, "#k",
  the checks before any op (a refusal leaves the table's digest, its log and
  `lastSetup` as they were), ids kept or re-minted, the guest box's shuffle,
  export → import round trips (a varied position in a fresh room, ids
  included; chess and Hold'em mid-game, then played on), deduplication,
  `MIGRATE[4]` and Reset after a save/load, `setRules.state`'s gates (§4j
  attacker case 11), addBox's budget and a forged built-in (case 10),
  `store.ingestBox`, the Worker path and forged patches of box jobs, and
  `t.boxes` / `t.box` / `t.layout`.
  - **`room(pid, name, players, prefix)`** runs a table as app.js does: the
    host table `H` (whose runner only answers the rules view), a mirror `M`
    built from the host's state at each Enable (as rules-worker.js does),
    and `job(p, a)` routing each job to whichever runs it, the mirror's
    patch checked and taken by the host — then the host's `enable` effect
    queues the box's setRules at once, as app.js's `enableBox` does. It
    returns `{fx, notes, toasts, lines, error?, enabled?}`; `add(p, box)`
    also gives the `id` of the `added` effect. `prefix` keeps two rooms'
    minted ids apart (a fresh room never mints the ids an export carries).
  - **`gameDef(o)`** is an ingested test box (images as asset ids) using
    every entry kind; `position(R)` and `differ(a, b)` compare two rooms'
    private states by seat ("#k"), positions within 0.5.
  - **The test author's sections, (1′) to (W′)**, written apart from the
    implementation, every expectation read off the spec: §4l items 1, 2, 4,
    5 and 6 again, and §4f's Worker contract.
    - (1′) TABLETOP §4's own example as a box, field by field; the authoring
      format cleaned (a board's structure on its piece, `img` on a piece and
      a back, the backs' defaults from their first user, each kind's
      defaults, `h` from `w`, decks); what it refuses (images, backs, decks,
      `"at": "seat"` outside forEachSeat); the caps at their bounds (rules
      200,000 chars, rulesState 4e6 of JSON, meta 8 KB); `src`, `by` and
      unknown fields dropped; rulesState's entries through §3a's gates when
      set up with rules (D177: each drop a `console.error`, one toast per
      kind; a watcher's raw pid kept).
    - (2′) Every entry kind laid out where its `Where` says, against §2a's
      grid and seat geometry computed in the test (`chessXY`, `hexXY`,
      `rimXY`); forEachSeat over named seats (an empty one too) and
      automatic seats; "#k" with four seats declared out of clockwise
      order; `{board, at}` on the first board of its type; the 3,000-item
      cap at its bound and MAX_ITEMS; refusals "before any op" compared
      as the whole state (`canon(T.state)`), the table shape, seats and
      hands included; ids kept, re-minted with the remap table, the remap
      put into the rules' state, a deck id re-minted at registration; the
      guest box's shuffle (face-down deck and pile entries only), as its
      Reset's default, and the host's own.
    - (4′) A varied position (moves, a shuffle, draws, a pull, an unlocked
      board, a free piece, an owner by player, a hidden stack, t.data /
      t.public / t.secret / an ask by player) exported and set up in a
      fresh room and in the same table after a clear (`privateOf`,
      `unlike`); what an export can't map (a watcher: an ownerless item,
      the raw pid left in t.data, the secret dropped with its toast); a
      position using three boxes, compared by type content
      (`typeContent`: D185 renames a clashing type id); a piece a table
      change left off its spot's centre (D119) keeping its address.
    - (5′) Deduplication against key order, another asked id, another
      deck id; six one-field changes; t.newBox against addBox's box and
      its own; the built-in draughts loaded, then added in the authoring
      format (`asAuthoring`).
    - (6′) MIGRATE[4] as a unit; a v4 save (a duplicate box and an item on
      it) resumed: records untouched, Reset without re-enabling; a v5 save
      resumed: Reset lays out lastSetup again and restarts the box's rules;
      Disable keeps rules.box; the box's code enabled from 📜 sets none;
      `reset {box}`; a guest box's Reset still shuffled after a reload.
    - (W′) Through `room()`: every honest box job with a script running —
      addBox (host, guest, duplicate), setup clearing or kept with its
      rules and a remap, a setup refused in the mirror, t.newBox and
      t.layout in hooks, loadBox, reset with and without the box's rules —
      taken, digests agreeing; and sixteen forged patches (rules.box,
      lastSetup, box records, `enable` effects outside the job that may
      carry them) refused whole.
    - Helpers: `hostTable({seed, players, prefix, ids, me, name})` (a
      seeded host table, rules in-page; `ids` feeds its id source first),
      `act(T, p, a)` (applied and drained as the app does, an `enable`
      followed by the box's setRules), `ranked(T)` (the seated players
      clockwise from the bottom), `holderOf(T, seatId)`, `reload(T, seed,
      mutate)` (a save resumed in a fresh table), `tide(o)` (the
      "Tidewater" box: every entry kind, two boards, two named seats).
- **`t-p4-wire.js`** (E2E, desktop): the same engine over the wire, through
  `__ct.act` (the 📦 dialog is 4A part 2's): a guest's TransportBox (data
  URL images, a deck with an image) registered only, its PublicBox and
  pulled image on the guest's screen; the host's setup with rules (the
  guest's deck shuffled, "@#1" mapped, the Worker's digest the host's); a
  guest's setup and reset refused; the host's own addBox resolving its id;
  Reset with the box's rules running, and after a host reload; a guest box
  over the budget refused on receipt.
- **`__ct` (Phase 4A, host)**: `hostState()` is a copy of the host's state
  (its seat keys left out) — the catalog's boxes with their setups, rules
  and rulesState, `boxSrc`, `lastSetup`, `rules.box`. On the host,
  `act({t: 'addBox', box})` resolves `{ok, error?, id}`: `id` is the box
  the catalog now holds for it (the same one when it was there already).
- **Mechanism changes** to existing suites (Phase 4: PROTO 5, STATE_V 5,
  `MIGRATE[4]`, §10.1's ruled `addBox`, §4a's address forms): core-p1's
  migrate chain ends with `MIGRATE[4]`; core-p2's PROTO and STATE_V checks
  say 5, and its cleanBox fuzz oracle accepts a `Where` that is an address
  on one of the box's boards (read with grid.js's `parseAddr`), as §4a now
  allows; core-p3's v4 save lifts on to v5 and its §10.1 ruled-action list
  has `addBox`.

### The 📦 dialog, files and the terminal (4A part 2)

- **`fixtures/`** (made by `node fixtures/make-boxes.js`, which draws the
  images with a canvas; run it again after changing it, and commit what it
  writes — original content): **`harbor/`** "Harbor Run", a `game.json` and
  its 6 PNGs (a board image, two boats with a transparent ground, a crate,
  two tide cards), a deck with a text card, a die, hidden crates;
  **`harbor.zip`** the same game in one top-level folder (`harbor-run/`);
  **`beacon/`** "Beacon Watch", a box with rules (`rules.js`, a "🔥 Keep
  watch" button counting in `t.data.watches`) and a rules state, no images.
- **`zip-lib.js`**: `zip(entries)` writes a zip — each entry `{name, data,
  store?, declared?}`, deflated unless `store`, its headers declaring
  `declared` bytes unzipped (the truth by default), names as given (`../x`,
  `/x`); `photoPNG(w, h)` a big opaque "photograph" PNG (a gradient with
  grain in 4 × 4 blocks: 4,000 × 3,000 is 3.5 MB); `game(img)` the tiny
  game.json of the hostile zips; and **`HOSTILE`**, §4j's attacker cases as
  zips: `bomb()` (map.png, 100 MB of zeros declared honestly, 98 KB
  zipped), `liar()` (the same, its directory saying 1 KB), `slip()`
  (`../../evil.png`, `/abs.png`), `svg()` (an SVG with a script named
  map.png), `missing()` (game.json names `gone.png`), `huge()` (a
  30,000 × 30,000 PNG header). (A noise PNG no encoder shrinks is
  assets-lib's `png(w, h, {seed})`.)
- **`t-p4-boxes.js`** (E2E: Alice hosts on a desktop, Bob on an iPhone 13
  upright, Carol watches on one sideways, Mallory is a raw peer; every
  upload a file picked in the dialog, every Set up, Reset and Export a
  press): game.json and PNGs, then the same zip (the same box: an image
  re-encodes to the same bytes); JSZip fetched only for the zip, and its
  build pinned (`_data.uncompressedSize`, `internalStream`,
  `unsafeOriginalName`); every hostile zip, bad JSON, a missing plain file
  and a refused field, each named inline and in a toast; Mallory's cases 5,
  6, 10 and 11; a guest's box with rules (by Bob, 📜 on every screen) set up
  through the setup confirm and the trust dialog (without rules, Cancel,
  Enable); Reset, and after a host reload; export → clear → re-import (the
  same position everywhere — box and deck ids read as their names: this
  room's catalog keeps the first box — and case 7: a kept game's state in
  no guest's messages); a guest box shuffled, the confirm naming him, and
  the budget it shares with decks; a 4,000 × 3,000 PNG board and a 2,048 ×
  2,048 noise board stepped down (quality, then size), and the Safari
  fallback (`toDataURL('image/webp')` stubbed to answer PNG: JPEG for the
  opaque, PNG for the transparent); a built-in box twice, one entry; and
  chess and Hold'em exported mid-game and resumed in a fresh room whose
  host is on a phone. Helpers: `upload(p, files, now)` (picks files in
  page p's 📦 and waits for the outcome: `{progress, err, msg, ask}`),
  `asked(p, kind)` / `reply(p, value, checks)` (the `#box-ask` dialog:
  `data-kind` setup, reset or trust), `settle(p)` (the queue idle for
  300 ms: a press's action reaches it a task later), `position(state)` (a
  host state comparable across a re-import). Screenshots:
  `shots/p4-boxes-*.png`.
- **`t-p4-cli.js`** (cli.js and cli.py in parity): `boxes` listed in the
  same words, `setup <box> [--keep] [--rules]` and `reset` sent as their
  commands, the help, the Bridge API's `setup()` and `reset()`; then real
  tabs: the snapshot's `boxes` and `lastSetup` (the host's alone), a setup
  by name, a reset, a guest's refused, an unknown box, and `--rules`
  waiting for the trust dialog on the host's page.
- **`t-p4-bench.js`** (in the serial batch): B20, a zip of 64 photographs
  (1,200 × 900 JPEGs drawn in the page, 20.5 MB) imported from 📦 on the
  desktop within 10 s, its progress said file by file; B21, that box set up
  (64 items) and exported with its images within 5 s.
- **The dialog** (`#box-dialog`): `.box-row[data-box=<id>]` rows with
  `[data-act=setup]` / `[data-act=reset]` buttons (the host's), the
  built-in list `#box-builtins [data-builtin=<key>]`, `#box-up` (it clicks
  the hidden `#box-files`), `#box-now` ("Set up now", the host's),
  `#box-progress`, `#box-err` (an upload's failure, "Couldn't add the game:
  …"; a guest's refusal from the host, "🚫 Box rejected: …"), `#box-msg` (a
  Set up or Reset that failed), `#box-x-rules`, `#box-x-state`, `#box-x-go`
  and `#box-x-msg` ("Saved Harbor Run.zip"). The questions are one dialog,
  `#box-ask[data-kind]`: `#box-ask-title`, the lines and checkboxes
  (`[data-c=rules]`, `[data-c=shuffle]`) of `#box-ask-body`, the buttons of
  `#box-ask-btns` (values `cancel` / `ok`; the trust dialog's `enable`,
  `without`, `cancel`, left to right — no `without` for a box with no
  layout; the dialog stands on its bottom edge, so its last button keeps
  one spot). Every question's buttons are disabled
  for half a second once it shows (`ASK_ARM_MS`): Playwright's `click` and
  `tap` wait for them; a test that dispatches its own click must wait too.
- **Mechanism changes**: `run-all.sh`'s serial batch adds `t-p4-bench`;
  `t-p3-term.js` keeps only the snapshots a tab sends to its bridge of the
  moment (see its entry). No assertion changed.

### The 4A suites written from the spec (independent of the implementation)

`t-p4-box-ui.js`, `t-p4-box-files.js` and `t-p4-box-bench.js` check §4l's
t-p4-boxes items 1–7 and 9–12 and §4j's attacker cases 1–7 and 9–12 (case 8,
`group`, is 4B's) against the spec and its decisions, beside the
implementer's t-p4-boxes.js. Every upload is files picked in the 📦
dialog's file input (`setInputFiles`), every Set up, Reset, Export and
answer a press of the dialog's own buttons; nothing they test goes through
`__ct.act`.

- **`fixtures/lantern/`** (made by `node fixtures/make-lantern.js`, which
  draws its 6 PNGs with a canvas in Chromium — original content — and writes
  the rest; commit what it writes): "Lantern Isles", a `game.json` (a board
  with a grid, a lantern with two faces on a transparent ground, a cache
  hidden under a back, a die, a deck of two image cards and four text
  cards; a setup using `id`, `forEachSeat`, an address, a `pile` and
  `hands` by "#k"), its 6 PNGs (the board 1,400 px, the cache 700 px: drawn
  at 560), and `rules.js` ("Lantern Watch": a 🏮 button counting in
  `t.data.lit`, the script finding its own box id with `t.boxes()`);
  **`fixtures/lantern.zip`**: the same files in one folder.
- **`p4-lib.js`**: `zip(entries)` (each `{name, data, store?, declared?,
  dir?}`: a directory may claim any size, names are written as given) and
  `unzip(buf)` (reads an exported file); `png(w, h, fill)`, `pixels`,
  `photo(w, h, seed)` (a "photograph": a 4,000 × 3,000 is 4.9 MB of PNG),
  `noise(w, h, seed)`, `hugePNG(w, h)` (a header that lies), `magic`;
  init scripts `watchers` (`window.__toasts` and `window.__boxSays`: every
  text the toast and the dialog's progress, error and messages show, two
  in one task included) and the JSZip spy (`zipSpy(page)`: the app's
  `+esm` URL is served as a module that wraps the real build, fetched as
  `+esm?real`, and records in `window.__zip` each `loadAsync`, each
  `async` / `nodeStream` / `internalStream` call per entry and the bytes
  each stream delivered; `page.jszipAt` the times the page asked for the
  URL); the dialog: `openBoxes`, `closeBoxes` (its own close control),
  `upload(p, files, {now, done})`, `asked(p, kind)` (`{title, lines,
  checks, labels, buttons}` of `#box-ask`), `reply(p, label, {label: on})`,
  `row(p, boxId)`, `says`, `boxSaid`, `toasts`, `inView`; the host:
  `S` (`__ct.hostState()`), `settle` (the queue idle 300 ms), `asset(p,
  id)` (an image as IndexedDB holds it: `{mime, size, magic, w, h}`),
  `drawnWithImages`, `ranked(state)` (the seated players in "#k" order,
  computed as §4a says).
- **`t-p4-box-ui.js`** (Alice hosts on a desktop, Bob on an iPhone 13
  upright, Carol watches on one sideways, Mallory joins for case 7): the
  fixture picked as files (progress per image, the confirm, the layout:
  ids kept, "#k" hands, the images stored as WebP by their bytes, a board
  at its own 1,400 px, a piece at 560; drawn with their pictures on all
  three screens, Bob pulling them over the asset channel); the same zip
  (one box, "That box is already on this table", set up again; JSZip
  requested only now, read by streams only, its build pinned:
  `_data.uncompressedSize`, `internalStream`, `unsafeOriginalName`); Bob's
  box with rules (registers only; by Bob, 📜, read-only on every guest; no
  setup or rules on a guest), the confirm naming him with rules and shuffle
  ticked, the trust dialog's words and buttons, "Set up without rules"
  (piles shuffled), Reset without rules, Cancel (nothing changes), "Enable
  rules" (piles in order, rules.box), a .json export; the host's box with a
  saved rules state ("@#k" secrets and asks mapped, "@#3" dropped with its
  toast), Reset (layout and state again), a host reload, Reset again;
  mid-game Export (a .zip: ids, "#k", "@#k", no pid in it), play on, the
  export uploaded and set up: the position compared item by item (ids,
  faces, places within 0.5, z order, hands, the rules and their state; the
  catalog keeps the first box, so its box and deck ids are mapped back, and
  the box id the script stored must be the new one), both guests' views and
  hands as exported, and Mallory's messages on every channel scanned for
  the hidden marks of its state (a public mark reaches her: the control);
  the guests' budget shared by a deck and boxes (measured, refused with its
  words); a built-in box twice: one entry.
- **`t-p4-box-files.js`** (Alice hosts on an iPhone 13 upright, Bob on a
  desktop, Mallory is a raw peer): every hostile zip and file refused in
  the dialog (on the phone's screen) and a toast, naming the file or the
  field, nothing registered, and what the spy saw: the bomb's entry never
  read, nothing read of a zip with a bad path, too many entries or too many
  declared bytes, the 64 MB + 1 zip never opened, the liar's stream
  stopped (≈ 16.8 MB came out of 100 MB: one compressed block's output,
  D188), no markup or 30,000² PNG ever decoded; a Finder zip read; storage
  full: no box (§4h); a guest's bomb refused on his screen; the 4,000 ×
  3,000 photograph at 2,048 px, the 2,048² noise board stepped down to
  1,740 px, the Safari stub (`toDataURL('image/webp')` answering PNG):
  JPEG for the opaque, PNG for the transparent, a deck's card JPEG too;
  Mallory's cases 5, 6 (a peer hears one refusal per 10 s: the reset waits),
  10 and 11 — each forged entry on its own as well as together.
- **`t-p4-box-bench.js`** (serial): B20 and B21 on a generated board game
  (a 2,400 × 1,800 board and 63 counters, 64 photographs, 21 MB zipped),
  the clock started by the file input's change event.
- **`t-p4-resume.js`** (§4l t-p4-boxes item 8, resume elsewhere; written
  from the spec too, with p4-lib's dialog and host helpers): Alice (desktop)
  and Bob (iPhone 13 upright) play Hold'em to a bet on the flop and chess to
  1. e4 Nf6 2. e5 d5 (en passant open on d6, which only the game state
  knows), every move a drag and every bet a press on the player's own
  screen; Alice exports from 📦 → Export… (the download captured: the
  `.json` named after the box or, with no box, the rules; the box, deck and
  item ids in it, pids only as "@#k", hands as "#k"). Each export goes into
  a **fresh room with two new players**, through the file input, the setup
  confirm and the trust dialog (its words and three buttons): chess (Carol
  hosts on an iPhone 13, Dave on a desktop) keeps its ids and box id
  (`t.data.box`), White to move on White's new player, who takes en
  passant, and Black takes back, by drags; Hold'em (Erin on a desktop, Fay
  on an iPhone 13 sideways) gives each new player the hand, stack, chips
  paid and bet of the old one with the same "#k", the burn card its id, the
  board its deck's id, and the player owing the call presses Call 10, then
  the hand is checked down to its showdown (pot 40 paid). No "ids had to
  change" or dropped-state toast, no rules error. Then (Gus on an iPhone 13
  sideways, Hal on a desktop) an export without "Include the rules": no
  rules question, no trust dialog, the rules off, a pawn may step back; and
  one without "Include the game state", set up with its rules: the game
  starts afresh. Screenshots: `shots/p4-resume-*.png`.
- **`t-p4-resume-bench.js`** (serial): B21 on "Ridgeline Clash", a board
  game drawn in the page (a grained 2,000 × 1,500 hex map, 16 counter faces
  and 2 backs, 400 counters in forty ×10 stacks, dice, 24 order cards of 12
  images, two seats and a turn script), picked as 33 files, set up with its
  rules, a turn played, then exported with its rules and state: the clock
  from the press of Export… to the download; the `.zip` holds game.json,
  rules.js and every image game.json names (an image by its bytes).

### The 4A fix-up's regressions

- **`core-p4.test.mjs` (F)**: a guest's shuffled group of face-down pieces
  given ids, set up 40 times — each id stays at its place and names no
  piece (D196); `"off"` keeps a piece on its spot off the centre, and one
  out of reach is refused (D197); `{board, at}` before its board refused
  when the box is read (D198); a saved secret or ask keyed by no player is
  invalid, one keyed by an absent player is "away" (D199); a `clear` ends
  `lastSetup`, on the host and through a Worker patch (`lastSetup: null`,
  taken only in a clear), and an export after 🎲 chess is chess's (D200); a
  second `--keep` setup is logged again (D201); a forged loadBox patch
  pointing `lastSetup` at another box is refused (D202); errors named as the
  author wrote the box, and `isBuiltin`'s quick no and memo (D203).
- **`t-p4-boxes.js`**: in section 3, two root game.json told apart by case,
  a game.json without a name, a deck of 5,500 cards; in section 2, a zip
  holding empty files, a deck back named "navy"; in section 5, a double
  click on Set up leaves the trust dialog waiting (D204); in section 7, the
  export unzipped and picked as plain files; section 8, a double tap on a
  phone, and a guest whose host leaves mid-upload (D209); section 13, a
  game running when a box is set up (its rules switched off, said in the
  confirm: D205), a strict game refusing an upload — the host's and a
  guest's — with what to do, and README's and Help's examples uploaded and
  set up as written. Screenshot: `shots/p4-boxes-stops-desk.png`.
- **`t-p3c-review.js` section 2**: the press beside go's bowl moved from
  12 to 14 px off its centre (clear of the bowl's own box: at 12 px it
  touched the box's corner, and whether that was a hit was the engine's
  rounding), and a touch on the bowl's own corner, dispatched to the bowl,
  plays its stone where the finger ends (D206).

### The 4A fix-up 2's regressions

- **`core-p4.test.mjs` (G)**: a shuffled group of a hidden die and a
  hidden token under one back is refused by `boxOfDef` and as a guest's
  upload, naming both entries — unshuffled they may still share it — and
  tokens alone keep every place's address through 20 shuffles (D210); a
  script's veto and strict chess's refusal of an `addBox`, through the
  mirror, reach the player as `{t:'note', …, ruled: true}`, the engine's
  own "🚫 Box rejected" without it, and a Worker's note with `ruled: "yes"`
  loses the field (D211); after a host `clear` while a box's own rules
  run, the export is that box's (its types and rules), where it threw
  (D212).
- **`t-p4-boxes.js` section 14**: at 1280 × 800, 390 × 664, 844 × 390 and
  320 × 568 (where the trust dialog's buttons wrap to two rows), the
  element where the confirm's Set up was is the trust dialog's Cancel
  (D214); a box with rules and no layout ("Laid by its rules", which lays
  out one gem with `t.layout`): its confirm has no rules checkbox, its trust
  dialog only Enable rules and Cancel, Cancel changes nothing and Enable
  lays the gem out (D213); the host's upload whose images can't be stored
  (IndexedDB's `put` on `assets` throwing `QuotaExceededError`, patched in
  the page) while rules run says "storage is full", never that the rules
  refused it (D211). Screenshot: `shots/p4-boxes-trust-narrow.png`.
- **`t-p4-cli.js`**: `setup` of a box with rules and no layout, without
  `--rules`, is refused in the terminal, nothing cleared (D213).
- WebKit is not in the harness: section 14's slot check was repeated there
  by hand, outside it (Playwright's WebKit, one-off scripts not kept),
  finding Cancel at the confirm's Set up on the desktop, the iPhone 13
  upright (where WebKit wraps the buttons) and sideways, and a burst of 8
  taps there ending on Cancel. No suite asserts it in WebKit.

### The 4A fix-up 3's regressions

- **`core-p4.test.mjs` (H)**: a box with rules and no layout ("Laid by its
  rules"), through the mirror: a `setup` without its rules is refused
  ("has no layout — its rules lay the table out: set it up with them"),
  nothing cleared or marked set up; with them it lays out its gem, and a
  Reset while they run lays it out again; with its rules switched off — or
  other rules running — a `reset` is refused ("is laid out by its rules,
  which aren't running: Set up starts them again"), the gem kept, nothing
  logged; a box with neither layout nor rules is refused ("has nothing to
  set up"), the table kept (D215). After a Disable (which keeps
  `rules.box`) and a clear, an export of a deck-only table is just the
  deck — not named after the box, none of its types or `players` — and a
  box set up whose rules are off and whose pieces were deleted no longer
  names the export (D216).
- **`t-p4-boxes.js` section 14**: "Laid by its rules" with its rules
  running offers ↺ Reset and Set up; switched off (`setRules {enabled:
  false}`), only Set up, and a `reset` sent anyway comes back refused with
  that message, the gem kept (D215). Screenshot:
  `shots/p4-boxes-rulesoff-desk.png` and `p4-boxes-rulesoff-phone.png`
  (390 × 664).
- **`t-p4-cli.js`**: `setup Laid by its rules --rules` (Enable on the
  page), its rules switched off, then `reset`: refused in the terminal
  with the same message, still the box set up (D215).

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
