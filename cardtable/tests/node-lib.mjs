// Shared by the Node-only Phase 1 suites (core-p1.test.mjs, core-p1-bench.mjs):
// the state core (and store.js) loaded straight from the checkout, checks in h.js's format,
// seeded randomness and seeded tables. No browser and no Playwright: these
// only need Node ≥ 22.7, which loads core.js (ES module syntax in a .js file,
// with no package.json saying so) by syntax detection.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 7)) {
  console.error(`TEST CRASHED: Node ${process.versions.node} — these suites need Node ≥ 22.7 (ES module syntax detection)`);
  process.exit(2);
}

/** The checkout under test: APP_ROOT, as for h.js (default: this one). */
export const APP_ROOT = path.resolve(process.env.APP_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
export const core = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/core.js')));
/** store.js: its pure parts (imageDims, checkImage, sha256hex, ingestDeck in memory) run in Node; IndexedDB does not. */
export const store = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/store.js')));
/** The image fixtures (tests/fixtures: 37 × 23 px each, see tests/README.md). */
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const { RULES_TEMPLATES } = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')));

let failures = 0;
/** A check (h.js's format, which run-all.sh greps): logs ✓/✗, never throws. */
export function ok(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ FAIL: ${msg}`); }
}
export const section = (s) => console.log(`— ${s}`);
/** Prints the summary and exits: 1 if any check failed. */
export function report() {
  console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
}
export function crash(e) { console.error('TEST CRASHED:', e); process.exit(2); }
/** Runs one scenario; a throw is a failed check (naming `what`), not the end of the suite. */
export async function guard(what, fn) {
  try { await fn(); } catch (e) { ok(false, `${what} crashed: ${e.stack}`); }
}

/** The seeds a suite runs: SEED=n runs only that one (to replay a failure). */
export const seeds = (dflt) => (process.env.SEED ? [Number(process.env.SEED)] : dflt);
/** A seeded uniform RNG in [0, 1) (mulberry32), with int(n) and pick(list). */
export function rng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  r.int = (n) => Math.floor(r() * n);
  r.pick = (list) => list[Math.floor(r() * list.length)];
  return r;
}

export const HOST = 'a'.repeat(16), BOB = 'b'.repeat(16), CAROL = 'c'.repeat(16), DAVE = 'd'.repeat(16);
/** A seat key for player p (what the app sends as _key). */
export const keyOf = (p) => `key-${p}`.padEnd(32, '!');
/** A seeded env for createTable: the host's pid, a clock that moves 250 ms
 *  per reading, a seeded RNG and sequential ids. Pass the same env to a
 *  reloaded table so it keeps minting fresh ids. */
export function env(seed) {
  let clock = 1.7e12, n = 0;
  return { pid: HOST, now: () => (clock += 250), random: rng(seed ^ 0x5eed), uid: () => (++n).toString(16).padStart(8, '0') };
}
export const json = (o) => JSON.parse(JSON.stringify(o));
/** JSON with every object's keys sorted: equality that ignores key order (a
 *  guest's dict fills in patch order), as the wire would carry it. */
export const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
/** The q-th quantile (0..1) of a list of numbers. */
export const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)];
