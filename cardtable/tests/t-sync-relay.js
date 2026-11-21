// E2E (sync cluster): a peer relaying the host's signed messages can't pose as
// the host. Signatures prove authorship, not delivery — so states and notes are
// bound to their recipient's connection, other channels to the host's peer,
// and an older host epoch is never accepted again.
//   SEC (review #3)  a replayed public state must not make a guest send its seat key to the relayer
//   NET-1 (review #2) an old-epoch state replayed after a host restart must not roll the table back
//   SEC-7 (review #8) a relayed peek note must not open the peek on another guest
//   NET-1 (review #2) two host tabs (invite opened twice) still converge: the winner takes a fresh epoch
const h = require('./h');
const { ok, section, logHas } = h;

/** A raw Trystero peer (no app code): records states/notes/acts, can relay them, and can play a seat. */
async function spy(env, invite) {
  const page = await env.page('Spy');
  await page.goto(`${env.base}/cardtable/cah-cards.js`);
  await page.evaluate(async ({ invite, relay }) => {
    const { joinRoom } = await import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm');
    const [, roomId, password] = invite.match(/#room~([0-9a-f]+)~([0-9a-f]+)/);
    const room = joinRoom({ appId: 'gk-cardtable', password, relayConfig: { urls: [relay] } }, roomId);
    const S = (window.S = { room, got: { state: [], note: [], act: [] }, send: {} });
    for (const ch of ['state', 'note', 'act']) {
      const a = room.makeAction(ch);
      S.send[ch] = a.send;
      a.onMessage = (m, { peerId }) => S.got[ch].push({ m, from: peerId, body: typeof m?.b === 'string' ? JSON.parse(m.b) : m });
    }
    await new Promise((r) => { const t = setInterval(() => { if (Object.keys(room.getPeers()).length >= 2) { clearInterval(t); r(); } }, 100); });
  }, { invite, relay: env.relayUrl });
  await page.waitForFunction(() => window.S.got.state.length > 0, null, { timeout: 20000 });
  return page;
}
const count = (p) => p.$eval('.item.pile .count', (e) => +e.textContent);
/** Spy: re-sends a captured state (picked by `pick`) to the guest — the peer that isn't the host. */
const replay = (S, pick) => S.evaluate((pick) => {
  const S = window.S, hostPeer = S.got.state.at(-1).from;
  const guest = Object.keys(S.room.getPeers()).find((p) => p !== hostPeer);
  const x = new Function('S', `return ${pick}`)(S);
  S.got.act = [];
  S.send.state(x.m, { target: guest });
  return x.body.boot;
}, pick);
const keyedActs = (S) => S.evaluate(() => window.S.got.act.filter((x) => x.body._key).length);

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);
  const S = await spy(env, invite);
  const warns = [];
  guest.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('relayed by')) warns.push(m.text()); });

  section('a relayed current state is dropped (no seat key for the relayer)');
  for (let k = 0; k < 2; k++) { await guest.dblclick('.item.pile'); await h.waitHand(guest, k + 1); }
  await S.waitForFunction(() => window.S.got.state.at(-1).body.items && Object.values(window.S.got.state.at(-1).body.items).some((i) => i.n === 50), null, { timeout: 15000 });
  await replay(S, 'S.got.state.at(-1)');
  await h.sleep(3500);
  ok((await keyedActs(S)) === 0, 'the guest never sends its keyed hello to the relaying peer');
  ok(warns.length > 0, `the guest logs the dropped relay (${warns[0] || 'no warning'})`);
  ok((await count(guest)) === 50, 'and its table is untouched');

  section('an old-epoch state replayed after a host restart is dropped');
  await host.reload();
  await host.waitForSelector('.item.pile .count', { timeout: 20000 });
  await logHas(host, 'resumed the table', 20000);
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 3, 20000);
  await guest.waitForFunction(() => document.querySelector('.item.pile .count').textContent === '49', null, { timeout: 15000 });
  const boot = await replay(S, 'S.got.state.find((x) => x.body.boot !== S.got.state.at(-1).body.boot)');
  ok(Number.isFinite(boot), `replayed a state from the previous host epoch (${boot})`);
  await h.sleep(3500);
  ok((await count(guest)) === 49, `the guest's table did not roll back (${await count(guest)} cards in the pile)`);
  ok((await keyedActs(S)) === 0, 'and no seat key went to the relayer');
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 4).then(() => ok(true, 'the guest keeps playing with the real host'), () => ok(false, 'the guest keeps playing with the real host'));

  section('a relayed peek note does not reveal anything to another guest');
  const before = await guest.$$eval('.item', (els) => els.map((e) => e.dataset.id));
  await host.click('.item.pile');
  await host.click('#action-bar:not(.hidden) [data-cmd="dealdn"]');
  const fd = await (await guest.waitForFunction((b) => [...document.querySelectorAll('.item')].find((e) => !b.includes(e.dataset.id))?.dataset.id, before)).jsonValue();
  // The spy takes a seat of its own and peeks: the host answers it privately.
  await S.evaluate((id) => {
    const S = window.S, hostPeer = S.got.state.at(-1).from, me = { _pid: 'abcdef0123456789', _name: 'Spy', _key: 'k'.repeat(32) };
    S.send.act({ t: 'hello', ...me }, { target: hostPeer });
    setTimeout(() => S.send.act({ t: 'peek', id, ...me }, { target: hostPeer }), 500);
  }, fd);
  await S.waitForFunction(() => window.S.got.note.some((n) => n.body.peek), null, { timeout: 15000 });
  await logHas(host, 'Spy peeked at a face-down card');
  warns.length = 0;
  await S.evaluate(() => {
    const S = window.S, hostPeer = S.got.state.at(-1).from;
    const guest = Object.keys(S.room.getPeers()).find((p) => p !== hostPeer);
    S.send.note(S.got.note.find((n) => n.body.peek).m, { target: guest });
  });
  await h.sleep(2500);
  ok(await guest.$eval('#peek', (el) => el.classList.contains('hidden')), 'the relayed peek note does not open the peek on the guest');
  ok(warns.length > 0, 'and the guest logs the dropped relay');

  section('two host tabs converge on one host the guest follows');
  const twin = await host.context().newPage(); // the invite opened again in the host's browser
  await twin.goto(host.url());
  const hosting = (p) => p.evaluate(() => !document.getElementById('size-sel').classList.contains('hidden'));
  await h.sleep(6000);
  const roles = [await hosting(host), await hosting(twin)];
  ok(roles.filter(Boolean).length === 1, `exactly one tab stays host (${roles})`);
  const winner = roles[0] ? host : twin;
  const n = await count(winner);
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 5, 20000).then(() => ok(true, 'the guest still plays with the winner'), () => ok(false, 'the guest still plays with the winner'));
  await guest.waitForFunction((n) => +document.querySelector('.item.pile .count').textContent === n - 1, n, { timeout: 15000 })
    .then(() => ok(true, "and sees the winner's table"), () => ok(false, "and sees the winner's table"));
  await env.done();
})().catch(h.crash);
