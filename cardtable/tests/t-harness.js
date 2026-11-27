// The harness's own loud failures (h.js env.page, D95): on every tab of a
// player's browser — the page env.page opens, and any the test opens later
// in its context (context().newPage(): a rejoining guest, a returning host,
// a twin tab) — an uncaught error fails the suite, and so does the app's
// watchdog reloading the page ("reconnecting via reload: …"), unless that
// tab opted out (watchdogOK: a tab the test means to lose its host or its
// relays). Each case is a child suite — this file, run with the case's
// name — on a page with no app (h.plain), which logs the watchdog's line or
// throws as the app would; its exit status and output are checked.
const { execFile } = require('child_process');
const h = require('./h');
const { ok, section } = h;

/** The cases: where it happens (`tab`: a second tab of the player's browser), what (`does`), whether the tab opted out, and the failure the suite must report (none: it passes). */
const CASES = {
  'page reload': { tab: false, does: 'reload', fails: '[A WATCHDOG RELOAD] reconnecting via reload: no host found yet' },
  'tab reload': { tab: true, does: 'reload', fails: '[A WATCHDOG RELOAD] reconnecting via reload: no host found yet' },
  'tab error': { tab: true, does: 'throw', fails: '[A PAGEERROR] a harness check' },
  'tab reload, opted out': { tab: true, does: 'reload', optOut: true, fails: null },
};

/** A child suite: player A, maybe a second tab, which does what its case says. */
async function child(name) {
  const c = CASES[name], env = await h.start();
  const a = await env.page('A');
  await a.goto(h.plain(env));
  const p = c.tab ? await a.context().newPage() : a;
  if (c.tab) await p.goto(h.plain(env));
  if (c.optOut) p.watchdogOK = true;
  await p.evaluate((does) => {
    if (does === 'reload') console.info('reconnecting via reload: no host found yet'); // (the app's line, app.js reconnect)
    else setTimeout(() => { throw new Error('a harness check'); });
  }, c.does);
  await h.sleep(500);
  await env.done();
}

/** Runs case `name` as a child suite: {rc, out (stdout and stderr)}. */
const run = (name) => new Promise((resolve) => {
  execFile(process.execPath, [__filename, name], { timeout: 60000 }, (err, stdout, stderr) => resolve({ rc: err ? err.code : 0, out: stdout + stderr }));
});

if (process.argv[2]) child(process.argv[2]).catch(h.crash);
else {
  (async () => {
    section('a watchdog reload or an uncaught error, on any tab of a player\'s browser, fails the suite; a tab that opted out may reload');
    for (const [name, c] of Object.entries(CASES)) {
      const { rc, out } = await run(name), said = out.split('\n').find((l) => /WATCHDOG RELOAD|PAGEERROR/.test(l)) || 'nothing';
      ok(c.fails ? rc === 1 && out.includes(c.fails) && /\n1 FAILURES/.test(out) : rc === 0 && /ALL TESTS PASSED/.test(out),
        `${name}: ${c.fails ? 'the suite fails, saying so' : 'the suite passes'} (exit ${rc}; it said ${said.trim()})`);
    }
    h.report();
  })().catch(h.crash);
}
