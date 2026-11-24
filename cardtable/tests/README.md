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
  within 1 s), run alone, one at a time after the parallel batch, under the
  same lock: `SERIAL`, a comma-separated list of suite names, default
  `t-p1-bench,core-p1-bench,core-p2-bench,t-p1-flood,t-p1-assets`. A listed
  suite that doesn't exist fails the run.
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
  cases 4 and 7): Alice on a desktop, Bob on an iPhone 13, Carol on an
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
