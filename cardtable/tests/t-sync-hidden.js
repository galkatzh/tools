// E2E (sync cluster): hidden information never leaves the host, peeks are a
// private host round-trip (UI and terminal bridge), and the log can't be
// flooded — chat is rate-limited and can't evict the record of actions.
//   SEC-7 / GAME-13 / CORE-S1 / SEC-11  wire states carry no pile order or face-down ids
//   SEC-12                              chat flood control + separate chat cap (renames count as chat)
const h = require('./h');
const path = require('path');
const { ok, section, logHas } = h;

/** A raw Trystero peer (no app code) recording everything the room sends it. */
async function spy(env, invite) {
  const page = await env.page('Spy');
  await page.goto(`${env.base}/cardtable/cah-cards.js`);
  await page.evaluate(async ({ invite, relay }) => {
    const { joinRoom } = await import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm');
    const [, roomId, password] = invite.match(/#room~([0-9a-f]+)~([0-9a-f]+)/);
    const room = joinRoom({ appId: 'gk-cardtable', password, relayConfig: { urls: [relay] } }, roomId);
    const S = (window.S = { got: {} });
    for (const ch of ['state', 'note']) {
      const a = room.makeAction(ch);
      a.onMessage = (m) => (S.got[ch] ||= []).push(typeof m?.b === 'string' ? JSON.parse(m.b) : m);
    }
    await new Promise((r) => { const t = setInterval(() => { if (Object.keys(room.getPeers()).length >= 2) { clearInterval(t); r(); } }, 100); });
  }, { invite, relay: env.relayUrl });
  return page;
}
async function cmd(p, sel, c) {
  if (!(await p.$eval(sel, (el) => el.classList.contains('selected')))) await p.click(sel);
  await p.click(`#action-bar:not(.hidden) [data-cmd="${c}"]`);
}
const PILE = '.item.pile:has(.pname)';

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);
  const S = await spy(env, invite);

  section('the wire carries no hidden identities');
  await guest.dblclick(PILE);
  await h.waitHand(guest, 1);
  const before = await guest.$$eval('.item', (els) => els.map((e) => e.dataset.id));
  await cmd(host, PILE, 'dealdn');
  const fdId = await (await guest.waitForFunction((b) => [...document.querySelectorAll('.item')].find((e) => !b.includes(e.dataset.id))?.dataset.id, before)).jsonValue();
  await S.waitForFunction((id) => (window.S.got.state || []).some((s) => s.items?.[id]), fdId, { timeout: 15000 });
  const states = await S.evaluate(() => window.S.got.state);
  // the patch that carries the deal: the new card and the pile it came from (deltas send only what changed)
  const last = states.find((s) => s.kind === 'patch' && s.items?.[fdId]);
  const pile = Object.values(last.items).find((it) => it.k === 'p');
  ok(states.every((s) => !JSON.stringify(s.items || {}).includes('"cards"')), 'no state ever ships a pile\'s card list (SEC-7/GAME-13)');
  ok(pile.n === 50 && pile.top && pile.top.up === false && !('i' in pile.top), `a pile is {n, top} with a face-down top reduced to its deck (n=${pile.n})`);
  ok(last.items[fdId].up === false && !('i' in last.items[fdId]) && typeof last.items[fdId].d === 'string', 'a face-down table card carries its deck (for the back) but no index (CORE-S1)');
  ok(JSON.stringify(last).length < 1200, `the patch carrying a 50-card pile stays small (${JSON.stringify(last).length} bytes — independent of pile size, SEC-11)`);
  const hostSig = await host.$eval(`.item[data-id="${fdId}"]`, (el) => el.dataset.sig);
  ok(!/^c\|[^|]+\|\d+\|/.test(hostSig), "the host renders the same public shape (no index in the host's DOM either)");

  section('peek is a private round-trip');
  await cmd(guest, `.item[data-id="${fdId}"]`, 'peek');
  await guest.waitForSelector('#peek:not(.hidden) .face.std', { timeout: 15000 });
  const seen = await guest.$eval('#peek-inner', (el) => el.querySelector('.mr').textContent + el.querySelector('.ms').textContent);
  await logHas(host, 'Bob peeked at a face-down card');
  ok(true, `the guest sees the peeked card (${seen}) after the host logged the peek`);
  ok(!(await S.evaluate(() => (window.S.got.note || []).some((n) => n.peek))), 'the answer is addressed to the peeker only (the spy gets no peek note)');
  ok(await host.$eval('#peek', (el) => el.classList.contains('hidden')), "the reveal doesn't show on the host");
  await guest.click('#peek');
  await cmd(guest, PILE, 'peek');
  await guest.waitForSelector('#peek:not(.hidden) .face.std', { timeout: 15000 });
  await logHas(host, 'Bob peeked at the top card of the Standard pile');
  ok(true, "peeking a pile's top works the same way");
  await guest.click('#peek');

  section('terminal bridge: pile counts and peeks with the new item shape');
  const { Bridge } = require(path.join(h.APP_ROOT, 'cardtable', 'cli.js'));
  const bridge = await new Bridge().ready;
  const bot = await env.page('Botty');
  await bot.goto(bridge.urlFor(invite, 'Botty'));
  const snap = await bridge.wait((s) => s.items?.some((it) => it.kind === 'pile'), 40000);
  const sp = snap.items.find((it) => it.kind === 'pile');
  ok(sp.count === 50, `the bridge snapshot reports the pile count (${sp.count})`);
  bridge.send({ t: 'peek', id: fdId });
  const got = await bridge.wait((s) => (s.msgs || []).some((m) => m.startsWith('peek: ')), 20000).catch(() => null);
  const msg = got && got.msgs.find((m) => m.startsWith('peek: '));
  ok(msg === `peek: ${seen}`, `"peek <id>" answers through the host's private note (${msg})`);
  await logHas(host, 'Botty peeked at a face-down card');
  bridge.close();
  await bot.close();

  section('flood control');
  const chat = (p, m) => p.evaluate((m) => { document.getElementById('chat-input').value = m; document.getElementById('chat-form').requestSubmit(); }, m);
  for (let k = 0; k < 9; k++) await chat(guest, `spam${k}`);
  ok(await h.toastHas(guest, 'Slow down').then(() => true, () => false), 'the flooding guest is told to slow down');
  await logHas(host, 'spam4');
  await h.sleep(1500);
  const spam = (await host.$eval('#log', (el) => el.textContent)).match(/spam\d/g) || [];
  ok(spam.length === 5, `a guest's chat burst is capped at 5 per 5 s (${spam.length} of 9 logged, the rest refused with a toast)`);
  await h.sleep(5200);
  await chat(guest, 'after-the-pause');
  await logHas(host, 'after-the-pause');
  ok(true, 'chat works again after the pause');
  for (let k = 0; k < 220; k++) await chat(host, `flood${k}`);
  await logHas(guest, 'flood219');
  const glog = await guest.$eval('#log', (el) => el.textContent);
  ok(glog.includes('Bob peeked at a face-down card'), '220 chat lines did not evict the peek from the log');
  ok(!glog.includes('flood119') && glog.includes('flood120'), 'chat keeps its own cap (the last 100 lines)');
  await host.evaluate(() => {
    const el = document.getElementById('name-input');
    for (let k = 0; k < 210; k++) { el.value = `Al${k}`; el.dispatchEvent(new Event('change')); }
  });
  await logHas(guest, 'is now known as "Al209"');
  ok((await guest.$eval('#log', (el) => el.textContent)).includes('peeked at a face-down card'), '210 renames did not evict the peek either (renames share the chat cap)');
  await env.done();
})().catch(h.crash);
