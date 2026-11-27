// E2E: spec §1j attacker case 3 — 1,000 `need` requests from Mallory (a raw
// peer) for the images of a 34.6 MB table:
//   - she gets only images this table shows, each at most twice a minute
//     (once, plus the one retry a damaged transfer earns: t-p1-assets (3));
//   - the 64 MB a minute budget holds, and binds: she is told "🚫 Too many
//     image requests — slow down" once;
//   - the host stays responsive: no main-thread long task ≥ 50 ms, its moves
//     reach another guest in ≤ 1 s each, and it still acts.
// And the ingestion and pacing that §1c and §1b.5 want (the Phase 1B review):
//   - no host long task ≥ 50 ms while the host takes in its own 34.6 MB of
//     images, nor while it ingests a guest's deck of 4,999 images;
//   - an honest guest pulling more than the 64 MB a minute (69.2 MB) is
//     paced, not dropped: told the images come slowly, it waits, and gets
//     every one, never calling any missing.
// The long-task budget is a timing, so this suite runs alone, after the
// parallel batch (run-all.sh's SERIAL list): on a machine busy with other
// suites, tasks stretch past 50 ms for reasons unrelated to the code.
'use strict';
const h = require('./h');
const L = require('./p1-lib');
const A = require('./assets-lib');
const { mallory } = require('./final-lib');
const { ok, section } = h;

const SLOW = '🚫 Too many image requests — slow down';
const LONG_MS = 50, BUDGET = 64e6;

(async () => {
  const env = await h.start();
  const host = await A.seat(env, 'Alice', env.url, [A.longTasks]);
  const invite = host.url();
  const bob = await A.seat(env, 'Bob', invite);

  /** The host's long tasks since performance.now() t (none: []), as rounded ms. */
  const longSince = async (t) => (await host.evaluate(() => window.__longTasks)).filter((x) => x.start >= t).map((x) => Math.round(x.ms));

  section('a table of 34.6 MB of images');
  const big = A.bigDecks();
  const tIn = await host.evaluate(() => performance.now());
  for (const [d, imgs] of big.decks.entries()) ok((await A.addDeck(host, A.imgDeck(`Big ${d + 1}`, imgs), 400 + 300 * d, 300)).ok, `the host adds a deck of 9 noise images (${(imgs.reduce((n, b) => n + b.length, 0) / 1e6).toFixed(1)} MB)`);
  const inLong = (await longSince(tIn)).filter((ms) => ms >= LONG_MS);
  ok(!inLong.length, `taking them in, the host has no long task ≥ ${LONG_MS} ms (${inLong.join(', ') || 'none'})`);
  ok(await L.until(async () => (await A.assetBytes(bob)) >= big.bytes, 60000, 250), 'Bob pulls them (and is done before the flood)');
  const std = Object.entries((await L.view(host)).items).find(([, it]) => it.k === 'p' && it.name === 'Standard')?.[0];
  await L.act(host, { t: 'deal', id: std, up: true, x: 300, y: 650 });
  const mover = Object.entries((await L.view(host)).items).filter(([, it]) => it.k === 'c').sort(([, a], [, b]) => b.z - a.z)[0]?.[0];
  ok(!!mover, 'the host deals a card to move');
  const M = await mallory(env, invite);
  await M.act({ t: 'hello' });
  ok(await L.until(() => M.evaluate(() => window.M.got.state.some(({ m }) => JSON.parse(m.b).to === 'ffffffffffffffff'))), 'Mallory is seated');
  await h.sleep(1000);

  section('1,000 image requests');
  const tWindow = Date.now(); // (her image budget's minute starts after this)
  await bob.evaluate(A.paceMonitor, mover);
  const t0 = await host.evaluate(() => performance.now());
  await A.startMoves(host, mover);
  // Half name this table's 18 images, half 64 ids no table has.
  const junk = Array.from({ length: 64 }, (_, k) => k.toString(16).padStart(2, '0').repeat(32));
  await M.evaluate(async ([ids, junk]) => {
    for (let k = 0; k < 1000; k++) {
      window.M.act({ t: 'need', a: k % 2 ? ids : junk });
      if (k % 50 === 49) await new Promise((r) => setTimeout(r, 100));
    }
  }, [big.ids, junk]);
  const got = () => M.evaluate(() => (window.M.got.asset || []).map((x) => [x.metadata?.h, x.m?.byteLength ?? 0]));
  ok(await L.until(async () => new Set((await got()).map(([id]) => id)).size >= big.ids.length, 30000, 250), 'Mallory gets each image of the table');
  // Asked for again once she holds them all: past the budget (2 × 34.6 MB > 64 MB).
  await M.evaluate(async (ids) => {
    for (let k = 0; k < 20; k++) { window.M.act({ t: 'need', a: ids }); await new Promise((r) => setTimeout(r, 100)); }
  }, big.ids);
  let last = -1;
  await L.until(async () => { const n = (await got()).length, still = n === last; last = n; return still; }, 30000, 2000); // nothing more comes
  const t1 = await host.evaluate(() => performance.now());
  const { moves } = await A.stopMoves(host, bob);

  const list = await got(), bytes = list.reduce((n, [, b]) => n + b, 0), ids = list.map(([id]) => id);
  const slow = await M.evaluate((s) => window.M.notes().filter((n) => n.msg === s).length, SLOW);
  console.log(`  ${list.length} images (${(bytes / 1e6).toFixed(1)} MB) sent to Mallory; "${SLOW}" × ${slow}`);
  ok(ids.every((id) => big.ids.includes(id)), 'she gets only images this table shows');
  ok(big.ids.every((id) => ids.filter((x) => x === id).length <= 2), 'each at most twice a minute');
  ok(bytes <= BUDGET && bytes > big.bytes, `the ${BUDGET / 1e6} MB a minute budget holds, and binds (${(bytes / 1e6).toFixed(1)} MB sent)`);
  ok(slow === 1, `she is told "${SLOW}" once (${slow})`);
  const long = (await host.evaluate(() => window.__longTasks)).filter((x) => x.start >= t0 && x.start <= t1);
  ok(long.every((x) => x.ms < LONG_MS), `no host long task ≥ ${LONG_MS} ms (${long.map((x) => Math.round(x.ms)).join(', ') || 'none'})`);
  ok(moves.length >= 10 && moves.every((m) => m.ms <= 1000), `the host's ${moves.length} moves meanwhile reach Bob in ≤ 1 s each (max ${Math.max(...moves.map((m) => m.ms))} ms)`);
  ok((await L.act(host, { t: 'flip', id: mover })).ok, 'and the host still acts');

  section("the budget is the player's (D302): a second connection under Mallory's id, then a reconnect, get nothing more this minute");
  /** Raw page P asks for every image of the table and waits: the bytes it received in all. */
  const pull = async (P) => {
    await P.act({ t: 'hello' });
    await P.act({ t: 'need', a: big.ids });
    await h.sleep(5000);
    return P.evaluate(() => (window.M.got.asset || []).reduce((n, x) => n + (x.m?.byteLength ?? 0), 0));
  };
  const M2 = await mallory(env, invite, 3);
  const second = await pull(M2);
  await M2.close();
  const M3 = await mallory(env, invite, 3);
  const third = await pull(M3);
  const took = (Date.now() - tWindow) / 1000;
  ok(second === 0 && third === 0, `a second tab of hers gets ${second} bytes, and a new connection after it left ${third} (she had ${(bytes / 1e6).toFixed(1)} MB this minute)`);
  ok(took < 58, `(both asked within the minute her budget counts: ${took.toFixed(0)} s after it began)`);
  await M3.close();

  section("a guest's deck of 4,999 images");
  const many = A.distinctPngs(4999, 9);
  const tMany = await host.evaluate(() => performance.now());
  await M.act({ t: 'addDeck', deck: A.imgDeck('Many', many), x: 600, y: 900 });
  ok(await L.until(async () => !!(await A.pileOf(host, 'Many')), 30000), 'Mallory adds a deck of 4,999 images');
  await h.sleep(1000);
  const manyLong = (await longSince(tMany)).filter((ms) => ms >= LONG_MS);
  ok(!manyLong.length, `ingesting it, the host has no long task ≥ ${LONG_MS} ms (${manyLong.join(', ') || 'none'})`);

  section('an honest guest pulling 69.2 MB: paced, never dropped');
  const more = A.bigDecks(1000);
  for (const [d, imgs] of more.decks.entries()) await A.addDeck(host, A.imgDeck(`Big ${d + 3}`, imgs), 400 + 300 * d, 600);
  const all = [...big.ids, ...more.ids], total = big.bytes + more.bytes;
  const carol = await A.seat(env, 'Carol', invite, [A.toastLog]);
  const t2 = Date.now();
  ok(await L.until(async () => Object.values(await A.stored(carol, all)).every((r) => r?.ok), 120000, 1000), `Carol gets all ${all.length} images (${(total / 1e6).toFixed(1)} MB), in ${((Date.now() - t2) / 1000).toFixed(0)} s`);
  const said = await A.toastsSince(carol, t2);
  ok(said.includes('Card images are coming slowly — the host sends at most 64 MB of them a minute to a player, 256 MB to all'), 'told once she is over the 64 MB a minute that the images come slowly');
  ok(!said.some((t) => /missing/.test(t)), `and never told an image is missing (${JSON.stringify(said)})`);
  await env.done();
})().catch(h.crash);
