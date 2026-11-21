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
modules.

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
  end-to-end suite drives its own Chromium.
- Runs take a machine-wide lock (`CARDTABLE_TEST_LOCK`, default
  `/tmp/cardtable-tests.lock`): concurrent runs on a small machine starve each
  other into flaky timeouts, so a second run waits for the first.
- Each suite's log is kept in `out/`; failing checks are listed with the log's
  path.
- `parse.js` parse-checks `app.js` and every local module it imports as real
  ES modules (a stray `await` or a duplicate export fails there, not in a
  browser).

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
