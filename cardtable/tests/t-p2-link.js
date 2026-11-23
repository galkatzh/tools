// E2E (D95): a page open for over a minute still links at once. Each page
// keeps a pool of WebRTC offers made in advance, and Trystero 0.25.3 hands
// out one older than 57 s by an ICE restart that first rolled it back: in
// Chromium and WebKit the new offer then had no m-line, and the page that
// answered it never linked. Of two pages, the one whose id sorts first makes
// the offer, so a guest reloading (or joining) beside a host open for a
// minute got the table only half the time (the other half: a watchdog reload
// 20 s later, and another coin toss), and so did a host reloading beside an
// old guest. The test chooses each page's id (idFirst), so both cases are
// covered on every run, not when the draw allows.
//   guest reloads  Bob reloads beside a host open for over a minute, as an id
//                  after the host's (the host offers) and before it (Bob
//                  offers), twice each: every reload gets the table within 5 s
//   host reloads   Alice (the host) reloads beside Carol, open for over a
//                  minute, as an id after Carol's (Carol offers, twice) and
//                  before it: every time, Carol has the host's new table within 8 s
//   offers         no page ever makes an offer without an m-line
const h = require('./h');
const L = require('./p1-lib');
const { ok, section } = h;

const WARM_MS = 62000; // a pooled offer is re-offered (ICE restart) once older than 57.333 s

/** Init script: every local offer this page makes, counted (window.__offers:
 *  {n, empty}); `empty` counts those without an m-line (nothing to link). */
function offerWatch() {
  const o = (window.__offers = { n: 0, empty: 0 });
  const sld = RTCPeerConnection.prototype.setLocalDescription;
  RTCPeerConnection.prototype.setLocalDescription = async function (d) {
    await sld.call(this, d);
    if (d?.type !== 'rollback' && this.localDescription?.type === 'offer') {
      o.n++;
      if (!/^m=/m.test(this.localDescription.sdp)) o.empty++;
    }
  };
}
/** Init script: the first character of this page's Trystero id is
 *  sessionStorage['t-id-first'] ('M' until reloadAs sets it). Trystero's id
 *  is 20 characters of `alphabet`, each from one Math.random() call, the
 *  page's first ones (in its core's module body). Of two pages the one whose
 *  id sorts first makes the offer: a '0…' offers to an 'M…', a 'z…' is
 *  offered to. */
function idFirst(alphabet) {
  let c = 'M';
  try { c = sessionStorage.getItem('t-id-first') || c; } catch (err) { console.error('t-id-first unreadable', err); }
  const rnd = Math.random;
  let n = 0;
  Math.random = () => (n++ === 0 ? (alphabet.indexOf(c) + 0.5) / alphabet.length : rnd());
}
const ALPHABET = '0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz'; // (Trystero's)
/** Reloads page p with an id that starts with `c`; resolves to the new id,
 *  and throws if the id didn't take that start (the test would cover luck). */
async function reloadAs(p, c) {
  await p.evaluate((c) => sessionStorage.setItem('t-id-first', c), c);
  await p.reload();
  const id = await idOf(p);
  if (id[0] !== c) throw new Error(`could not choose the page's id: asked for "${c}…", got ${id}`);
  return id;
}
/** Trystero's id for page p (of two pages, the one whose id sorts first makes the offer). */
const idOf = (p) => p.evaluate(() => import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm').then((m) => m.selfId));
/** Page p's net status ("● n" and its tooltip), for a failure's message. */
const status = (p) => p.$eval('#net-status', (el) => `${el.textContent} ${el.title}`).catch((e) => `(unreadable: ${e.message})`);
const offers = (p) => p.evaluate(() => window.__offers);

(async () => {
  const env = await h.start();
  /** Player `name` on its own page, with the offer watch, once it shows the table. */
  async function player(name, url) {
    const p = await env.page(name);
    await p.addInitScript(offerWatch);
    await p.addInitScript(idFirst, ALPHABET);
    await p.goto(url);
    await h.joinAs(p, name);
    await p.waitForFunction(() => window.__ct?.view().seq > 0 && document.querySelectorAll('.item').length > 0, null, { timeout: 30000 });
    return p;
  }
  const t0 = Date.now();
  const host = await player('Alice', env.url);
  const bob = await player('Bob', host.url());
  const carol = await player('Carol', host.url());
  console.log(`  (waiting until every page has been open ${WARM_MS / 1000} s: their pooled offers are then re-offered by an ICE restart)`);
  await h.sleep(Math.max(0, t0 + WARM_MS + 8000 - Date.now()));

  section('guest reloads: beside a host open for over a minute, a reloaded guest gets the table within 5 s, whoever makes the offer');
  const hostId = await idOf(host), runs = [];
  for (const c of ['z', '0', 'z', '0']) { // 'z…': the host offers (from its aged pool), '0…': Bob does
    const t = Date.now(), id = await reloadAs(bob, c);
    const got = await L.until(() => bob.evaluate(() => window.__ct?.view().seq > 0 && document.querySelectorAll('.item').length > 0).catch(() => false), 5000, 100);
    runs.push({ hostOffers: hostId < id, ms: got ? Date.now() - t : null });
    if (!got) console.log(`  (reload as ${id}: no table in 5 s — Bob: ${await status(bob)}; the host: ${await status(host)})`);
  }
  console.log(`  reloads: ${runs.map((r) => `${r.ms ?? '✗'} ms (${r.hostOffers ? 'the host offers' : 'Bob offers'})`).join(', ')}`);
  ok(runs.filter((r) => r.hostOffers).length === 2, `the host made the offer twice, Bob twice (the host ${runs.filter((r) => r.hostOffers).length} of ${runs.length} reloads)`);
  ok(runs.every((r) => r.ms !== null), `every reload got the table within 5 s (${runs.filter((r) => r.ms === null).length} did not)`);
  const hostOffers = await offers(host); // (its page is about to reload: its count starts again)

  section('host reloads: beside a guest open for over a minute, the reloaded host\'s table reaches her within 8 s, whoever makes the offer');
  const carolId = await idOf(carol), hruns = [];
  for (const c of ['z', '0', 'z']) { // 'z…': Carol offers (from her aged pool), '0…': the host does
    const boot = await carol.evaluate(() => window.__ct.view().boot), t = Date.now();
    const id = await reloadAs(host, c);
    const got = await L.until(() => carol.evaluate((b) => window.__ct.view().boot !== b && window.__ct.view().seq > 0, boot), 8000, 100);
    hruns.push({ carolOffers: carolId < id, ms: got ? Date.now() - t : null });
    if (!got) console.log(`  (host reload as ${id}: Carol has no new table in 8 s — Carol: ${await status(carol)}; the host: ${await status(host)})`);
  }
  console.log(`  host reloads: ${hruns.map((r) => `${r.ms ?? '✗'} ms (${r.carolOffers ? 'Carol offers' : 'the host offers'})`).join(', ')}`);
  ok(hruns.filter((r) => r.carolOffers).length === 2, `Carol made the offer twice, the host once (Carol ${hruns.filter((r) => r.carolOffers).length} of ${hruns.length} host reloads)`);
  ok(hruns.every((r) => r.ms !== null), `every host reload reached Carol within 8 s (${hruns.filter((r) => r.ms === null).length} did not)`);

  section('offers: no page made an offer without an m-line');
  const all = { 'Alice (before her reloads)': hostOffers, Alice: await offers(host), Bob: await offers(bob), Carol: await offers(carol) };
  ok(Object.values(all).every((o) => o.n > 0 && o.empty === 0), `offers made (without an m-line) on each page: ${Object.entries(all).map(([k, o]) => `${k} ${o.n} (${o.empty})`).join(', ')}`);

  await env.done();
})().catch(h.crash);
