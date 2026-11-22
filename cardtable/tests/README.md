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
- **The serial list.** The benchmarks time things, so they run alone, one at
  a time after the parallel batch, under the same lock: `SERIAL`, a
  comma-separated list of suite names, default `t-p1-bench,core-p1-bench`. A
  listed suite that doesn't exist fails the run.
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
  order, into the view they add up to (`{items, players, rules, size, log,
  hand}`, the log untrimmed: everything that peer saw).
- **`window.__ct`.** `h.start()`'s pages set `window.CARDTABLE_TEST`, so the
  app exposes `{act, view, hand, log, perf}`: `act(a)` is a click's own path
  (on the host a Promise of `{ok, error?}`), `view()` the public view the
  screen draws (the host's own too: it takes its patches through the guest
  path), `hand()` and `log()` this player's hand and log, and `perf` the
  counters (`snaps`, `patches`, `gaps`, `snapRequests`) and the last
  durations: `lastApplyMs`, a received body folded into the view and the
  whole screen redrawn (items, seats, hand, log, buttons); `lastRenderMs`,
  `renderItems` alone, on any page; `lastTickMs`, the host's broadcast tick
  (signing and sending start; its own screen's redraw is not in it).
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
  kinds (`'patch'`, `'snap'`, `'any'`) whose next incoming `state` message is
  swallowed whole before the app sees it; and `keep`/`bodies`, the incoming
  bodies recorded while `keep` is set. Also `player`/`trio` (seated pages
  with the hook), `view`/`pidOf`/`act` (over `window.__ct`), `saved(host)`
  (the host's save, from localStorage or IndexedDB) and `truthOf(save)` (the
  public table and hands, recomputed from a save by core.js in Node), and
  `same`/`diff`, `prng`, `pct`, `until`.
- **The suites.** `core-p1.test.mjs`: the seeded fuzz of the public view and
  the patch fold, trimLog, z, indexed reads, MIGRATE, refusals, the splice,
  the t.data cap, applyStatePatch. `core-p1-bench.mjs`: B1, B2, B5, B7.
  `t-p1-delta.js`: every screen converges through deltas (random play,
  reloads, drops, vetoes, the version gate, spam). `t-p1-review.js`: the
  regressions the Phase 1A review found (states out of order, refusals that
  re-send too much, a refused snapshot request, no-op drops, log rebuilds, a
  newer save, module skew). `t-p1-bench.js`: B1', B3, B4 (serial).
