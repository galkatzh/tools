// E2E: the trust boundary. "Mallory" is a RAW Trystero peer (no app code) that
// joins the room and sends hand-crafted payloads on every channel — exactly
// what a malicious guest with devtools can do. Nothing she sends may leak a
// hand, run code, demote the host, rewrite anyone's log, or break the table.
const h = require('./h');
const { ok, section, logHas } = h;

/** Boots Mallory: a bare trystero peer in her own page, wired to the room. */
async function mallory(env, invite) {
  const page = await env.page('Mallory');
  await page.goto(`${env.base}/cardtable/cah-cards.js`); // any same-origin page; we don't run the app
  await page.evaluate(async ({ invite, relay }) => {
    const { joinRoom } = await import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm');
    const [, roomId, password] = invite.match(/#room~([0-9a-f]+)~([0-9a-f]+)/);
    const room = joinRoom({ appId: 'gk-cardtable', password, relayConfig: { urls: [relay] } }, roomId);
    const M = (window.M = { room, got: { state: [], note: [] }, send: {} });
    for (const ch of ['act', 'state', 'decks', 'log', 'note', 'rules']) {
      const a = room.makeAction(ch);
      M.send[ch] = (data, target) => a.send(data, target ? { target } : {});
      a.onMessage = (m, { peerId }) => (M.got[ch] ||= []).push({ m, peerId });
    }
    await new Promise((r) => { const t = setInterval(() => { if (Object.keys(room.getPeers()).length >= 2) { clearInterval(t); r(); } }, 100); });
  }, { invite, relay: env.relayUrl });
  return page;
}
const MKEY = 'm'.repeat(32);
const MPID = 'ffffffffffffffff';
/** Bodies of all states Mallory received (signed rooms wrap them in {b,s,k}). */
const statesSeen = (m) => m.evaluate(() => window.M.got.state.map(({ m }) => (typeof m.b === 'string' ? JSON.parse(m.b) : m)));

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => location.href);
  ok(/#room~[0-9a-f]{24}~/.test(invite), 'new rooms get a 24-hex id (the host key fingerprint)');
  const ids = await host.evaluate(() => {
    const keys = Object.keys(localStorage);
    return { hostKey: keys.some((k) => k.startsWith('ct-hostkey-')), seatKey: keys.some((k) => /^ct-pid-key$/.test(k)) };
  });
  ok(ids.hostKey && ids.seatKey, 'host signing key and seat key are persisted');
  await guest.dblclick('.item.pile'); // Bob holds a secret card
  await h.waitHand(guest, 1);
  const bobPid = await guest.evaluate(() => localStorage.getItem('ct-pid'));
  const alicePid = await host.evaluate(() => localStorage.getItem('ct-pid'));
  const bobCard = await guest.evaluate(() => document.querySelector('.hcard').innerText);
  const M = await mallory(env, invite);
  ok(true, 'Mallory (raw peer) is in the room');

  section('impersonation');
  await M.evaluate(({ bob }) => window.M.send.act({ t: 'hello', _pid: bob, _name: 'Bob', _key: 'x'.repeat(32) }), { bob: bobPid });
  await M.waitForFunction(() => window.M.got.note.length > 0, null, { timeout: 10000 });
  const note = await M.evaluate(() => { const n = window.M.got.note[0].m; return typeof n.b === 'string' ? JSON.parse(n.b).msg : n.msg; });
  ok(/belongs to another player/.test(note), `claiming Bob's seat with a wrong key is refused ("${note}")`);
  await h.sleep(1500);
  const leaked = (await statesSeen(M)).some((s) => s.to === bobPid || (s.hand || []).length);
  ok(!leaked, "Mallory never receives Bob's hand");
  await M.evaluate(({ alice }) => window.M.send.act({
    t: 'setRules', enabled: true, name: 'x', code: '({ name: "pwn", setup() { window.PWNED = 1 } })', _pid: alice, _key: 'y'.repeat(32),
  }), { alice: alicePid });
  await h.sleep(1500);
  ok(!(await host.evaluate(() => window.PWNED)), "claiming the HOST's pid can't run code on the host");
  ok(!(await host.locator('#rules-btn').evaluate((el) => el.classList.contains('on'))), 'no rules were enabled');

  section('forged host messages');
  const itemsBefore = await guest.locator('.item').count();
  await M.evaluate(() => {
    const fake = { seq: 1e9, size: 1300, items: {}, players: {}, to: null, hand: [], fx: [], ann: ['HACKED'] };
    window.M.send.state(fake);                                  // unsigned
    window.M.send.state({ b: JSON.stringify(fake), s: 'AAAA', k: 'BBBB' }); // bogus signature
    window.M.send.log([{ p: 'RULES', txt: 'FORGED LOG', ts: Date.now() }]);
    window.M.send.note({ msg: 'FORGED NOTE' });
    window.M.send.decks({ deadbeef: { name: 'x', cards: [{ r: 'A', s: '♠' }] } });
  });
  await h.sleep(2000);
  ok((await guest.locator('.item').count()) === itemsBefore, "a forged state can't wipe the guest's table");
  ok(!(await guest.evaluate(() => document.getElementById('log').textContent.includes('FORGED'))), "a forged log can't rewrite the guest's record");
  ok(!(await guest.evaluate(() => document.getElementById('announce').textContent.includes('HACKED'))), 'forged announcements are dropped');
  ok(await host.evaluate(() => !document.getElementById('size-sel').classList.contains('hidden')), 'the real host was not demoted by a seq-1e9 state');
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 2);
  ok(true, 'the table keeps working afterwards');

  section('Mallory as a seated player: hostile payloads');
  await M.evaluate((k) => window.M.send.act({ t: 'hello', _pid: 'ffffffffffffffff', _name: '📜 Rules', _key: k }), MKEY);
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 3, null, { timeout: 10000 });
  ok(!(await host.evaluate(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.startsWith('📜')))), "a player can't pose as 📜 Rules");
  await M.evaluate((k) => window.M.send.act({ t: 'hello', _pid: 'eeeeeeeeeeeeeeee', _key: k }), MKEY);
  await h.sleep(800);
  ok((await host.locator('.seat').count()) === 3, 'one seat per connection (no seat farming)');
  const send = (a) => M.evaluate(({ a, pid, key }) => window.M.send.act({ ...a, _pid: pid, _key: key }), { a, pid: MPID, key: MKEY });
  const xss = 'x" onerror="window.PWNED=1';
  await send({ t: 'addDeck', deckId: '__proto__', x: 1e9, y: -1e9, deck: {
    name: '<img src=x onerror="window.PWNED=2">', back: 'javascript:window.PWNED=3', imgs: [xss],
    cards: [{ img: xss }, { g: 0, n: 'ok' }, { r: '<b>A', s: '♠' }, { txt: 'hi', col: 'red;background:url(//evil)', b: 'black' }],
  } });
  await logHas(host, 'added deck');
  await h.sleep(800);
  for (const [n, p] of [['host', host], ['guest', guest]]) {
    ok(!(await p.evaluate(() => window.PWNED)), `crafted deck runs no script on the ${n}`);
  }
  ok(await host.evaluate(() => [...document.querySelectorAll('.item')].every((el) => {
    const r = el.getBoundingClientRect(); return Number.isFinite(r.x) && Math.abs(r.x) < 1e5;
  })), 'absurd deck coordinates are clamped onto the felt');
  ok(await host.evaluate(() => Object.prototype.x === undefined && Object.prototype.cards === undefined), 'no prototype pollution from deckId "__proto__"');
  const pileId = await host.evaluate(() => document.querySelector('.item.pile').dataset.id);
  for (const id of ['__proto__', 'constructor', 'toString']) {
    await send({ t: 'move', id, x: 5, y: 5 }); await send({ t: 'flip', id }); await send({ t: 'del', id });
  }
  await send({ t: 'move', id: pileId, x: 'abc', y: null });
  await send({ t: 'rot', id: pileId, rot: 'NaN' });
  await h.sleep(1200);
  ok(await host.evaluate(() => Object.prototype.x === undefined && Object.prototype.z === undefined), 'crafted ids never reach Object.prototype');
  ok(await guest.evaluate((id) => {
    const el = document.querySelector(`.item[data-id="${id}"]`);
    return el && !/NaN/.test(el.style.left + el.style.top + el.style.transform);
  }, pileId), 'non-numeric coordinates/rotation are ignored (no NaN positions)');

  section('rules buttons are enforced by the engine');
  await h.enableRules(host, { tpl: 'holdem' });
  await host.waitForFunction(() => !document.querySelector('#rules-dialog[open]'));
  await host.click('#rules-btns [data-rbtn="new"]');
  await host.waitForSelector('#rules-btns [data-rbtn="call"]'); // Alice to act preflop (heads-up SB)
  const stacks = () => host.evaluate(() => [...document.querySelectorAll('.seat')].map((s) => s.textContent).join('|'));
  const before = await stacks();
  await send({ t: 'rulesBtn', id: 'call' }); // Alice's button, pressed by Mallory
  await send({ t: 'rulesBtn', id: 'fold' });
  await h.sleep(1200);
  ok((await stacks()) === before, "pressing another player's button changes nothing");
  ok(!(await host.evaluate(() => document.getElementById('log').textContent.includes('folds'))), 'no fold was applied');
  await env.done();
})().catch(h.crash);
