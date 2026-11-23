// E2E (D95): a page open for over a minute still links at once. Each page
// keeps a pool of WebRTC offers made in advance, and Trystero 0.25.3 hands
// out one older than 57 s by an ICE restart that first rolled it back: in
// Chromium the new offer then had no m-line, and the page that answered it
// never linked. Of two pages, the one whose id sorts first makes the offer,
// so a guest reloading (or joining) beside a host open for a minute got the
// table only half the time (the other half: a watchdog reload 20 s later, and
// another coin toss), and so did a host reloading beside an old guest.
//   guest reloads  Bob reloads beside a host open for over a minute, until the
//                  host has made the offer twice: every reload gets the table
//                  within 5 s
//   host reloads   Alice (the host) reloads beside Carol, open for over a
//                  minute, until Carol has made the offer: every time, Carol
//                  has the host's new table within 8 s
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
  for (let k = 0; k < 16 && runs.filter((r) => r.hostOffers).length < 2; k++) {
    const t = Date.now();
    await bob.reload();
    const got = await L.until(() => bob.evaluate(() => window.__ct?.view().seq > 0 && document.querySelectorAll('.item').length > 0).catch(() => false), 5000, 100);
    const id = await idOf(bob);
    runs.push({ hostOffers: hostId < id, ms: got ? Date.now() - t : null });
    if (!got) console.log(`  (reload ${k + 1}: no table in 5 s — Bob: ${await status(bob)}; the host: ${await status(host)})`);
  }
  console.log(`  reloads: ${runs.map((r) => `${r.ms ?? '✗'} ms (${r.hostOffers ? 'the host offers' : 'Bob offers'})`).join(', ')}`);
  ok(runs.some((r) => r.hostOffers), `the host made the offer at least once (${runs.filter((r) => r.hostOffers).length} of ${runs.length} reloads)`);
  ok(runs.every((r) => r.ms !== null), `every reload got the table within 5 s (${runs.filter((r) => r.ms === null).length} did not)`);
  const hostOffers = await offers(host); // (its page is about to reload: its count starts again)

  section('host reloads: beside a guest open for over a minute, the reloaded host\'s table reaches her within 8 s, whoever makes the offer');
  const carolId = await idOf(carol), hruns = [];
  for (let k = 0; k < 14 && !hruns.some((r) => r.carolOffers); k++) {
    const boot = await carol.evaluate(() => window.__ct.view().boot), t = Date.now();
    await host.reload();
    const got = await L.until(() => carol.evaluate((b) => window.__ct.view().boot !== b && window.__ct.view().seq > 0, boot), 8000, 100);
    const id = await idOf(host);
    hruns.push({ carolOffers: carolId < id, ms: got ? Date.now() - t : null });
    if (!got) console.log(`  (host reload ${k + 1}: Carol has no new table in 8 s — Carol: ${await status(carol)}; the host: ${await status(host)})`);
  }
  console.log(`  host reloads: ${hruns.map((r) => `${r.ms ?? '✗'} ms (${r.carolOffers ? 'Carol offers' : 'the host offers'})`).join(', ')}`);
  ok(hruns.some((r) => r.carolOffers), `Carol made the offer at least once (${hruns.filter((r) => r.carolOffers).length} of ${hruns.length} host reloads)`);
  ok(hruns.every((r) => r.ms !== null), `every host reload reached Carol within 8 s (${hruns.filter((r) => r.ms === null).length} did not)`);

  section('offers: no page made an offer without an m-line');
  const all = { 'Alice (before her reloads)': hostOffers, Alice: await offers(host), Bob: await offers(bob), Carol: await offers(carol) };
  ok(Object.values(all).every((o) => o.n > 0 && o.empty === 0), `offers made (without an m-line) on each page: ${Object.entries(all).map(([k, o]) => `${k} ${o.n} (${o.empty})`).join(', ')}`);

  await env.done();
})().catch(h.crash);
