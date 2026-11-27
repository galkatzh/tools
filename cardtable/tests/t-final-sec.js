// Final review, the trust boundary against a raw peer ("Mallory", final-lib):
// control characters never survive a deck (SEC-F5), guests share one deck
// budget so they can't fill the host's storage (SEC-F1), the record of a peek
// survives an action flood (SEC-F3), a burst of actions can't freeze the host
// (SEC-F2), a refused rules button never reaches the script (QUAL-4), and
// the network gate (D302) refuses an action nested too deep, a seat key too
// long, and a new player id from a page that rejoins, and lets new players
// in in the order they came: fresh connections that knock every 150 ms
// can't keep a newcomer out (D317); a connection waiting in line pays for its
// actions whatever player id each names, is logged in a few lines, and gives
// up its place once its player gets in another way (D318).
const h = require('./h');
const { ok, section, logHas } = h;
const { mallory, churner, knocker } = require('./final-lib');

/** The host's saved decks (the room's catalog), and its save record. */
const savedDecks = async (page) => (await h.idb(page, 'catalog')).map((r) => r.deck);
const savedTable = (page) => page.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]).then((room) => h.idb(page, 'saves', room));
const logText = (page) => page.textContent('#log');

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const M = await mallory(env, await host.evaluate(() => location.href));
  await M.act({ t: 'hello' });
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 3, null, { timeout: 15000 });
  const pileId = await host.evaluate(() => document.querySelector('.item.pile').dataset.id);

  section('SEC-F5: control characters never survive a deck');
  await M.act({ t: 'addDeck', deck: { name: '\x1b[2J\x1b]0;PWNED\x07Evil', cards: [{ n: 'N\x1b[31m\x9b', txt: 'line1\nline2\x1b[0m' }] } });
  await logHas(host, 'PWNED');
  const lines = (await logText(host)) + (await logText(guest));
  ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(lines) && lines.includes('added deck "[2J]0;PWNEDEvil"'), 'the deck name reaches the log without its ESC/BEL bytes');
  let evil;
  for (let k = 0; k < 40 && !evil; k++, await h.sleep(250)) evil = (await savedDecks(host)).find((d) => d.name.includes('PWNED'));
  ok(evil?.cards[0].n === 'N[31m' && evil.cards[0].txt === 'line1\nline2[0m', `card names and texts are stripped too, a text keeps its newline (${JSON.stringify(evil?.cards[0])})`);

  section('SEC-F1: guests share one deck budget');
  await M.evaluate(() => {
    const big = (k) => ({ name: 'Big' + k, cards: Array.from({ length: 2000 }, (_, i) => ({ txt: String(i).padEnd(300, 'x') })) }); // ≈ 0.62M chars
    for (let k = 1; k <= 3; k++) window.M.act({ t: 'addDeck', deck: big(k) });
  });
  await logHas(host, 'added deck "Big2"', 30000);
  const full = await M.waitForFunction(() => window.M.notes().some((n) => /deck budget for guests is full/.test(n.msg || '')), null, { timeout: 30000 }).then(() => true, () => false);
  ok(full, 'the third 0.6M-char deck from a guest is refused: the guests\' budget is full');
  await h.sleep(1500);
  ok(!(await logText(host)).includes('added deck "Big3"'), 'and it never reaches the table');
  let save;
  for (let k = 0; k < 40 && !(save?.state?.guestDeckChars > 1e6); k++, await h.sleep(250)) save = await savedTable(host);
  ok(save?.state?.guestDeckChars > 1e6 && !save.lost, `the budget used is saved with the table (${save?.state?.guestDeckChars}), and the table still saves`);

  section('SEC-F3: an action flood cannot push a peek out of the log');
  await M.act({ t: 'deal', id: pileId, up: false, x: 300, y: 300 });
  await logHas(host, 'Mallory dealt a card face down');
  const cardId = await host.evaluate(() => [...document.querySelectorAll('.item:not(.pile)')].at(-1).dataset.id);
  await M.act({ t: 'peek', id: pileId });
  await M.waitForFunction(() => window.M.notes().some((n) => n.peek), null, { timeout: 10000 });
  await logHas(guest, 'Mallory peeked at the top card');
  // 210 cheap actions, paced under the action rate limit (they must all land)
  await M.evaluate(async ({ pileId, cardId }) => {
    for (let k = 0; k < 210; k++) {
      window.M.act({ t: 'rot', id: k % 2 ? pileId : cardId, rot: k % 4 < 2 ? 0 : 90 });
      await new Promise((r) => setTimeout(r, 65));
    }
  }, { pileId, cardId });
  await host.waitForFunction(() => (document.getElementById('log').textContent.match(/rotated/g) || []).length >= 195, null, { timeout: 20000 }).catch(() => {});
  await h.sleep(1500);
  ok(((await logText(host)).match(/rotated/g) || []).length >= 195, 'the 210 rotations landed (and filled the action log)');
  ok((await logText(guest)).includes('Mallory peeked at the top card') && (await logText(host)).includes('Mallory peeked at the top card'), 'the peek is still on everyone\'s record');

  section('SEC-F2: a burst of actions cannot freeze the host');
  const meter = () => { window.LAG = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); window.LAG = Math.max(window.LAG, n - last - 50); last = n; }, 50); };
  await host.evaluate(meter);
  await M.evaluate(({ pileId, cardId }) => { for (let k = 0; k < 5000; k++) window.M.act({ t: 'rot', id: k % 2 ? pileId : cardId, rot: (k * 7) % 360 }); }, { pileId, cardId });
  const slowed = await M.waitForFunction(() => window.M.notes().some((n) => /Too many actions/.test(n.msg || '')), null, { timeout: 30000 }).then(() => true, () => false);
  ok(slowed, 'the flooding guest is told to slow down');
  await h.sleep(6000);
  const lag = await host.evaluate(() => window.LAG);
  ok(lag < 1000, `the host's main thread never stalled for a second (worst ${lag | 0} ms)`);
  await guest.dblclick('.item.pile', { force: true }); // (the guests' decks lie on top of the Standard one)
  await h.waitHand(guest, 1);
  ok(true, 'the table still answers Bob');

  section('D302: the gate — an action nested too deep, a seat key too long, a new player per reconnect');
  await h.sleep(5000); // (one refusal notice per 10 s per peer: SEC-F2's may still hold Mallory's back)
  await M.evaluate(() => window.M.deep({ t: 'chat', msg: 'deep-off' }, 100000)); // (a junk field 100,000 arrays deep: JSON.parse takes it, a structured clone can't)
  ok(await M.waitForFunction(() => window.M.notes().some((n) => n.msg === '🚫 Malformed action'), null, { timeout: 10000 }).then(() => true, () => false), 'a chat with a field 100,000 arrays deep: Mallory is told "🚫 Malformed action"');
  await M.act({ t: 'chat', msg: 'after-deep' });
  await logHas(host, 'after-deep');
  ok(!(await logText(host)).includes('deep-off') && !/Error/.test(await host.textContent('#toast')), 'nothing of it reached the log, and the host shows no error (with the rules off, its copy for the hooks overflowed the stack)');
  // A page that leaves and joins again: one player for good, and its seat key bounded.
  const S = await h.rawPage(env, 'Sock');
  await S.evaluate(async ({ invite, relay, v }) => {
    const { joinRoom } = await import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm');
    const [, roomId, password] = invite.match(/#room~([0-9a-f]+)~([0-9a-f]+)/);
    const S = (window.S = { notes: [] });
    S.join = async () => {
      if (S.room) { await S.room.leave(); await new Promise((r) => setTimeout(r, 1000)); }
      S.room = joinRoom({ appId: 'gk-cardtable', password, rtcPolyfill: window.RawRTC, relayConfig: { urls: [relay] } }, roomId);
      const act = S.room.makeAction('act'), note = S.room.makeAction('note');
      note.onMessage = (m) => S.notes.push((typeof m.b === 'string' ? JSON.parse(m.b) : m).msg);
      S.send = (pid, key, a) => act.send({ _v: v, _pid: pid, _name: 'Sock', _key: key, ...a });
      await new Promise((res) => { const t = setInterval(() => { if (Object.keys(S.room.getPeers()).length >= 3) { clearInterval(t); res(); } }, 100); });
    };
    await S.join();
  }, { invite: await host.evaluate(() => location.href), relay: env.relayUrl, v: h.PROTO });
  const players = () => host.evaluate(() => Object.keys(window.__ct.view().players));
  const told = (msg) => S.waitForFunction((m) => window.S.notes.includes(m), msg, { timeout: 10000 }).then(() => true, () => false);
  const D = 'd'.repeat(16), E = 'e'.repeat(16);
  await S.evaluate((D) => window.S.send(D, 'q'.repeat(1e6), { t: 'chat', msg: 'big key' }), D);
  ok(await told('🚫 Invalid seat key') && !(await players()).includes(D), 'a seat key of a million characters: "🚫 Invalid seat key", no player registered');
  await S.evaluate((D) => window.S.send(D, 'k'.repeat(32), { t: 'chat', msg: 'sock in' }), D);
  await logHas(host, 'sock in');
  const rec = await savedTable(host);
  ok((await players()).includes(D) && JSON.stringify(rec).length < 1e6, `with a key of 32 it registers, and the save stays small (${JSON.stringify(rec).length} chars)`);
  await h.sleep(10500); // (the next refusal's notice)
  await S.evaluate(() => window.S.join());
  await S.evaluate((E) => window.S.send(E, 'k'.repeat(32), { t: 'chat', msg: 'sock as e' }), E);
  ok(await told('🚫 One seat per connection') && !(await players()).includes(E), 'it leaves and joins again under a new player id: "🚫 One seat per connection", no new player');
  await S.evaluate((D) => window.S.send(D, 'k'.repeat(32), { t: 'chat', msg: 'sock back' }), D);
  await logHas(host, 'sock back');
  ok(!(await logText(host)).includes('sock as e'), 'under its own id it is back at the table');

  section('QUAL-4: a refused rules button never reaches the script');
  await h.enableRules(host, { code: `({ name: 'Spy',
    buttons: () => [{ id: 'real', label: 'Real' }],
    onButton(t, id) { t.say('pressed ' + id); },
    onAction(t, a) { if (a.t === 'rulesBtn') t.say('onAction saw rulesBtn ' + a.id); },
  })` });
  await logHas(guest, '«Spy» enabled');
  await h.sleep(2500); // Mallory's action budget refills
  await M.act({ t: 'rulesBtn', id: 'ghost' });
  await M.waitForFunction(() => window.M.notes().some((n) => /not available/.test(n.msg || '')), null, { timeout: 10000 });
  await guest.click('#rules-btns [data-rbtn="real"]');
  await logHas(host, 'onAction saw rulesBtn real');
  ok(!(await logText(host)).includes('saw rulesBtn ghost'), 'onAction saw the offered button, never the refused one');

  section('D317: new players get in in the order they came — fresh connections knocking every 150 ms keep no one out');
  {
    const invite = await host.evaluate(() => location.href), names = () => host.evaluate(() => Object.values(window.__ct.view().players).map((pl) => pl.name));
    const churners = await Promise.all([1, 2, 3, 4].map((k) => churner(env, invite, k))), all = () => churners.flatMap((c) => c.at).sort((a, b) => a - b);
    const t0 = Date.now();
    while (all().length < 22 && Date.now() - t0 < 90000) await h.sleep(500);
    ok(all().length >= 22, `4 churners drain the table's ${20} new players at once and take each one as it comes back (${all().length} in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    const dee = await env.page('Dee');
    await dee.goto(invite);
    await h.joinAs(dee, 'Dee');
    const tb = Date.now();
    let inAt = 0;
    while (!inAt && Date.now() - tb < 30000) { if ((await names()).includes('Dee')) inAt = Date.now(); else await h.sleep(250); }
    const ahead = all().filter((t) => t > tb && t < (inAt || Infinity)).length;
    ok(inAt && ahead <= 5, `Dee knocks every 3 s among them and gets in after ${inAt ? `${((inAt - tb) / 1000).toFixed(1)} s` : 'more than 30 s'}, ${ahead} churned players ahead of her (at most one per churner that came first)`);

    section('D318: a connection waiting in line pays for its actions, whatever player id each one names, and is logged in a few lines');
    {
      const W = await knocker(env, invite, null, 0), lines = [];
      const seen = (m) => { if (m.text().includes(W.peer)) lines.push(m.text()); };
      host.on('console', seen);
      const secs = await W.flood(2000); // (each hello under a fresh player id: before, each opened a flood budget of 40)
      const t1 = Date.now();
      while (!lines.some((l) => l.startsWith('refused ') && l.includes(' more actions from ')) && Date.now() - t1 < 15000) await h.sleep(250);
      host.off('console', seen);
      const each = lines.filter((l) => l.startsWith('refused an action from')), rest = lines.find((l) => / more actions from /.test(l)) || '';
      const count = (re) => each.filter((l) => re.test(l)).length + Number(rest.match(new RegExp(`(\\d+) × ${re.source}`))?.[1] || 0);
      const joining = count(/Many players are joining/), slow = count(/Too many actions/), all = each.length + Number(rest.match(/^refused (\d+) more/)?.[1] || 0);
      ok(each.length <= 5 && rest && all >= 1999, `the host logs ${each.length} refusals a line each, then one line for the rest (${all} in all): ${JSON.stringify(rest.slice(0, 220))}`);
      ok(joining <= 40 + 20 * (secs + 3) && slow >= 1999 - joining, `${joining} reach the line (a burst of 40, then 20 a second; sent in ${secs.toFixed(1)} s), ${slow} are refused as too many — before, each fresh id passed with its own budget`);
      await W.stop();
    }

    section('D318: a connection in line whose player gets in through another one gives up its place');
    {
      const P = 'b0b0b0b0b0b0b0b0', Y = await knocker(env, invite, P, 150);
      await h.sleep(300);
      const X = await knocker(env, invite, P, 1000), waiting = () => host.evaluate(() => window.__ct.waiting());
      let both = false;
      for (const t0 = Date.now(); !both && Date.now() - t0 < 10000; await h.sleep(200)) { const w = await waiting(); both = w.includes(Y.peer) && w.includes(X.peer); }
      ok(both, 'two connections of one new player both wait in line, while the churners keep the table full');
      for (const c of churners) await c.stop(); // (their connections leave the line: the two are next)
      let inAt = 0; // (the one ahead takes the next token; the other, knocking again, is that player's second connection)
      for (const t0 = Date.now(); !inAt && Date.now() - t0 < 15000; await h.sleep(200)) if ((await Y.registered()) && (await X.registered())) inAt = Date.now();
      const w = await waiting();
      ok(inAt && !w.includes(X.peer) && !w.includes(Y.peer), `both get in, and neither is still in line (${inAt ? `${w.length} waiting` : 'not both in within 15 s'}) — before, the one let in as a second connection kept its place for 9 s`);
      await X.stop();
      await Y.stop();
    }
  }
  await env.done();
})().catch(h.crash);
