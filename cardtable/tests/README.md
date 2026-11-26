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
  `t-p1-bench,core-p1-bench,core-p2-bench,core-p4-bench,t-p1-flood,t-p1-assets,t-p3-go,t-p4-bench,t-p4-box-bench,t-p4-resume-bench,t-p4-hexfront,t-p4-hex-bench,t-p4-select,t-p4-gflood,core-p5.test`.
  A listed suite that doesn't exist fails the run; a Node-only
  `*.test.mjs` suite may be listed too (by its name without `.mjs`).
- Runs take a machine-wide lock (`CARDTABLE_TEST_LOCK`, default
  `/tmp/cardtable-tests.lock`): concurrent runs on a small machine starve each
  other into flaky timeouts, so a second run waits for the first.
- Each suite's log is kept in `out/<suite>.log` until the next run; failing
  checks are listed with the log's path.
- `parse.js` parse-checks `app.js`, `rules-worker.js` (a Worker app.js
  starts by URL, never imports) and every local module they import as real
  ES modules (a stray `await` or a duplicate export fails there, not in a
  browser). Local imports carry the code version (`./core.js?v=1`, see
  `MODULE_V` in `core.js`); the check fails one that doesn't, and an
  `index.html` that loads `app.js` or `style.css` without it (D306), then
  reads the file by its path, as the test server does.

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
  own screen's redraw is not in it); `lastJobMs`, the host's last job on
  its own table, rules off (`T.apply` alone: B19's apply).
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
  its own field-by-field oracle `boxProblems`), canon, isBuiltin;
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
  and returns its markup, cached per type object (the same string, at
  once, the second time): the `svg.psvg` (grid, zones, spaces, links) and,
  over it, its printed text as HTML (D297) — a `div.btexts`
  (`aria-hidden="true"`, as the SVG is: D300) of `span.btext`s, each centred on its anchor (`left`/`top` in board units,
  `translate: -50% -50%`): the coordinates `.btext.coord` (files in the
  margin strip right under the grid: `top` = grid bottom + min(margins) /
  2), the spaces' and zones' labels `.btext.slabel` (a private zone's also
  `.zlabel`). On the table each coordinate turns about its own centre
  (CSS `rotate`) by −(`--view` + `--rot`): the view's angle, set by the
  view sheet's rule 1 (its second), and the board item's `rot`, inline on
  its element; each `.slabel` by that angle rounded to the nearest half turn
  (CSS `round()`), so it is never upside down (D91). The coordinates also
  grow: `scale: min(var(--bz), var(--lmax))`, where `.btexts` carries
  `--lmax` (its margin over the widest label's box, an em tall and 0.6 em a
  character wide; 1 to 1.6: D97). A board's `.pface` and `svg.psvg` don't
  clip (`overflow: visible`).
  p2t-lib's `boardTexts(p, id)` reads each text off the screen (its map to
  the screen from three zero-size probes put in it, which composes every
  transform on the way, as `badgeAngles` reads a badge's; its box's distance to
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
(the first `.blabels text`; since D297 the first `.btext.coord`), and the labels' own rule.
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
  bring them up to date), `T.drag(p, a)` → whether an fx
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
  `T.rollbackTo(token)`, `T.rollback()` (to the begin), `T.commit()` → the StatePatch of §3f.2 (`items` — whole,
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

## Phase 4 (4B part 1: the group engine, the terminal's group, Hexfront)

- **`core-p4.test.mjs` (3)** (§4l item 3, D217–D219): a group on the
  host's own table (the rules off) and in a mirror (the rules on, the host
  taking each patch): one sub-action per member, bottom to top, each under
  the single action's checks — a move by the group's shift, each piece
  snapping on its own, its shape kept at the table's edge (the live drag's
  cut, `groupShift`); `rot` a per-member delta snapped to each rotStep;
  flip, lock (lockable "anyone"; one locked already is no skip), del,
  toBag; `roll` one roll of the dice the player sees (a face-down die isn't
  one to them, its value never in the line; more than 20 dice: the single
  roll's refusal). One line (`keep`), one bulb at the first member, one
  notice "k of N were skipped: {first reason}" — "🚫 …" only when none
  applied, a group of one saying the single action's words — and the
  skipped members re-sent. `groupIds` (200, each once, numbers as their
  digits), `floodCost` (1 + ⌊N/20⌋; three 200-member groups fit a fresh
  burst of 40), Mallory's 500 ids capped and deduplicated, malformed groups
  refused. Rules on: a veto rolls back its member alone (the notice
  `ruled`, one "blocked … (k of N)" line), onAction runs per member seeing
  `{group: N}` and its `a.to` / `a.from`, buttons() once; strict per
  member; a handle or validate that throws fails the whole group closed;
  an onAction that throws keeps the members done and skips the rest; a
  single action's forged `group` never reaches the hooks; the host refuses
  a forged bulb in a group's patch and takes the honest one.
- **`core-p4.test.mjs` (Hx)** (§4's demo in Node): `BOXES.hexfront` is the
  same box from a second evaluation of templates.js (a fixed seed), built
  in; 400 counters in 40 stacks, 20 a side owned by its seat; the map's
  fills, towns and zones; two dice; 24 event tiles in a face-down pile.
  Set up as 📦's Built-in does (`loadBox {setup, clear, rules}`, D221), the
  turn script running as the box's: Ember refused out of turn, the owner
  check, a group move of five stacks, an out-of-turn group vetoed whole,
  split and join, no dice before combat, ⚔ To combat, the defender's loss,
  a group roll, one event a turn, End turn (Ember's press refused by the
  engine), turn 2. loadBox `rules` refused for a box without; its `enable`
  from a mirror taken only as the engine writes it.
- **`core-p4-bench.mjs`** (serial; D222, D223): B18 — Hexfront's snapshot
  and its PublicBox ≤ 120 KB (16 KB); B19 — a group move of 200 tokens on
  a hex map, alternately by the host and 8 guests: the host's apply p95 ≤
  15 ms with the rules off (T.apply) and on (applyStatePatch of a mirror's
  patch; the mirror's own time printed), every sealed per-peer patch ≤ 30
  KB (as B9 measures it).
- **`t-p4-group.js`** (real tabs, desktop): Hexfront from 📦's Built-in
  section (its pitch in the row; no trust dialog; rules.box), 400 counters
  on a guest's screen, the turn cue; played through `__ct.act` and the
  page's own phase buttons and a double-click draw: a move out of turn
  refused, a group move (one log line), the host's and the Worker's digests
  equal, a vetoed group's one notice, a split, a group roll, the event card
  in the hand bar, one a turn, End turn; a group with another side's stack
  (skipped, said once); a group drag (`drag {ids, dx, dy}`) gliding on the
  other screen with the dragger's name, ended by the drop's group; the rules
  off, a group flip on the host's own table. Screenshot:
  `shots/p4-hexfront-desktop.png`.
- **`t-p4-cli.js`** adds `group`: the REPL commands (`move dx dy`, `rot
  deg`, flip, roll, `unlock`, `bag <bag>`, ids comma-separated) and the
  Bridge API's `group()` send the same in both languages, bad ones print
  the usage, the help lists it; with real tabs, Alice's `group move` (one
  line, every member moved on Bob's screen) and Bob's `group del` of both
  boats (his own goes; Alice's skipped, said once in his REPL).
- **Mechanism changes**: `core-p2.test.mjs`'s exact PUBLIC_ACTIONS set
  gains `group`; `run-all.sh`'s serial batch adds `core-p4-bench`.

## Phase 4 (4B part 2: multi-select, the group bar, the stack inspector, Hexfront played)

- **`p4s-lib.js`** (helpers, not a suite): what a page shows of the
  selection (`shown(p)`: the `.selected` ids, the bar's text, the chip's),
  boxes and overlaps (`box`, `itemsBox`, `overlap`, `inside`), the toasts
  (`toasts`, `said`), the open inspector (`inspector(p)`: its text, its
  list's ids, whether it shows a back, Take's k), a badge's centre
  (`badgeAt(p, id, 'count' | 'fanb')`), a point outside the inspector and
  the bar (`outside`), and touch gestures by CDP: `tap`, `press` (a
  button), `pinch(p, c, d0, d1)` (two fingers spread: the view zooms in
  there), `hold(p, q, ms)` (a long press).
- **`t-p4-select.js`** (§4l t-p4-select; desktop, iPhone 13 upright and
  sideways): a test box of 200 tokens on a 22 × 12 board, a crowded cell, a
  flag, stacks (one hidden), dice, a bag and chits. Item 1: a Shift+drag
  band on the locked board (six picked, never the board), the chip "2 not
  selectable …", Shift+click in and out, Esc, a click on the felt, one
  picked = its own bar, ⬚ on a desktop (a plain drag draws the band, a
  click picks, ⬚ off clears). Item 3: the group bar's buttons and the keys
  (R by the chits' rotStep, ⟲, F, Space rolling the three dice as one, 🔒
  then 🔓 — the locked stay picked —, ✕, 👜 Into bag ▸ Sack, Delete), each
  one log line. Item 4: a forged group naming a locked and someone else's
  token, "2 of 3 were skipped". Item 5: rules that veto the flag: "1 of 4
  was skipped: The flag stays put", the flag back on Bob's screen, the
  others moved, "blocked Bob: … (1 of 4)". Item 2: a band of the board's
  195 tokens plus five more by Shift+click (a 201st refused: "200 at
  most"), dragged 8 s by the mouse: every `drag` names 200 ids, at most 17
  in any second (`actTap`), the host's screen glides all 200 mid-drag, one
  `group` move of 200 on the drop, every member a cell right on both
  screens, no flood notice, one line; B19 in the browser (the host's
  `perf.lastJobMs` ≤ 15 ms; the patch that brought it to Bob ≤ 30 KB).
  Item 6: the inspector by a click on ×10 (beside the stack), the stepper,
  Take 3, following the stack (Alice takes one: ×6), Take all arming ✥ and
  the next drag carrying the stack, a hidden stack's back, Esc, the ×3 of
  a crowded cell (its pegs, top first), a click outside, a click on a
  member (its bar), a drag out of the list onto a cell. The iPhone (Carol,
  pinched in): ⬚, a one-finger band, a tap picks a fifth (one the bar
  doesn't cover), the bar on the screen beside the group with 40 px+
  buttons, a finger drags the five, ✕; a long press on the ×6 stack (the
  inspector beside it, 44 px buttons, Take 2 by taps); sideways (reloaded at
  844 × 390): the band, the bar and the inspector on the screen. Screenshots
  `shots/p4-select-*.png`, `shots/p4-inspector-*.png`.
- **`t-p4-hexfront.js`** (§4l t-p4-hexfront; serial): Alice hosts on a
  desktop, Bob plays on an iPhone 13, Carol watches (a third player: no
  seat). Hexfront from 📦's Built-in section; 400 counters in 40 stacks on
  every screen. Each side plays turn 1 with real gestures (`turn()`): the
  other side's drag out of turn refused ("It's Azure's turn") and the
  counter back; three stacks picked (Shift+clicks, or ⬚ and taps on the
  phone after a pinch) and dragged a hex forward ("moved 3 items"); a stack
  split by the inspector (Take 3; a long press on the phone) and joined
  again (Take all, a drag onto the ×7); an event drawn (a double-click, or
  a tap and Draw) and a second refused; ⚔ To combat, the two dice rolled
  as a group (Space, or 🎲 Roll), a loss taken by the other side (Flip, F),
  ⏭ End turn; "Turn 2 — Azure moves". The watcher's table equals the
  host's; her drag on a stack sends nothing. B18 in the browser: Carol's
  cold render (≤ 600 ms), Bob's at 2× CPU throttle (≤ 2 s), the snapshot
  and the boxes channel ≤ 120 KB; B21: Hexfront exported from 📦 ≤ 5 s
  (`Hexfront.json`, its rules and turn 2 in its state). Screenshots
  `shots/p4-hexfront-iphone.png`, `shots/p4-hexfront-watcher.png`.
- **Mechanism changes**: `t-p2-pieces.js`'s exact bar of a ×N stack the
  player may handle gains `inspect` (⋯ Inspect, §4g); `run-all.sh`'s
  serial batch adds `t-p4-hexfront`.

### The 4B group suites written from the spec (independent of the implementation)

- **`core-p4.test.mjs` (3′)** (Node; §4l item 3: §4c, §3f.4–§3f.6, §2c,
  D217–D219) on "Muster", an original box (pawns on and off a 10 × 8
  field, a tile, a hex token, a wedge, a face-down crate, labelled dice, a
  face-down die and a face-down token under one back, a bag, face-down
  cards). A group's members end as the single actions sent one by one leave
  a twin table (`mustered()`: the same seed, the same layout): moves
  snapping on their own (dice never), `rot` a per-member delta snapped to
  each rotStep; one line, one bulb. Each member is under the owner and lock
  checks and is skipped alone: "k of N were skipped: {the lowest skipped
  member's reason}", "🚫" only when none applied, a group of one saying its
  single action's refusal. The hidden-item rule: a group roll is one roll
  of the dice the player sees, and a face-down die in it says word for word
  what a face-down token under the same back does. Flip, into a bag,
  remove; the first 200 ids each once; malformed groups refused. Flood
  control through `T.mayAct` (1 + ⌊N/20⌋ of the 40-token burst; a group
  drag one token); the watchdog's budget through app.js's own `budget`, cut
  from its text as h.js cuts WholeOffers (4000 + 10 ms × N, N ≤ 200). With
  the rules on (`room()`'s mirror): a veto and an engine refusal roll back
  that member's handle writes alone; onAction per member sees {group: N};
  buttons() once; a forged {group} on a single action never reaches the
  hooks; a handle or validate that throws (or an async validate) fails the
  whole group closed, said word for word as the single action's failure
  is; an onAction that throws keeps the members done; strict per member.
  The host takes each op's honest patch and refuses eight forged ones whole
  (another's line or bulb, a chat line, a peek, a rename, offline,
  lastSetup, an `enable`).
- **`t-p4-attack.js`** (real tabs; §4j attacker case 8, §3f.5): Alice sets
  up "Muster" (with 200 drill pawns), Bob's state bodies are recorded,
  Mallory is a raw peer. Her move of 500 ids (one pawn 150 times, Bob's
  pawn and face-down card, a locked pawn, face-down pieces, 44 ids naming
  nothing, a pawn at the 201st place): capped, deduplicated, skipped, "47
  of 51 were skipped: …". Her roll of 500 ids: one roll of the dice she
  sees, the face-down die never. Her flip and remove of what isn't hers:
  refused, nothing changes. A burst of eight 500-id groups: 3 to 7 apply
  (11 tokens each), the rest "Too many actions". Then a recursive scan of
  every body she received and of Bob's: no face-down card's index, no
  hidden piece's type, face or side, no hidden type's word outside the
  public catalog. Last, the watchdog in a real Worker: 200 members × 22 ms
  of validate() (4.4 s) are not stopped, 20 × 400 ms are, at about 4.2 s,
  the group dropped whole and both told as §3f.5 words it. Its margins
  (4.4 s against a 6 s budget, 8 s against 4.2 s) hold in the parallel
  batch.
- **`t-p4-gcli.js`** (cli.js and cli.py in parity; §4i, D224): to a fake
  tab, every `group` form sends exactly {t: 'group', op, ids, dx, dy | deg
  | bag} from both REPLs; malformed lines print the same usage and send
  nothing; both helps list it alike; the Bridge API's group(op, ids, kw) /
  group(op, ids, **kw) through a driver that passes keyword arguments
  (`apiKw`). Real tabs, Alice hosting on cli.js and Bob a guest on cli.py,
  on "Drill": move, rot, roll, bag (by its name), lock, unlock and del typed
  in a terminal, one line in both REPLs, the skips said once in the
  sender's; an unknown op said in the terminal.

### The 4B selection suites written from the spec (independent of the implementation)

- **`p4m-lib.js`** (helpers, not a suite): `join` (a player with p1-lib's
  RTC hook, p3-lib's `actTap` and p4-lib's `watchers`: every action it
  sends, `window.__acts`, and every notice it shows, `window.__toasts`);
  what a page shows — `selected`, `bar` (shown, text, buttons, box),
  `chip`, `bandShown`, `selMode` (⬚), `badge(p, id, 'count' | 'fanb')`,
  `hit`, `pt` (a table point's client point); gestures — `mouseDrag` and
  `click` with Shift, CDP touches `tap`, `longPress`, `fingerDrag` (the
  finger then rests 400 ms: Chromium suppresses a tap that lands while a
  swipe's fling still runs) and `spread` (two fingers: a zoom); `sent`,
  `notes`, `lines(p, who, since)` (the log lines in a player's or the
  rules' name), `peakRate` (the most messages in any one second).
- **`t-p4-multi.js`** (§4l t-p4-select items 1–5; Alice hosts, Bob on a
  desktop, Carol on an iPhone 13) on "Sorting yard", an original box: a
  22 × 10 yard of 180 pebbles, rows of dice and counters, 60° and 45°
  turners, chits with a back, a two-faced coin, a bag, a flag; three
  pebbles locked, two Alice's. 1: a plain drag pans on the felt and on the
  locked yard, a Shift+drag there draws a band (never picking the yard,
  even round its centre), only what Bob may handle ("2 not selectable
  …"), Shift+click in and out, Esc, a click on the felt and ✕ clear; on
  the phone ⬚ sits at the bottom left, a finger drag pans without it, with
  it a one-finger band and taps pick and unpick, ✕ and ⬚ off clear, a
  finger carries the group (drag {ids}, never a move; one group on the
  lift), 🔒 and 🔓 by taps (the locked stay picked). 2: one band of exactly
  200 (the yard's 180, 10 dice, 10 counters) dragged by the mouse:
  Alice's and Carol's screens glide all 200 mid-drag, Bob's 200 share one
  shift, every drag names the 200, at most 17 in any second, no move, one
  group move on the drop — each yard pebble on the next cell, the dice and
  counters by the shift, on every screen and drawn so on Bob's — no flood
  notice, one line "moved 200 items"; the relay shaken fast with a small
  group (≈ 60 pointer moves a second, still ≤ 17 drags); a 201st never
  picked. 3: the group bar's buttons, then ⟳, R, Shift+R, ⟲ (by 60, the
  largest rotStep, each member snapped to its own: 60°, 45°, free), Flip
  and F (the chits face down and up, the coin over, never a die), 🎲 Roll
  and Space ("rolled 3 dice: a · b · c", the new faces in id order), 🔒
  and 🔓 (picked while locked), 👜 Into bag ▸ Sack, 🗑, ⟳ of plain pebbles
  (90°), Delete — each one `group` and one log line, no skip; the bar
  covers no member. 4: Alice locks one counter and claims another while
  Bob's drag of the four is under way: those two stay put on every screen
  (Bob's draws them back), the other two move, "2 of 4 were skipped: …"
  once, "moved 2 items". 5: «Picket» (enabled from 📜) vetoes the flag,
  third of five by z: the four move, the flag stays, "1 of 5 was skipped:
  The flag holds its ground", one line "moved 4 items" and the rules'
  "blocked Bob: …"; the vetoed member's own t.say and t.data write are
  rolled back, onAction counted four. Screenshots `shots/p4m-*.png`.
- **`t-p4-inspect.js`** (§4l t-p4-select item 6; Alice, Bob on a desktop,
  Carol on an iPhone 13 upright, Dave on one sideways, 750 × 342) on
  "Stack yard": ×N stacks, a hidden ×6, Alice's ×3, two crowded cells. A
  click on ×10 opens the inspector beside the stack; the stepper runs 1 …
  N − 1; Take 3 sends one split {n: 3}, the new ×3 lands on the next cell's
  centre, the inspector redraws ×7, then ×6 when Alice drags one off; Esc
  closes it. ⋯ Inspect in the bar; Take all, and a plain drag carries the
  whole stack; a ×6 and a ×3 picked together go whole with the group's
  drag. The hidden stack shows its back ("?" in its colour) and no
  label, name or face colour; a click outside closes it; Alice's stack
  offers Bob no Take. A crowded cell's ×4 lists its four (each label, a
  picture each, the back for the hidden one, Alice's dot on hers alone); a
  click on a row selects that piece with its bar; a drag out of a row
  closes the list and moves that piece. Alice thins the crowd: the list
  redraws, then closes; she removes a stack Bob inspects: it closes. The
  phone: a long press opens it (not the zoom) on the screen, 44 px
  buttons, + and Take 2 by taps, a tap outside closes it, a tap on ×N or
  on a crowd's ×3 opens it, a row's tap selects. Sideways: a long press,
  Take 1, and ⬚ with a one-finger band — the inspector and the group bar
  on the screen.

### The 4B Hexfront suites written from the spec (independent of the implementation)

- **`p4h-lib.js`** (helpers, not a suite): `player` (a player with p1-lib's
  RTC hook, p3-lib's `actTap`, p4-lib's `watchers`, and two init scripts
  of its own: `wireLog`, every whole `state` and `boxes` message the page
  receives with its bytes on the wire — Trystero's framing included, as
  the B1' counter counts them — its kind, the item ids it carries and its
  body's JSON length, in `window.__wire`; `modalLog`, every dialog shown
  modally, in `window.__modals`); `hexOf(p)`, what a page sees of Hexfront
  read from its own view and catalog (a unit is a piece whose type's
  `meta` names a side; the one board with a hex grid; the dice; the Events
  pile and the type its back draws; the seats; the hand; the types); hex
  geometry by brute force on p3-lib's `spotXY` (`hexAt`, `hexNear`,
  `ahead`: a free hex one row forward, `forward`, `frontOf`); gestures
  (`focus`: 🧭, then the wheel or two spreading fingers at a table point;
  `dragFrom`, with Shift; `longPress`; `moveStack`: a Shift+drag, or a tap,
  ✥ Move all and a drag; `putAway`; `feltAt`); `refusal(p, at)` (the first
  "🚫" notice since); `linesBy` / `logged` (log lines by their timestamp:
  the log keeps a bounded number of lines, so its length stops growing);
  `layoutOf(items)` (a public layout, ids and the box id left out).
- **`t-p4-hexplay.js`** (§4l t-p4-hexfront items 1–6; Alice hosts on a
  desktop, Bob plays on an iPhone 13 upright; each plays a whole turn on
  their own screen). 1: Hexfront from 📦's Built-in section — one confirm
  (the table had items), no `#box-ask` at all (built in by content: no
  trust dialog), its rules on, the stored box `isBuiltin` (core's), 📦
  listing it "built in" with its 📜 on both screens, Bob's copy without
  setup, rules or rulesState. 2: on both screens one hex map, 40 stacks of
  ×10 (400 counters), 20 a side, each owned by its side's seat, each
  centred on a hex of its own with its address; dice; the Events pile face
  down with 24 cards (D222); the two players in the two seats; ×10 drawn
  on every stack. Then `turn(A, O)` for each side: 3 — the turn cue and
  the phase button on the active screen alone; O's stack dragged forward
  out of turn: sent, refused, back whole; A's drag on O's stack sends
  nothing, a forged move of it (`__ct.act`) is refused by the host; A moves
  a whole stack a hex forward (Shift+drag; ✥ on the phone), on both
  screens. 4 — the inspector (a click on ×10; a long press), Take 3: ×7
  and a ×3 of its kind on a hex of its own, the inspector redrawn ×7, Esc
  or a tap outside closes it; O's Take out of turn refused; the ×3 joined
  back (Shift+drag onto the ×7; a tap on ×3, ✥ Take all and a drag). 6 —
  an event drawn (a double click; a tap and Draw): one card in the hand,
  its face in the hand bar, the pile one fewer and the drawer's count on
  the other screen, no event card's identity in any body the guest
  receives outside their own hand; a second draw and O's draw refused. 5 —
  a roll refused before combat; ⚔ To combat (the button moves on, the
  badge changes on the other screen, a move is now refused); both dice
  picked (Shift+clicks; ⬚ and taps) and rolled as a group (Space; 🎲 Roll):
  one line "rolled 2 dice: a · b", the values the faces shown; O's roll
  refused; ⏭ End turn hands the turn and the button over. Turn 2 returns
  to the first side; both screens agree. Screenshots
  `shots/p4-hexplay-*.png`.
- **`t-p4-hexbox.js`** (Hexfront deterministic, and resumed elsewhere):
  templates.js imported twice (two module instances, two runs of the
  generator) gives one box; two Node set-ups store one box (`isBuiltin`)
  and lay out one table, ids aside; the browser's set-up from 📦 stores
  that very box and draws that layout; set up again from 📦: one catalog
  entry, the same layout. A mid-game position (made with `__ct.act`: a
  move, a split, a draw each, ⚔ and ⏭) exported from 📦 (`Hexfront.json`:
  no images; the rules and the game state ticked by default) and uploaded
  in a fresh room (Carol on a desktop, Dave on an iPhone 13 sideways) with
  Set up now: the setup confirm, the trust dialog (the export is no
  built-in box), Enable rules; then every item by its id as it was, each
  seat's hand, the script's state, the side to play and its phase; Dave
  moves a stack on his phone, Carol's move out of turn is refused.
- **`t-p4-hex-bench.js`** (item 7, serial). B18: in Node the snapshot body
  (and with its PublicBox) ≤ 120 KB; in the browser the snapshot a guest
  receives on the wire ≤ 120 KB (with the boxes message too), a desktop
  guest's cold render ≤ 600 ms and an iPhone 13's at 2× CPU throttle ≤ 2 s
  (`lastSnapRenderMs`, the worst of three). B19 on Hexfront itself:
  Azure's 200 counters split into 200 singles, one a hex, moved a hex at a
  time by Azure's player — in Node, host apply p95 ≤ 15 ms with the rules
  off (`T.apply`) and with Hexfront's turn script on (a mirror runs the job
  as the Worker does; the host's `applyStatePatch`), and every guest's
  sealed patch ≤ 30 KB, measured as B1 measures a body
  (`JSON.stringify(sealText(…))`); in the browser Alice bands the 200
  (Shift+drag) and drags them a hex: one line "moved 200 items", the
  patch each guest receives on the wire ≤ 30 KB; then, the rules off in
  📜, `perf.lastJobMs` of five more drags (median ≤ 15 ms).
- No existing suite changed; `run-all.sh`'s serial batch adds
  `t-p4-hex-bench`.

## Phase 4B fix-up (the review's findings)

- **`t-p4-fix.js`** (Alice hosts, Bob on a desktop, Carol on an iPhone 13;
  the box «Corner yard»: two rows of tokens on a 12 × 6 yard, three pegs
  crowding a cell, a ×6 stack, 22 dice, two bags). 1: two Shift+clicks —
  the group bar docks at the table area's top edge (no piece is drawn
  there), no token is under it, and the next Shift+click on the row above
  the picks picks (D236, D240); a
  Shift+click on the bar selects no page text. 2: a Shift+double-click on a
  token and on a die picks and puts back, nothing flips or rolls. 3: 👜
  Into bag ▸ Pouch with the bag Sack among the picks: "put 2 items into the
  bag Pouch", no "skipped" notice; a band of the 22 dice and 🎲 Roll: the
  chip "20 dice at most: 2 left out", one "rolled 20 dice" line, no
  refusal. 4: with a group picked, a row of the crowded cell's list selects
  that peg (its own bar), and a stack's Take all arms ✥ (D238). 5: the
  phone, pinched in, ⬚ on: the chip above ⬚, no seat label under it; a
  tap-tap only picks and puts back; a finger drag that starts on a token
  draws a box (the four inside picked, the token unmoved — D237); a band
  turned into a pinch by a second finger leaves no band. 6: chess (strict,
  takes selections): two of your pieces Shift+clicked, no bar. 7 (fix-up
  2, D240): «Rim rows», six rows of nine tokens from the table's top edge.
  Alice, whose screen has them 45 px below the table area's top,
  Shift+clicks tokens in that top row: the bar docks over the toolbar at
  once, its buttons held off ≥ 399 ms (stamped in their `disabled` setter,
  D299: a MutationObserver's callback came late under load), no token lies
  under it, and the next Shift+clicks (each read once it shows) — in the
  top row and the row below — each pick their token; 🗑 of six asks first
  ("🗑 Remove 6?", nothing removed), its second press logs "removed 6
  items", and the toolbar is back. Bob, seated at a side (his view turns
  the table: its rim along his screen's top): two picks dock the bar at the
  table area's top edge, over no token, every toolbar button still his to
  click, and a third pick leaves it where it is. Carol, zoomed in and
  panned until the tokens reach her screen's top (35 px below the table
  area's), ⬚ on: two taps in the middle dock the bar over the toolbar, no
  token under it, taps on the highest and the lowest token each pick
  theirs, ✕ (first in the bar) gives the toolbar back. Dan, a host alone at
  a fresh table (its "What are we playing?" strip): two picks, no token
  under the bar, and a click on each strip button still reaches it.
  8 (fix-up 3, D245): Eve, a host alone on an iPhone 13 held upright
  («Wrap rows»: a lockable box, its table seen whole), moves a row of eight
  tokens to just below the strip the bar docks in (their screen boxes 3 px
  under its 60 px). Five picked with ⬚ — three tokens and two dice, a bag
  on the table — give "5 selected ⟲ ⟳ Flip 🎲 Roll 🔒 Lock 👜 Into bag ▸ 🗑
  ✕": the bar docks in the table area in one row (≤ 54 px, it had wrapped
  to 102 px), wider than the screen (it scrolls, its end faded), no token
  under it and a tap at each row token reaching it; 👜 Into bag ▸ opens its
  list in the same row. Three row tokens join (eight); 🗑 asks "🗑 Remove
  8?", the whole button on the screen, unfaded, nothing removed. One token
  picked with ⬚: its own bar plus ✕, one row, over no token, and a tap on
  the row picks. Bob (desktop guest, the rim rows table) picks two, his bar
  at the table area's top; a MutationObserver on #toolbar and #table-wrap
  records each move of the bar to another parent and how many of its
  buttons were disabled then. Alice moves a non-member token into his
  strip: the bar goes over the toolbar, all its buttons held off as it
  jumps, and a Shift+click at the token picks it; she moves it back out
  (a member leaving the strip): the bar docks at the top again, held off;
  she moves one of his picks into the strip: over the toolbar, held off,
  over no token. On the base (f2bc379) this section fails 10 checks.
  9 (fix-up 4, D247, D248): Eve again, five picked with ⬚: the row starts
  at ✕ (scroll 0), 👜 Into bag ▸ beyond its faded end; a swipe just far
  enough to show the toggle whole (`scrollLeft` set, as a swipe leaves it),
  a tap on it: the toggle and "👜 Sack" both lie in the row's unfaded part
  (`clear()`: inside the bar, past a 15% fade at each faded end); a second
  tap closes it and the row is back where the swipe left it, `.less` set.
  Eight picked, swiped to the row's end, 🗑 tapped: "🗑 Remove 8?" whole in
  sight; a pinch of 1.4 about the table's middle brings the top row into
  the strip, the bar jumps over the toolbar, and the ask is still whole and
  unfaded there (a new parent's scroll had reset to 0); once it lapses the
  row is back where the swipe left it (clamped to its room), `.less` while
  scrolled. Dan (desktop host alone, «Many bags»: six tokens, a ×5 stack,
  fourteen bags): two picked, 👜 Into bag ▸ open, the row wider than the
  screen; a wheel over the bar scrolls it (240 px a turn), so does a
  sideways one, the table's transform unchanged; wheeled on to its end, 🗑
  in sight, and a click on it removes the two; a wheel over the open
  inspector zooms nothing; with a token's own bar open, sixteen wheel turns
  zoom the view and lay the page out at most 6 times (CDP `LayoutCount`; 1
  here, 32 on the base), the bar still just above its token. Bob (desktop
  guest) picks two, his bar at the top; Alice moves four tokens far from
  his strip: `__ct.perf.dockScans` (dockTop's looks over the whole table)
  does not change and the bar stays; one moved into the strip and out again
  re-docks it both ways. On the base (42541bb) this section fails 10
  checks.
  Screenshots `shots/p4-fix-desktop-dock.png`,
  `shots/p4-fix-iphone-corner.png`, `shots/p4-fix2-desktop-toolbar.png`,
  `shots/p4-fix2-desktop-top.png`, `shots/p4-fix2-iphone-toolbar.png`.
- **`core-p4.test.mjs` (I)**: a group roll whose onAction removes a die (one
  line from the faces rolled, the rules on); Hexfront laid out without its
  rules — loadBox, Set up, Reset after a Disable — in two rooms: the Events
  pile never in templates.js's order, the line says the shuffle, and
  `shuffle: false` still lays it in order (D232); Hexfront's script on
  Ember's deal, peek, flip, shuffle and remove of the Events pile out of
  turn, a dealt card's ✋, and a draw after a deal (D239); patches: a group
  move as `pos` places, a flip and a refusal's re-send whole, folded = the
  snapshot, a place for an unknown item dropped loudly (D233); a ruled
  group's price at 1 MB of t.data and its watchdog budget from `T.rulesChars`
  (D234).
- **`core-p4.test.mjs` (J)** (fix-up 2): a group of two whose validate
  hooks take t.data's JSON away and back while hiding a function in it:
  the rules go off with "t.data.fn is a function, not JSON", nothing of the
  job left in the mirror or on the host (D242); a group of 200 at 1 MB
  costs 121 tokens, goes from a full burst, and overdraws it — nothing
  passes until (121 − 40) / 20 s have gone, then exactly the 4 tokens 0.2 s
  bought (D241); at 2 MB, the Worker time a flood of groups buys a second
  (20 / price × a group's time) is no more than a flood of single moves';
  100,000 `uid()`s, none of digits alone, and 12 boxes added to a table
  listed in the order they came (D244: an all-digit id is an array index,
  listed first — `t-p4-cli.js`'s box list failed so about one run in
  twenty).
- **`t-p4-gflood.js`** (serial; Alice hosts a rules script whose t.data
  holds 3 MB, Bob and Carol on desktops): for 24 s Bob sends a group move
  of 200 every 2 s and Carol a single move every 2 s. Flood control lets 1
  to 3 of Bob's groups through (each overdraws by its price, D241); each of
  Carol's moves applies within 6 s, their median within 1 s (~1.6 s with
  the price capped at the burst), the last third's waits no longer than
  the first's, the job queue at most 3, the rules still on.
- **Mechanism changes** (the wire's `pos`, D233, and the fixes' texts; no
  assertion removed or weakened): the folds of patches written outside
  core — `core-p1.test.mjs`'s spec model (and its list of a patch's keys),
  `core-p2.test.mjs`'s fuzz, `h.js`'s `viewFrom`, `p2-lib.js`'s Mallory —
  take an item's new place from `pos`; `p4h-lib.js`'s wire log counts the
  items in `pos` too, and so do `t-p4-select.js`'s B19 patch filter,
  `t-p1-review.js`'s "a guest's move carries its item and log line only",
  and the benches' "each move's patch carries exactly one item"
  (`core-p1-bench`, `core-p2-bench`) and "every group move took all 200"
  (`core-p4-bench`); `run-all.sh`'s serial batch adds `t-p4-select` (its
  B19 row times the host's apply, which a loaded parallel batch slowed to
  16.7 ms);
  `t-p4-attack.js`'s scan counts a hidden item met in `pos` as met (and
  refuses a place that says more than four numbers and an address), Bob
  makes one more move before the scan so Mallory has a sixth body to scan
  (how many the ticks coalesce into varies with the load: 5 or 6), and the
  watchdog's toast names the job's limit ("4.2 seconds", D234);
  `core-p4.test.mjs`'s group of one expects the single action's refusal
  word for word ("🔒 …", D235) and its `appBudget()` passes a table with
  `rulesChars`; `t-p4-select.js`'s ⬚ chip reads "drag a box" (D237).
- **Mechanism changes in fix-up 2** (no assertion removed or weakened):
  `t-p4-attack.js`'s extra broadcasts before the scan are Bob's moves of
  three hidden items, each awaited as its own body (one pawn's move gave
  her 6 bodies and 10 meetings with the hidden items under load, short of
  the check's 11); `t-p3-cli.js` waits for each REPL to have printed the
  four new asks as they came before it types `asks` (under load the last
  push landed inside the listing: 8 lines for 5); `core-p4.test.mjs` (I)'s "a group of 200: the whole burst, never more"
  keeps its check (it goes from a full burst and takes all of it) under
  D241's words; `run-all.sh`'s serial batch adds `t-p4-gflood`.
- **B4 on this machine** (D243): `t-p1-bench`'s rAF rows ran at 33.3 ms
  p95 here, with no long task — the code before this fix-up and the base
  before 4B alike. A Chrome trace of its pan and twist found app costs: a
  pan repainted the seat labels every frame (they are layers of their own
  now), and each finger's move in a pinch forced the style the other had
  just written (the table area's size and rect are no longer read back
  per move). Alone on the same machine the rows now run at 16.7–16.8 ms;
  what is left per frame is the browser's (re-layerizing the table's
  layer, hover hit tests), so a heavily loaded machine can still push a
  row over — rerun the suite alone before blaming a change. (Amended by
  fix-up 3 below: the 16.7–16.8 ms did not hold in most solo runs.)

## Phase 4B fix-up 3 (the review's findings)

- **`t-p4-fix.js` section 8** (D245): see its entry under the Phase 4B
  fix-up above — the bar docked in the table area is one row, no deeper
  than the strip found clear; the ask in sight; other players' moves into
  and out of the strip re-dock it, held off as it jumps.
- **B4, traced again** (D246, amends D243): the reviewers' solo runs of
  f2bc379 had one B4 row at 33.3 ms in four of five, and so did this
  round's first. A Chrome trace of the bench's pan and twist (CDP
  `Tracing` with the timeline's invalidation tracking: each frame's
  main-thread work, the layouts and their causes, the hover hit tests) found a layout
  in about every third frame — `placeSeats` wrote the button row's
  max-height and ⬚'s chip's `bottom` while your own label moved — and,
  after each, Chrome's synthetic mousemove for hover: a hit test of the
  whole 1,000-piece table, 3–6 ms at CPU × 2. Now nothing a gesture's
  frame writes lays the page out. `t-p1-bench.js` adds a check to each pan
  and gesture row: the phone's layouts (CDP `Performance.getMetrics`'
  `LayoutCount`, from before the gesture to 300 ms after the lift) are at
  most `B4_LAYOUTS` (15). Here: 0–7 per row; the code before had 81–101
  per pan and 86–88 per twist and fails four of these checks. Alone, all
  B4 rows were green in four runs of four (16.7–16.8 ms p95). What remains per frame is the
  browser's: re-layerizing the page at each transform change of the table
  (6–7 ms at CPU × 2), a turn's view-sheet rule change (about 1.5 ms), and
  Chrome's ad-detector hit tests (about one a second, 10 ms). A loaded
  machine can still push a row over — rerun the suite alone first.
  (Amended by fix-up 4 below: with nothing selected only — a piece's bar
  and the inspector, and a wheel zoom, still laid the page out each frame.)

## Phase 4B fix-up 4 (the review's findings)

- **`t-p4-fix.js` section 9** (D247, D248): see its entry under the Phase
  4B fix-up above — the one-row bar's scroll (an opened list and the ask
  brought into sight, kept through a re-dock, the row back where it was
  after; `.less`), a wheel over the bar and the inspector, a wheel zoom's
  layouts, and `perf.dockScans`.
- **`t-p1-bench.js`, two more B4 rows** (D247): the 1,000-piece pan again
  with a token's own bar open beside it (`tapOne`: the phone taps items
  near the table area's middle, each at the point of its face farthest
  from any ×N badge (D299), until one's bar opens — a tap on a ×N badge
  opens the inspector instead, closed by Esc), and the 6000 × 4000 twist with a stack's bar open. Each under B4's
  budgets (no long task over 50 ms, the rAF p95, `B4_LAYOUTS`); the bar is
  still open after, and after the twist still beside its stack. Before:
  `placeBeside` read the bar's size and wrote its `left`/`top` in every
  frame — 178–181 layouts a pan, 302–355 a twist, p95 33.3 ms (the
  reviewers' probes); now 0–2.
- **Mechanism changes, no check weakened:** `t-p2-review.js` moves the bar
  over a label by `translate` (where the app now puts it) instead of
  `left`/`top`. `t-p3b-review.js` section 11 waits (5 s) for Bob's "rules
  disabled" line before reading it: it comes in the host's next broadcast,
  and a loaded full run read it too early ("Bob's log says only
  undefined"). `t-p1-bench.js` B11 times the cached `boardSVG` call three
  times and keeps the fastest: one sample alone could hold a GC pause (2.9
  ms once, every other board 0.000).

## Phase 5 (part 1: the engine and the wire of private material)

- **`core-p5.test.mjs`** (Node, §5l's core list; SERIAL: B23 is a timing
  budget). Its `room()` is core-p4's — a host table and, while rules run,
  a Worker-like mirror whose patches the host checks (`R.job`) — plus each
  player's view as app.js's broadcast builds and a guest folds it:
  `R.tick()` takes the dirty sets, builds the shared patch once, splices
  each peer's own part (`T.mine`: hand, asks, hint, secret, `vis`) and
  folds the body (`viewFromSnap`, `applyViewPatch`); `R.fresh(p)` is what
  p's full snapshot would show now (call it right after a tick); `R.set`
  sets a scene (an action, its effects dropped), `R.api(fn)` calls the
  facade straight on the host (its aggregated 📜 lines written, as a job's
  end writes them). The test box `PRIVY` has racks (`private: 'reveal'`,
  owned through their board's owner), north's screen (`'keep'`), a mat of a
  seat the table lacks (inactive), tiles and units with backs, dice under a
  cup back, a coin with no back and a bag; Alice (host) sits south, Bob
  north, Carol east, Mallory (`DAVE`) watches. Sections: (1) the reduction,
  every row of §5d (a die cupped and revealed, seat-ref vis, owners, a pile
  of hidden pieces, a box missing, a hand, an unregistered peer); (2)
  private zones (entering, same owner, leaving a rack and a screen, a real
  owner kept, another owner's zone, a no-back piece refused or a
  TypeError, inactive zones, board moves firing nothing — the host may not
  move North's rack, Bob does —, a zone gone from under a piece, pulls,
  splits, plays); (3) piece peeks (loud, "You can already see it",
  vetoed); (4) hide, rolls of cupped dice and their lines, face, flip, the
  private-piece rule (§5j cases 5, 6, 8, 9), claims, group hide; (5)
  `byVis` on a seat change (a sit, `t.setSeats`); (6) MIGRATE[5] and the
  load gate; (7) two seeded runs of 500 ops with three viewers and
  Mallory: every viewer's folded view equals its own snapshot and holds
  the full form of exactly what it sees, and no body Mallory gets carries
  a hidden piece's `t`, `f`, `vis`, an override or a face label she was
  not shown (`leak`, `labelsShown`, `scanT`); (8) the export round trip of
  §5l item 8; (9) the facade on the Worker path (a script, `Veil`, runs
  the call a host's chat names: `t.hide`, `t.reveal`, `t.setVis`,
  `t.canSee`, `t.spawn`'s vis, their TypeErrors), the setup grammar's
  `vis` and `po`, and checkPatch's gate on a patch's `vis`, `pv` and `po`;
  B22 (8 players × 20 vis tiles: a move adds 127 B to its viewer's body, 0
  to the others') and B23 (a 160-vis snapshot for one player: well under
  1 ms).
- **`t-p5-wire.js`** (E2E, every action through `__ct.act` or Mallory's
  raw sends: the UI's buttons are part 2's): Alice hosts, Bob is a guest,
  Mallory a raw peer (final-lib). Cupped dice rolled (Alice's screen draws
  their faces, the others the cup); a gem pulled from the bag straight into
  Alice's rack; Mallory's flip, roll, face, move, claim and hides refused
  (uniformly where it must be), a forged `vis`/`up` ignored, her peek
  answered to her alone and logged; north's unit seen by whoever sits
  north (Mallory, once moved there); Bob's reload (his snapshot carries his
  own full forms); a group hide; and a recursive scan of every body
  Mallory received (no gem type ref or label, no cupped die's face, her
  only override north's unit while she sat there).
- **`h.viewFrom`** folds a body's `vis` overrides as a guest does (an
  override for an id of the same body's `items`, in that body alone).
- **Mechanism changes, no check weakened:** PROTO and STATE_V are 6
  (core-p2's two version checks, core-p3's and core-p4's MIGRATE checks
  now run the chain through MIGRATE[5]; t-p4-wire's resumed state is
  `STATE_V`); hide is a ruled action and a group op, so core-p3's §10.1
  list gains it and core-p4's malformed-group checks use `shuffle`, an op a
  group still doesn't know, where they used `hide`.

## Phase 5 (part 2: private material on the screen and in the terminal)

- **`t-p5-private.js`** (E2E, §5l's t-p5-private and §5j's attacker cases
  1–9 and 11 through the UI): Alice hosts on a desktop (mouse, Shift+click,
  keys), Bob plays on an iPhone 13 (p4m-lib's CDP taps and finger drags;
  held upright, then sideways by `setViewportSize(844 × 390)`), Mallory is a
  raw peer seated east. Its test box, "Privy table", has a rack per seat
  (`owner: 'board'`, the board owned by `seat:south` / `seat:north`, the
  north one turned 180°), a rack nobody owns, north's screen (`'keep'`),
  bones (domino-like tiles, faces of pips) under one back, dice under a cup
  back, units, a coin with no back and a bag "Boneyard"; fixed ids (`ID`).
  `drawn(p, id)` reads what a screen draws of a piece (its 🙈 badge, the
  `.veiled` corner, its tooltip, a face or a back), `zoneOf(p, board)` a
  board's private-zone labels and the colour of its hatch (its `<pattern>`),
  `barOn(p, id)` selects one piece alone and returns its bar's buttons,
  `malTries(actions)` sends Mallory's actions and returns the notices they
  bring her. Sections: (1) the cup — 🙈 Hide on a die cups its handful, the
  badge, corner and tooltip on Alice's screen alone, 🎲 Roll under the cup
  (Bob's screen tumbles the backs: a MutationObserver records `.tumble`),
  a group roll of two cupped and two shown dice ("rolled 4 dice (2 hidden):
  a · b", case 11), Mallory's flip, roll, face, move and claim (case 8),
  Reveal from the bar and from the group bar, H; (2) racks — the labels on
  each screen ("🔒 Your rack", "🔒 Bob's rack", "🔓 Nobody's rack") and the
  hatch in the owner's colour, 🔒 Draw to my rack by mouse and by touch
  (each piece in a free slot of its own), Bob's finger drag off his rack
  (face up for both), a group 🙈 Hide by Shift+click that never sends the
  coin; (3) Bob's Peek (the overlay, its caption and pips, the loud line)
  and Mallory's cases 4, 5, 6; (4) seat refs (case 3: Bob's unit behind
  north's screen and his cupped die; Bob stands up, Mallory sits north —
  she gets north's unit and north's rack tile, never the die; the labels
  follow the seat's holder); (5) the phone held sideways — a rack tile's
  Reveal and 🙈 Hide in view and 44 px tall; (6) a rules script (cases 9,
  11 and 7: `t.hide` for `seat:north` with no owner, `t.roll` of a cupped
  die, a `validate` that vetoes peek); (7) the recursive scan of every body
  Mallory got (no `t`/`f` of Alice's rack tiles, of Bob's die once cupped
  or of Alice's dice while cupped; overrides only north's while she held
  it; no `pips` key; her one peek answer her own; her view in step).
  Screenshots: `shots/p5-cup-desk.png`, `p5-racks-desk.png`,
  `p5-racks-phone.png`, `p5-bar-landscape.png`. Case 10 (the order of
  Veiled Ranks' hidden units) needs the demo: part 3's.
- **`t-p5-cli.js`** (cli.js and cli.py in parity, §5i): to a fake tab,
  `hide <id…>`, `reveal <id>`, `peek <id>` and `group hide <id,…>` send
  exactly their commands from both REPLs, a line with no id prints the same
  usage and sends nothing, both helps list them alike, `table` marks a
  piece hidden from the others ("🙈 hidden from others") in the same words,
  and the Bridge API's `hide(...ids)` / `hide(*ids)` and `reveal(id)`; then
  real tabs (Alice hosting on cli.js, Bob on cli.py, box "Cupboard"):
  Alice's `hide` (her snapshot: the dice whole, `hiddenFromOthers: true`;
  Bob's: `{kind: 'hidden'}`), Bob's `peek` ("✉ peek: <face> d6" in his REPL,
  the line in Alice's), Alice's of her own (said at once, no line),
  `reveal` (and a second one said in the terminal), Bob's `hide` of a coin
  refused and his `group hide` skipping it.
- **Mechanism changes, no check weakened:** `t-p2-pieces.js` checks each
  piece's bar for exactly its buttons; Phase 5 adds 🙈 Hide to a shown
  piece whose type has a back (the chit, the hand tile) and Peek to a piece
  hidden from the player (the hidden die, token and chit stack), so those
  five expected lists gain `hide` or `peek` (spec §5g). A hidden piece's
  Flip now reads "Reveal" (the same `data-cmd="flip"`).

## Phase 5 (part 3: the demos, Dominoes and Veiled Ranks)

No suite of its own: `t-p5-demos.js` (§5l) and §5j's case 10 are the test
author's, written from the spec after this part. What it needs, by name
(`templates.js`; SPEC §9 D269–D275):

- **Where they come from.** `BOXES.dominoes` and `BOXES.ranks`, and two
  `GAMES` box entries, `k: 'dominoes'` and `k: 'ranks'` (🎲's
  `#games-list [data-game="dominoes"]` and the game strip; 📦's
  `#box-builtins [data-builtin="dominoes"]` / `"ranks"`). Both bring their
  rules: a set up from either is one `loadBox {box, setup, clear, rules:
  true}` (no trust dialog: built in), its rules running as `rules.box`, and
  🎲 marks the game playing (`#games-list .on`) while they run. The box
  names its seats `south` (bottom) and `north` (top); on loadBox the players
  are seated in the seats' order as core decides, which is not always the
  joining order (a run had Carol north and Bob watching): seat them with the
  host's `{t: 'seat', p, id}` / `{t: 'seat', p, watch: true}` as
  t-p5-private does.
- **Dominoes.** A 1000 × 1500 table, seats South (`#f59e0b`) and North
  (`#38bdf8`). Types: `rack` (a board 600 × 258 — two rows of nine slots,
  the second fix-up, D294; it was 1000 × 1300 and 600 × 140 — one zone `tiles` covering
  it, `owner: 'board'`, `private: 'reveal'`; laid by `forEachSeat` with
  `owner: 'seat'`, so the racks are owned by `seat:south` and `seat:north`,
  locked) and 28 tiles `t<a><b>` (0 ≤ a ≤ b ≤ 6: `t00` … `t66`), each a
  `tile` named "Domino", 60 × 120, `back: 'bone'`, `stack: 'none'`,
  `hand: false`, one face `{pips: [a, b], name: 'a|b'}` — the log calls a
  shown tile "3|4". A bag named "Boneyard" (`kind: 'bag'`) of the 28, face
  down, at [24, 700]. Script name "Dominoes"; `t.data`: `{dealt, turn
  (a seat id, 'south' | 'north', or null), lead (a seat id), played (the
  ids played this round), passes, taking}`; `public.turn` the holder of the
  seat to move (the fix-up, D284: it was a pid).
  - Buttons: `deal-<pid>` "Draw 7" for each seated player before the deal;
    `pass` "⏭ Pass" for the player to move once the boneyard is empty;
    `new-<pid>` "♻ New round" for the host during a round, and for the
    players and the host once it is over.
  - Draw 7 pulls seven tiles into each rack at its slots `(rack.x + 6 +
    66k, rack.y + 6)`, k = 0–6 — the slots 🔒 Draw to my rack fills
    (app.js `rackSlot`), two more left free (k = 7, 8). Each lands up
    false, `vis: ['seat:<s>']`, `pv: 1`, owned by `seat:<s>` with `po: 1`.
    "📣 {name} leads" (drawn by lot: one "used randomness" line), then the
    lead goes round, a round each.
  - A play is the move that takes a tile off its seat's rack, on that
    seat's turn (validate notes it, `taking`), once the tile lies on the
    table face up: the turn passes to the other seat; a line tile moved
    again passes nothing. A rack emptied (tiles counted where they lie):
    "📣 {name} plays the last tile — domino!" and 🏆 (`t.win`). Every seat
    passing in a row: "📣 The line is blocked — every rack shows its tiles:
    the lowest count wins". At either end every tile left on a rack is
    revealed. New round: "removed N items…",
    "made the bag Boneyard (28 pieces)", "A new round: the tiles are back in
    the boneyard".
  - Refusals (notices): "🚫 It's {name}'s turn" (a pull from the boneyard,
    or a tile of your own rack set down off it, out of turn — rearranging
    your own rack is never refused), "🚫 Press Draw 7 first", "🚫 The round
    is over — ♻ New round to play again", "🚫 No peeking at hidden tiles"
    (every `peek`), "🚫 Draw into your rack (🔒 Draw to my rack)" (a pull
    landing elsewhere), "🚫 Play a tile by moving it off your rack" (a
    flip, a bag, anything but a move or a turn of a rack tile), "🚫 Tiles
    hide in your rack" (every `hide`), "🚫 That tile is on {name}'s rack"
    (another seat's shown rack tile; a hidden one gets the engine's
    uniform refusal), "🚫 Keep to your own rack", "🚫 That tile is
    played"; a told "Dominoes needs two seated players and a full
    boneyard".
- **Veiled Ranks.** A 1160 × 1560 table, seats South (`#d97706`) and North
  (`#2563eb`). Types: `field` (the board: 1040 square, `primary`, a 10 × 10
  square grid of cell 100 at (20, 20), chess labels a1–j10 with a1 South's
  left corner; zones `north` — board-local y 0–320 — and `south` — y
  720–1040 —, `owner: 'seat:<id>'`, `private: 'keep'`) and per side the
  units `s-<unit>` / `n-<unit>`: `banner` (1, rank 0, label "⚑"), `crown`
  (1, 4), `blade` (2, 3), `pike` (3, 2), `lancer` (2, 1, label "1»"),
  `herald` (1, 1, "1✉"), `trap` (2, rank null, "✕"); tokens, rect 80,
  `upright`, `back: 'south'` / `'north'` (◆ on the side's colour), one face
  `{color, label: the rank or glyph, text: the unit's name, name: "South
  Crown" — the log's name for it shown}`, `meta: {side, unit, rank}`, type names
  "South Crown" …. The setup: the field at the centre, then a `group` with
  `shuffle: true` per side of twelve piece entries, each `up: false` and
  `owner: 'seat:<side>'`, at c1–h1, c2–h2 (South) and c10–h10, c9–h9
  (North); each lands in its zone: `vis: ['seat:<side>']`, `pv: 1`, its
  owner the seat's own (no `po`). A quick Node check over 400 fresh setups
  found every per-position guess (z order, key order, square) at 0.250, the
  constant guess's.
  - Script name "Veiled Ranks", strict, `onSelect`. `t.data`: `{box (its
    box id), phase: 'deploy' | 'play' | 'over', ready: {south, north},
    turn: 'south' | 'north'}`; `public.turn` the side to move's holder
    during play; `public.badges` `{pid: '⏳ Deploying' | '✓ Ready'}`
    during deployment.
  - Buttons: `ready-south` / `ready-north` "✓ Ready" for each side's
    holder while deploying (both: "📣 The ranks are set — South moves
    first"); `new-<pid>` "♻ New game" for the two players and the host
    once it is over (`t.layout` lays both armies out again: "placed 24
    items of «Veiled Ranks»", "📣 Deploy your units in your three rows,
    then ✓ Ready").
  - Hints: a pick (a tap on a phone, a click on a desktop) of one of your
    units hints, while deploying, every square of your three rows but its
    own; in play, on your turn, its legal squares; else none.
  - Moves are drags (`move` with `a.to`): deploying, within your rows
    (onto one of yours, the two swap: two "moved a hidden piece" lines);
    in play, one square along a rank or a file, a Lancer one or two with
    its first square empty — onto an enemy is an attack. The script moves
    every unit `{unzoned: true}`: it keeps how it is seen wherever it lands
    (one line, "moved a hidden piece e3 → e4" or "moved South Crown b7 →
    b8").
  - Lines, each announced (📣, a banner on every screen): "{Side Unit}
    parleys with {Side Unit (r)} at {sq}: both stand revealed", "{Side
    Unit (r)} springs {Side} Trap at {sq}: both are lost", "{A (r)} beats
    {B (r)} at {sq}", "{A (r)} and {B (r)} fall together at {sq}", "{A
    (r)} takes {Side}'s Banner — {Side} wins", "{Side} has no unit that
    can move — {Other} wins", "Neither side has a unit that can move — a
    draw" (no 🏆); at the end every unit still hidden is revealed
    ("revealed N pieces: …") and 🏆 goes to the winner's seat.
  - Refusals: "🚫 Deploy inside your three rows", "🚫 You're ready — wait
    for {Side}", "🚫 Only the two players move the units" (a watcher),
    "🚫 That's not your unit", "🚫 Drop the unit on a square of the
    board", "🚫 It's {Side}'s turn", "🚫 The Banner never moves", "🚫 A
    Trap stays where it was set", "🚫 That square holds one of your own",
    "🚫 Units move along a rank or a file, never diagonally", "🚫 One
    square at a time", "🚫 A Lancer moves one or two squares", "🚫 A
    Lancer's first square must be empty ({sq})", "🚫 The game is over — ♻
    New game for another"; strict's "🚫 Not a move in this game" for
    anything but a move (a peek, a flip, a 🙈 Hide). While the unit moved
    is hidden, a refusal is its player's alone (D282): no "blocked" line,
    nothing re-sent to the other screens.
- **Mechanism changes, no check weakened:** `t-fun-games.js` checks that the
  game strip offers every shipped game, in order, and that the 🎲 dialog
  lists them all: the two box games join the list after Backgammon (15
  entries, was 13). `t-p4-hexplay.js` reads the "rolled 2 dice" line on the
  host's screen, so it now waits (up to 5 s) for the other player's view to
  show the same faces before the same equality check: the roll's patch could
  still be on its way (it failed once that way in a full run).
  `t-p5-private.js` section 4 waits for the host to see Bob stand up before
  Alice seats Mallory north: Bob's `seat` is a guest's action still on its
  way, and north still his was "🚫 That seat is taken" (once, in a full run).

## Phase 5 (the test author's core sections: `core-p5.test.mjs` (1′) to (CP′))

Written from spec §5 (with §0.1, §2c, §2d, §3a, §3f.6, §4a, §4c) and
D249–D262, apart from the implementation: they share only node-lib, `RECT`
and the console helpers with the sections above.

- **`stage(o)`**: a room as app.js runs one — the host table, Alice (host,
  south), Bob (north), Carol (east), Dave (watching), box `o.def` set up and
  seated by the host, `o.prep` after (VAULT's: rackB given to Bob by his
  id). `S.job(p, a)` runs a job where app.js runs it (the mirror while rules
  run: a patch the host refuses lands in `S.refused`); `S.api(fn)` calls the
  facade as a hook would and returns `[value, lines]`; `S.tick()` is one
  broadcast tick (`{d, patch, out}`: one shared text, each peer's own part
  spliced on, each body folded); `S.fresh(p)` a full snapshot's view.
  Seeded (`o.seed`, `o.prefix`): every run is the same.
- **The oracle**: `veiled(H, V, it)` is §5a's rule off the host state (seat
  refs resolved to whoever sits there, `sitter`); `expectView(H, V)` is
  what V must hold of every item (the shared form, or for a piece whose vis
  names V that form shown with `up: false` and its vis); `formProblem`
  checks a shared form against §5d (a hidden piece `{k, b, x, y, rot, z,
  n?, owner?, lock?, at?}`, no vis/pv/po on anything, a bag without `of`);
  `audit(S, out)` checks every body of a tick (shared forms, overrides only
  beside their item and only for a viewer the vis names, places, markers)
  and every folded view against `expectView`; `tickOK` ticks and audits.
- **Boxes**: VAULT (racks with a `'board'` zone — two south's, one Bob's by
  id, one nobody's, one north's —, north's `'keep'` screen, a zone of a seat
  the table lacks, an owned zone that isn't private, a grid board, tiles,
  gems, dice under a cup back, units, a ×3 stack, a coin with no back, a
  bag, two supplies, a pile of hidden pieces; fixed ids `VID`) and MANY (the
  fuzz's: 22 pieces each of a type of its own, every face labelled
  `Qx<nn><a–f>`, so a label or a type ref in a body names one piece).
- **Sections**: (1′) every row of §5d for all four viewers, t.canSee, a box
  missing, hands, piles, per-message overrides; (2′) private zones —
  entering with and without a back, a `'board'` zone owned by a pid, reveal
  versus keep, one owner's two zones, another owner's (a po owner follows, a
  real one stays), inactive zones, a seat's zone while its seat is empty,
  board moves firing nothing, deals, takes, splits, plays, group moves,
  t.spawn and t.move into zones; (3′) piece peeks (loud, no owner asked, a
  pile top, "You can already see it", vetoed, strict and `allow`); (4′)
  hide (po on an unowned die only, vis the actor's id), flip clearing both,
  the private-piece rule (uniform refusals, an owner outside the vis),
  roll lines, forged fields, group hide; (5′) a seat changing hands by
  every path (the host, the player, two at once, a join, t.setSeats);
  (6′) MIGRATE[5] and saves; (7′) two seeded runs of 500 ops (rules off,
  rules on through the `VEX` script), every tick audited and scanned for
  labels and type refs the viewer couldn't see (`sight`), every peek its
  asker's, each view equal to its snapshot at the end; (8′) the setup
  grammar's vis and po laid out, then the export round trip into a fresh
  room (and three cases beyond §5l's list, each a piece hidden for a seat
  whose zone would say otherwise on import: a rack tile whose rack moved
  away, one on a rack given away since, one a script set for another seat
  with t.setVis); (CP′) honest private jobs taken
  by checkPatch, forged ones refused whole; (B22′) and (B23′).
- **Checked against broken copies of core.js** (scratch only, never
  committed): the shared form carrying `f`, no `byVis` touch on a seat
  change, the log naming private pieces, a vis piece's move sent as a place,
  overrides for everyone, the private-piece rule gone, `hide` without `po`
  — each fails several of these sections.

## Phase 5 (the test author's private-material suites, written from the spec)

Written from spec §5l t-p5-private (items 1–4), §5j (attacker cases
1–11), §5a–§5i and D249–D276, apart from the implementation's own
t-p5-private.js, t-p5-cli.js and t-p5-wire.js (whose names they don't
reuse). Every expectation is the spec's; the implementation was read only
for hooks and selectors.

- **`p5v-lib.js`**: `spy(env, invite, peers)` is final-lib's Mallory (a raw
  peer) with readers — `bodies()` (her `state` bodies, unwrapped, in
  arrival order), `notes()`, `others()` (every channel but the public
  catalog's), `count()`, `said(from)`, `tries(actions)` (sends them and
  returns the notices they bring her, after 2.2 s: the host sends a peer 10
  notices, then 5 a second, §0.1) and `hello(from)` (keyed hellos until a
  snapshot addressed to her arrives: after a host reload or a demotion);
  `scan(v, tokens)` (every key or string holding a token, at any depth);
  `told(bodies, ids)` (every record of those pieces that says more than
  §5d's reduced form `{k, b, x, y, rot, z, n?, owner?, lock?, at?}`, and
  every per-recipient form of them); `drawn(p, id)` (what a screen draws of
  a piece as a player sees it: its text, a 🙈 shown on it, the hatched
  corner's class, its tooltip); `screenText(p, ids)`; `watchTumbles(p)`;
  `bound99(p, n)`.
- **Tokens.** Each box gives every face of what Mallory must never learn a
  label, name and text found nowhere else (`Qa1`…, `Qt01`…, `Qu7x`, `Kd3`…),
  so a body that names one is caught by text, wherever it hides (a log
  line, a notice, a record) — and by type ref (`<box>/<type>`, each such
  type used by those pieces alone).
- **`t-p5-veil.js`** (E2E): Bob hosts on a desktop, Alice plays on an iPhone
  13 (held upright, and sideways in section 3), Mallory is a raw peer seated
  East. Box "Veil test" (original): racks South and North (`'reveal'`),
  South's screen (`'keep'`), Alice's three dice (`Qa…`), Bob's die (`Qb…`),
  two plain dice, tiles in two bags (Amber's `Qt…`, Blue's), loose tiles, a
  face-down tile nobody sees (`Qf9z`), units, a coin with no back; fixed
  ids (`ID`). Sections: (1) Alice's cup from her phone's bar (the handful,
  D264), the 🙈 badge, the hatched corner and the tooltip hers alone, the
  bars (hers: Reveal, 🎲 Roll; Bob's: Peek), two rolls under the cup (Bob's
  screen tumbles the backs, hers shows the faces, "rolled 3 hidden dice");
  (2) Bob's cup on the desktop, rolled and revealed — the face on both
  screens, the line naming it once public; (3) on the phone held sideways,
  ⬚ and taps: a group roll of two cupped and two shown dice ("rolled 4
  dice (2 hidden): a · b", case 11), a group 🙈 Hide, Reveal from the bar;
  Bob's group 🙈 Hide by Shift+click never sends the coin; (4) "🔒
  {name}'s rack" / "🔒 Your rack" and the hatch colours, 🔒 Draw to my rack
  on both screens (slots of their own, hidden for the seat, po), a tile
  dragged off Bob's rack (face up for all), Alice's unit behind her screen
  and out again (still hers alone), Bob's Peek (the overlay, its caption,
  the loud line) and Alice's on the phone; (5) Mallory's tries — case 4
  (move, flip, peek of Alice's rack tile), case 5 (hides), case 6 (forged
  vis/up/pv/po/owner on a move), case 8 (flip, roll, face, move, claim of
  the cup; the dice unchanged in the host state), and the same words for a
  roll or face of a hidden tile or unit; (6) a seat change (Bob stands and
  sits: north's rack tile his only while seated), a host reload (Alice's
  cup and rack hers again, with 🙈) and a demotion (the invite opened in a
  second tab of Bob's browser, whose Trystero id is made to start with "z"
  so a tie goes the same way each run; the staying tab is the one holding
  the table, the other a viewer, for 2 s on end); (7) export and import
  through 📦 (the file: `#k` for players, no pid, no `pv`; set up again:
  every private piece's type, face, up, vis, owner, pv and po as before);
  (8) Alice leaves, Mallory takes South (case 3: South's rack tiles and
  unit become hers to see, Alice's cup never; the rack's label follows);
  (9) a script (cases 9, 11, 7); (10) Mallory moved off South (the reduced
  forms again: an override lasts one message) and the scan of every body,
  notice and other message she got, window by window (what was hidden from
  her when), plus no `pips`, no override outside her time at South, no log
  line naming a hidden piece, her view in step, and the host's own screen
  showing none of it. `UPTO=n` stops after section n (to develop).
  Screenshots: `shots/p5v-*.png`.
- **`t-p5-veil-cli.js`** (E2E, §5i): Alice hosts with cli.py, Bob is a guest
  with cli.js (each tab's posted snapshot kept as the bridge reads it), box
  "Cubby": Alice's `hide` (hers whole with `hiddenFromOthers: true`, Bob's
  `{kind: 'hidden'}` with its place and owner alone, no token or type ref
  in his items), `table`'s "🙈 hidden from others", Bob's `peek` ("peek: …"
  in his msgs alone, the line in Alice's REPL), Alice's own peek at once
  with no line, `reveal`, Bob's tile hidden, peeked by Alice and revealed,
  his hide of the coin refused in his msgs, and the Bridge API's
  `hide(*ids)` in both languages (a fake tab).
- **`t-p5-bones.js`** (E2E, cases 2, 4, 7 on the shipped Dominoes): Bob
  picks it from 🎲 on a desktop, Alice plays on an iPhone 13, Mallory
  watches. Draw 7 from Alice's phone fills both racks, each player's faces
  with 🙈 on their screen alone; no body Mallory gets carries a rack tile's
  type, name (`a|b`) or pips, nor any override; the script's validate
  vetoes Bob's Peek and hers (no overlay, no line, no answer); her move and
  flip refused; the leader plays a tile (public), the thirteen left still
  nothing of hers.
- **`t-p5-order.js`** (E2E, case 10): 20 fresh rooms (a new host context
  each) set up Veiled Ranks with its rules; a fresh Mallory in each keeps
  her first snapshot and reads North's 12 hidden units (by their back): z
  order, key order, ids, squares. Her guessers — the box's declared order
  (z, key, id) and squares, and the rank most often at a place in rooms
  1–10 guessed in rooms 11–20 (a leave-one-out tally was dropped: it ties
  each room's guesses to the others' and went over the binomial bound 4 %
  of the time in a simulation of the null; the split, 0.07 %) — score at
  most 0.25 + the 99 % binomial margin. Her first snapshots name no North
  type and carry no `meta`.

## Phase 5 (the test author's demo suite: `t-p5-demos.js`, written from the spec)

§5l t-p5-demos and §5j case 10, from §5a–§5g and D269–D273; the
implementation was read for hooks and selectors alone. Alice hosts on a
desktop (mouse), Bob plays on an iPhone 13 (p4m-lib's CDP finger drags and
taps; upright, and sideways for one move). Each guest gesture is followed by
`hostSees(host, fn)` — the expected effect in the host state, then an idle
queue — before anything is read: a guest's action reaches the host a moment
after its gesture ends. About 35 s alone; not serial (no timing budget).

- **(0) the boxes as §5g has them** (cleanBox's form, in Node): Dominoes'
  28 tiles one per pair (pips, 60 × 120, one back, quarter turns, no hand),
  the boneyard bag of 28 face down, the rack a board whose one `'reveal'`
  zone covers it, one per seat; Veiled Ranks' primary 10 × 10 chess-labelled
  field, its two `'keep'` screens (rows 1–3 South's, 8–10 North's, by cell
  centres), each side a shuffled group of 12 face-down tokens under its own
  back in §5g's composition and ranks, and no commercial game's rank names
  (Marshal … Sergeant, Scout, Miner, Spy, Bomb) in its names or script.
- **(10) case 10** (Node, through core.js): 20 fresh tables, each seeded
  (`stream(seed)`: sha256 in counter mode drives `random` and the 8-hex ids,
  so every run draws the same tables); the host sits North, Mallory South;
  her first snapshot is the very text the broadcast builds (`snapContent`,
  `mine`, `sharedText`, `spliceBody`). Checked: its items in sorted-id order,
  North's 12 their back alone. Guessers of a unit's rank: the box's
  declaration by z order, by key order and by square (240 guesses each), and
  per feature value — z rank, key rank, id rank among all keys, square, the
  id's first digit — trained on tables 1–10 and scored on 11–20 (120 each).
  Each must stay within the binomial bound at 1 − 0.01/8 over the best
  constant guess (3 of 12): Bonferroni, so the family is at 99 % and a sound
  engine fails less than once in a hundred samples. A planted leak (z in
  declaration order) must score 240/240 (the test can see one).
- **Dominoes** (D1–D6): from 🎲 (marked playing, D269); each rack "🔒 Your
  rack" / "🔒 {name}'s rack" and hatched in its seat's colour; Draw 7 by
  Bob's tap: seven tiles in each rack, wholly on it, none over another, each
  `up: false`, `vis: ['seat:<s>']`, `pv`, owned by the seat with `po`; the
  boneyard 28 → 14 in the views and on the bag; each player's own pips
  drawn (lit pips = a + b) with 🙈, the other rack backs; the player to move
  drags a tile to the table — face up for both, no vis, pv, po or owner —
  and the turn passes; the other draws with 🔒 Draw to my rack (14 → 13,
  hidden for that seat, in a free slot) and plays; out of turn a tile off
  the rack and a draw are refused (D271); every body Bob got never carries
  Alice's hidden tiles' t, f, type refs or names, nor any `pips` key.
- **Veiled Ranks** (V1–V10): from 📦's Built in; each army behind its screen
  (the host state, both views, the drawn faces with 🙈 and backs, "🔒 Your
  screen" / "🔒 {name}'s screen"); deploying a swap and six moves on the
  desktop, three on the phone (each still face down behind the screen,
  both screens in step), outside the rows refused on both; ✓ Ready — Alice's
  deployment then locked (D273) — then Bob's; refused with nothing changed:
  a move out of turn, a diagonal, two squares for a Crown, the Banner, a
  Lancer three squares, a Lancer through its own Pike; a legal step (off its
  screen it stays hidden: `keep`); the Lancers' two-square moves (North's
  with the phone sideways); a Herald's parley (both face up on both screens,
  neither removed, the Herald where it was); an attack (the Crown beats a
  Blade: the Blade gone, the Crown face up, both named in each log); a
  revealed unit moving on stays revealed; a hidden South Lancer stepping into
  North's rows stays South's alone (D273's `step`: no body of that move, nor
  any before its reveal, gave Bob its face or an override); a Trap attacked
  (both gone); the Banner taken (🏆 on Bob's seat label on both screens,
  every unit left face up); the scan of every body Bob got before the end
  for the South units still hidden then. North marks time with a unit away
  from every square in play, so the plan runs whoever moves first.
- Checked against broken copies of the app (scratch only, served with
  `APP_ROOT`): `step()` without its `setVis` (5 checks fail), the armies'
  group without `shuffle` (6, case 10's among them), patch overrides sent to
  every player (20). Screenshots: `shots/p5d-*.png`.

## Phase 5 fix-up (the review's findings)

SPEC §9 D277–D292, the second fix-up's D293–D296 and the third's D297–D299.

- **`core-p5.test.mjs` section (F)**, in the implementation's own runner
  (`testFixup`), with `demo(box, units?)` — a built-in box set up with its
  rules in this file's `room()` (the app's `enable` effect started by hand:
  `enabled`), Alice south, Bob north, optionally a Veiled Ranks position —
  and `since(R, p, k)`, every body p got since its k-th:
  - (F1) a zone never widens who sees a piece (D277): Bob's move, and a
    group's, of South's unowned private unit onto his rack refused
    uniformly, nothing shown him; Alice (who sees it) hands South's tile
    to Bob's rack; a screen keeps a private piece South's for a person's
    move and a script's; a shown tile behind the screen hides as before.
  - (F2) the private-piece rule on stack (either side), toBag, toHand, a
    claim and a split onto a bag (D280); Alice may bag her own.
  - (F3) six pulls from a bag of coins and tiles into Alice's rack, none
    refused: the coins shown, the tiles hidden (D278).
  - (F4) a hidden die and a hidden token under one back set on cells: no
    address, alike to Mallory; hiding drops a token's address, revealing
    gives it back (D279) — `SNAPBOX`.
  - (F5) a `QUIET` script vetoes moves with the piece's face label in its
    words: Alice's move and group move of her cupped unit refused with no
    log line and a `back` effect to her alone; its live drag relayed to
    nobody; Bob's and Mallory's bodies never name it; a shown tile's veto
    public as before (D282).
  - (F6) Veiled Ranks exported with a hidden South unit in North's rows
    and a revealed one in South's: written as they lie (`unzoned`), every
    unit's up, vis, owner, pv and po the same in a fresh room, North still
    seeing the back; a rack tile of a player who stood up goes hidden from
    everyone (D283).
  - (F7) Dominoes by seat: the turn a seat, refusals of a flip, a hide and
    a draw off the rack, the engine's words for another seat's tile, a seat
    taken over mid-round, a play, a nudge that isn't one, a played tile kept
    off the racks, a domino that reveals the tile left (D284).
  - (F8) Veiled Ranks: a refused Banner step draws it back on Alice's
    screen alone (`back`), a legal hidden step has no `back` (the patch
    carries it, D293), a hidden step one line, an outcome announced, a
    revealed unit logged by name, a stalemate of the side to move a loss,
    of both a draw; each kind its own label, its face named (D285).
  Against the code before the fix-up the section fails 28 times (and its
  `back` check once against the code before the second fix-up).
- **`t-p5-fix.js`** (E2E, ~60 s; Alice hosts on a desktop, Bob on an
  iPhone 13): (1) Dominoes from 🎲 — each tile's two `.pips2 > .pips`
  boxes apart on both screens (D291), then the player to move draws the
  whole boneyard (14 times 🔒 Draw to my rack): 21 tiles at 21 places on
  the two-row rack, each hidden at most half by ALL the tiles above it
  (the sum by z, not pair by pair), every one wholly on the rack (the
  rack's size read from its type) (D294); (2) Veiled Ranks — seven labels
  on Alice's screen, a 🙈 unit's `.ptext` in the top half of its face
  (D291), and her drag of a unit out of her rows refused with the unit
  back home within a second while Bob (`__rtc.keep`) receives no body
  naming it and no "blocked" line, then a legal swap that does reach him
  (the control) (D282); then Bob's legal step of a unit of his on the
  phone (reduced motion), its element sampled every frame for 2.5 s: no
  frame off its new square once his finger set it there (a `back` that
  outran the patch drew it on its old square for a frame, D293); (3) Backgammon's dice wear a cup, and 🙈 Hide over
  a handful with a locked die cups the other alone with no refusal (D286,
  D290); (4) a wheel over the 🔒 For you card scrolls it, the table's
  transform unchanged (D289). Shots: `shots/p5fix-*.png`.
- **`t-p1-bench.js`, a board-text B4 row** (D288, D297): 1,000 ×3 stacks
  with a chess-labelled board and a rack (its private zone's label) on the
  table (`loadStacks(…, extra)`): the pinch under B4's budgets — no long
  task over B4_LONG while the fingers are down, the rAF p95, B4_LAYOUTS,
  no task over B4_SETTLE at the lift, as every row — then sixteen
  synthetic wheel turns on the phone: at most B4_LAYOUTS layouts, the
  board's text drawn at every turn and at the wheel's rest (`.btext`: no
  `visibility: hidden`, a box). (With D288 the text was SVG, hidden while
  the view moved — `display: none` at every turn, which this row checked —
  and the second fix-up gave the pinch B4_SETTLE's budget, D295: a relaxed
  budget, not a mechanism change. D297 puts it back on B4_LONG.)
- **Mechanism changes, no check weakened:** `core-p4.test.mjs`'s D210 check
  reads, for the tokens of a shuffled group under a die's back, that each
  place keeps its spot with no address (D279: a hidden piece under a back a
  die wears never snaps; it read the address before). `t-p5-bones.js` waits
  for Alice's view to hold each tile before reading it (`v[k] && …`: under
  load it threw on an id not there yet) and reads the player to move from
  `public.turn` (D284: `t.data.turn` is a seat now). `t-p5-veil-cli.js`
  keeps every msg its tabs' snapshots carried (`msgs(name)`): a msg rides
  one snapshot, and the next, ≤ 500 ms later, goes without it — reading
  the latest alone missed Alice's peek under a full run's load.
- **The second fix-up (D293–D296), mechanism changes:**
  t-p5-fix §1's coverage check became the stricter aggregate one and reads
  the rack's size from its type (it hard-coded 600 × 140); t-p1-bench's
  board-text row took B4_SETTLE while the fingers were down (D295) — a
  budget relaxed from B4_LONG, not a mechanism change, which D296 filed it
  as (corrected by D299; the third fix-up puts it back); `t-p4-select.js` waits for the
  inspector to open before reading its box on the sideways phone (under
  run-all's load the tap was handled after Playwright's returned, and the
  box was read closed).
- **The third fix-up (D297–D299).** New: `t-p1-bench.js`'s half-turned row
  (D297), the reviewers' flow on the bench phone — Pat seated North (his
  view turned 180°) over Dominoes, its rules on, Draw 7, three pinches
  deep in (from the fit, 20 → 160 px apart; the first not measured), then
  Veiled Ranks and four pinches, each under B4's budgets (no long task over
  B4_LONG while the fingers are down, the rAF p95, nothing over B4_SETTLE
  at the lift, B4_LAYOUTS); before D297 the Veiled Ranks pinches started
  with a 52–91 ms task. It runs last in the suite (D300): Veiled Ranks'
  named seats put Bob among the watchers and Pat North — in the third
  fix-up it ran before the card part, whose rows all ran on those seats.
  Restoring the seats taken on joining would take a seatless box (a type
  of its own: `cleanBox` refuses `types: {}`), everyone to the watchers,
  then `sit` in join order (`assignSeat` gives a round table's first 90°,
  then 270°, then 180°: D310); the row runs last instead. Mechanism changes, no check weakened:
  `boardTexts` reads the HTML text (each span's screen map from three
  probes, where `getScreenCTM` read an SVG text's); the label selectors of
  t-p2-pieces, t-p2-demos, t-p2-tables, t-p5-demos, t-p5-private,
  t-p5-veil and t-p1-bench (`.btexts .btext`, `.btext.coord`,
  `.btexts .slabel`; a file's `y` is its span's `top`); t-p1-bench's
  board-text row back on B4_LONG and its wheel asking the text drawn (it
  asked it hidden: the mechanism D297 removed). `t-p4-fix.js` §7 waits for
  each pick to show before reading the selection (`picked(p, n)`, as
  `t-p4-select.js` does since D296: Carol's taps were read too soon under
  run-all's load) and stamps the bar's buttons going off and on in the
  `disabled` setter itself rather than in a MutationObserver's callback,
  which runs once the task that armed the bar is done — late under load,
  so the hold-off read 390 ms once; it now reads the timer's own 400 and
  asks ≥ 399 ms (it asked ≥ 390). `t-p1-bench.js`'s `tapOne` taps each
  item at the point of its face farthest from any ×N badge, where it
  tapped its centre: on the phone's fit of 1,000 ×3 stacks each badge,
  grown 3×, covers its own stack's centre, and a tap there opens the
  inspector — all twelve tries did in three full runs (the twist with a
  stack's bar open).
- **The fourth fix-up (D300).** New checks: `t-p2-pieces.js` asks a
  board's one text layer `aria-hidden`, as its SVG is, on both screens and
  devices, and `t-p5-private.js` every rack's and screen's (the layer
  D297 made was read out by screen readers, every coordinate of every
  board); `t-p1-bench.js`'s card part begins by checking the seats are
  as the players took them when they joined, no named seats
  (`seating()`, read after the three join). Mechanism change: the
  half-turned row moved after B11, the last in the suite (it leaves the
  players in Veiled Ranks' named seats); no check changed.

## The final review's fix-up (D301–D310)

SPEC §9 D301–D310. The harness drives Chromium only: what WebKit does
differently (a cancelled touch loses its click, no constructable
stylesheets before 16.4, a pagehide's IndexedDB write that never commits,
alpha 254 in a downscaled photo) is checked by making Chromium do the same.

- **`core-p5.test.mjs` section (F9)** (D301): `t.setFace` over four cupped
  dice, two already at that face, and `t.setVis` over four hidden pieces,
  two of which North already saw: all four marked, re-sent and logged
  alike ("turned 4 pieces: a hidden piece, …"); then §5j case 9's piece,
  hidden for North and nobody's: Mallory's move and group move of it onto
  North's rack refused uniformly ("🚫 That piece is hidden"), North's own
  drag elsewhere keeps it hidden, and North, who sees it, racks it.
- **`t-p3-attack.js`, deep actions** (D302): with the rules on, Mallory
  sends a chat and a turn, each with a junk field 100,000 arrays deep
  (final-lib's `M.deep`): "🚫 Malformed action", the rules stay on (no
  "rules disabled", no chat line), the stone unturned, the Worker ran her
  barrier alone, no stack overflow on the host, the mirror equal.
- **`t-final-sec.js`, the gate** (D302): the same chat with the rules off
  (nothing logged, no error toast); a raw page (`S`) whose seat key is a
  million characters ("🚫 Invalid seat key", no player), then 32 (it
  registers and the save stays under 1 M characters); it leaves and joins
  again under a new player id ("🚫 One seat per connection", no player),
  and is back under its own.
- **`t-p1-flood.js`, the budget is the player's** (D302): after Mallory's
  minute of images, a second connection under her id, then a new one after
  it left, each get 0 bytes within that minute.
- **`t-p1-review-store.js` (9)** (D303): a legacy save written a minute
  after the room's IndexedDB save (the old shape: keys on the players, no
  zMax, a card moved, a deck the newer save added left out) is resumed —
  the host told, the card where the old tab left it, the newer deck and the
  legacy keys gone, the room's catalog the legacy one's — and a reload
  resumes it again from IndexedDB.
- **`t-p4-boxes.js`** (D307): the no-WebP canvas also sets every 1,001st
  pixel's alpha to 254 (`getImageData`), as WebKit's downscale draws an
  opaque photo: still stored as JPEG.
- **`t-final-compat.js`** (new): (1) the version gate both ways
  (D304) — a page whose core.js says another PROTO (`versioned()`, a route
  rewrites it): a newer guest is told to ask the host, and the host is
  told; an older guest is told to reload; a hosting tab of another version
  hears the other host and says so; (2) Bob's box, lost by the host's
  reload, leaves his 📦 when the whole catalog arrives, and he is told
  (D305); (3) the previous `index.html` (no `#box-btn`, `app.js` with no
  `?v=`) with this app.js: the reload banner, no TypeError, no table
  (D306); (4) WebKit's pagehide (D308), simulated by a stand-in
  transaction that never completes from the pagehide on: a move just
  before a reload is kept with no warning and saved once the page is back;
  a deck added just before one (the mark a seq alone) is lost, and the host
  told, as is a move when localStorage is too full for the state (its seq
  is still left pending); (5) browsers (D307): an iPhone tap on a hand card zooms it, its
  pointerdown not cancelled (a mouse's is); the app loads with
  `CSSStyleSheet` throwing "Illegal constructor" and no
  `adoptedStyleSheets`; a `gesturechange` of scale 1.5 zooms the table
  ×1.5; Backgammon's checkers picked (at least two, each clicked where it
  lies on top): on an 800 px screen the one-row bar fits, centred (its two
  gaps within 2 px), and on one 60 px narrower than the bar it overflows
  and starts at ✕; a game box upload calls `navigator.storage.persist()`.
- **`t-p1-bench.js`, two B4 rows before B6** (D309): `dragPiece` — the
  phone drags a token near the screen's middle for 3 s under ×2 CPU
  throttling, a touch pointer moved every frame (the first drag unmeasured):
  it moves (`__ct.drawn(id).tx`), no long task over B4_LONG, the rAF p95
  under B4's limit, at most one layout in two frames (by left/top it laid
  out every frame, twice with the chip); then the host drags 200 tokens
  live for 2 s and drops them, the phone watching: its glides all end
  (`__ct.lives()` empty), no task over B4_SETTLE (652–924 ms before), at
  most B4_LAYOUTS layouts (282 before).
- **Mechanism changes, no check weakened:** final-lib's Mallory installs a
  raw-JSON send (`{__raw: text}` goes out as that text) before Trystero
  loads, which takes `JSON.stringify` as it loads; p3-lib's `preview`
  waits up to 500 ms for the chip to show the spot's address (written at
  most every 150 ms now); t-p1-bench and t-p2-tables find the `--bz` rule
  in `document.styleSheets` (the view sheet is a `<style>` element's now);
  t-fun-motion reads where the card is drawn as its left/top plus its
  translate, compared as numbers (a drag moves it by translate); t-p1-flood
  expects the guest's new wording ("… to a player, 256 MB to all");
  t-p4-boxes skips the whole-catalog mark (`'*'`) among a boxes message's
  ids.
- **`parse.js`** also fails a local import, or `index.html`'s `app.js` or
  `style.css`, without `?v=MODULE_V` (D306: a version left behind on one
  file pairs a cached copy of the previous Card Table with this one).

## The final review's second fix-up (D311–D316)

SPEC §9 D311–D316: play on phones and desktops, the docs, the code.

- **`final.test.mjs`** (new, Node, in node-lib's runner): (1) `endSeats`
  (D311) — Draughts set up for three, one watching; Bo's is refused ("🚫
  Only the host can do that"), the host's leaves no named seats and every
  player seated, logs "removed the named seats: everyone sits where they
  like" and the release of Light's men, which belong to nobody after; a
  second one changes nothing. (2) Dominoes with its rules on (D312): the
  host's and a seated guest's `del` of the boneyard are refused ("🚫 The
  tiles and the boneyard stay on the table"), all 28 kept, and a tile's
  too. (3) The facade (D315): `t.newDeck()`, an empty deck and
  `t.schedule('soon')` throw TypeErrors naming the call, and the failed
  calls mint no deck.
- **`t-final-play.js`** (new, E2E, ~70 s; Ann hosts on a desktop, Bo and Cy
  on Galaxy S5s, 360 × 640): (1) Chess for three then Draughts: Cy watches,
  and the watchers' box covers no seat label (before: "⏳ White — Ann"
  under it); the host's seat menu offers "End the named seats" and it
  works (Cy sits), the guest's menu does not; Draughts with a pan, then
  Backgammon: the view starts at zoom 1 with no pan; the log follows its
  newest line after the hand bar comes back. Hold'em picked over Chess's
  board: the confirm reads "Clear the table and start Texas Hold'em? The
  board, its pieces and the named seats (Light, Dark) go, with Chess's game
  state.", then all three are seated and dealt two. (3) Bo's 📜 dialog,
  open, follows the rules to Turn order. (2) Dominoes: 🗑 of the boneyard
  reads "🗑 Remove all 28?" and the second press is refused by the rules,
  28 kept; a cupped die's Reveal lifts the cup. (3) Bo's box: a toast on
  Ann's screen, 📦 marked until opened, the dialog focused at its heading;
  "Bob's Game"'s Set up button is the same element through 5 patches;
  Four Corners for three says "needs 4 seated players (3 are seated)" with
  no confirm and no trust dialog. (4) Help opens at its top, its Close on
  screen on the phone; Enter on a seat label opens its menu; icon buttons
  have names; the name dialog's name is selected; a `?cli=` tab with no
  bridge logs at most 6 errors in 8 s (it logged 20).
- **Changed by behaviour:** the pans on another player's piece in
  `t-p2-demos.js` (draughts), `t-p2-pieces.js` (section 11 and the end
  state's notices) and `t-p2-tables.js` (the seat-bound pawn) expect the
  one notice D313 adds, its exact text ("That piece is Black's — only Bob
  moves or removes it"), where they asserted none; `t-p2-tables.js`
  answers 🗑's ask before a deck goes (D312) and reads "Move to
  watchers | End the named seats" in the host's menu, as `t-p2-review.js`
  reads "Stand up (watch) | End the named seats" on the host's own label
  (D311); in `t-p5-private.js` (1‴) and `t-p5-veil.js` (3) a Reveal lifts
  the whole cup (D313: a new check that the neighbours show too), and the
  dice are cupped again for the steps after; `t-p2-demos.js`,
  `t-p2-review.js`, `t-p3-space.js` and `core-p2.test.mjs` read D314's
  table sizes (Draughts 1000 × 1360, Backgammon 1480 × 1520; t-p3-space's
  bare-felt drop is above the board now, whose sides are 80 units).
- **Mechanism changes:** `core-p2.test.mjs`'s boxKey checks went with the
  dead export (canon's equality, which the catalog key is, is still
  checked; core-p3 and core-p4 name the catalog key); `core-p3.test.mjs`
  takes its third savepoint with `T.savepoint()` (`T.checkpoint()`, the
  same call, is gone); `t-final-layout.js` and `t-p3-space.js` import
  final-lib's `overlapPast1px`; assets-lib and p4-lib take `sha256`,
  `dataURL` and `prng` from img-lib and p1-lib; assets-lib's `needLog`
  logs anything but the SyntaxError of a partial chunk.
- **One check narrowed** (D314's cost): `t-p2-review.js`'s landscape
  watcher with the log open — no margin beside the felt — allows the
  opened watchers' box over the two men of the board's edge row in its
  corner, where it allowed none: seen from a side seat, Draughts' taller
  table leaves 28 px of felt above the board, as Chess's has since D162.
  With the log closed (the margins) it still allows none.

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
