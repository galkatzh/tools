// E2E: rules-engine core — hook semantics, the t facade, lifecycle, and the
// engine-side UI hints. "Eve" is a raw Trystero peer (no app code) with her
// own seat, sending hand-crafted actions. The "Probe" script exposes the t
// facade to the test: its "run" button calls window.TEST(t) on the host.
const fs = require('fs');
const path = require('path');
const h = require('./h');
const { ok, section, logHas, toastHas } = h;

const PROBE = `({ name: 'Probe',
  setup(t) { t.data.n = (t.data.n || 0) + 1; t.say('setup n=' + t.data.n); },
  validate(t, a) { if (a.t === 'draw' && a.boom) return a.boom.x.y; },
  onAction(t, a) { if (a.t === 'play') t.say('onAction play ' + t.cardName(a)); },
  onChat(t, msg) { if (msg === 'ping') t.say('pong ' + Date.now()); },
  buttons: () => [{ id: 'run', label: 'Run' }],
  onButton(t) { window.TEST(t); },
  onTimer(t, tag) { t.say('timer ' + tag); },
})`;
const EPID = 'eeeeeeeeeeeeeeee', EKEY = 'e'.repeat(32);
const COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ecd444', '#ee6352', '#9ac2c9', '#8acb88', '#1be7ff'];

/** Opens the rules dialog, puts `code` in, optionally ticks Reset, presses Enable. */
async function enable(page, code, reset = false) {
  await page.click('#rules-btn');
  await page.waitForSelector('#rules-dialog[open]');
  await page.fill('#rules-code', code);
  if (reset) {
    if (await page.$('#rules-reset')) await page.check('#rules-reset');
    else ok(false, 'the rules dialog has a Reset game state box');
  }
  await page.click('#rules-enable');
}
const closeDialog = (page) => page.click('#rules-dialog button[value="cancel"]');
const logText = (page) => page.evaluate(() => document.getElementById('log').textContent);
const count = (s, sub) => s.split(sub).length - 1;
const rulesOn = (page) => page.locator('#rules-btn').evaluate((el) => el.classList.contains('on'));

/** Eve: a bare trystero peer in her own page, seated under her own pid/key. */
async function eve(env, invite) {
  const page = await h.rawPage(env, 'Eve'); // no app code: a raw Trystero peer
  await page.evaluate(async ({ invite, relay, pid, key, v }) => {
    const { joinRoom } = await import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm');
    const [, roomId, password] = invite.match(/#room~([0-9a-f]+)~([0-9a-f]+)/);
    const room = joinRoom({ appId: 'gk-cardtable', password, rtcPolyfill: window.RawRTC, relayConfig: { urls: [relay] } }, roomId);
    const act = room.makeAction('act'), state = room.makeAction('state');
    window.E = { states: [], send: (a) => act.send({ ...a, _pid: pid, _name: 'Eve', _key: key, _v: v }) };
    state.onMessage = (m) => E.states.push(m);
    await new Promise((r) => { const t = setInterval(() => { if (Object.keys(room.getPeers()).length >= 2) { clearInterval(t); r(); } }, 100); });
  }, { invite, relay: env.relayUrl, pid: EPID, key: EKEY, v: h.PROTO });
  return page;
}
/** What Eve's states add up to (snapshots and patches, h.viewFrom). */
const eveView = async (E) => h.viewFrom(h.bodies(await E.evaluate(() => window.E.states)));
const eveHand = async (E) => (await eveView(E)).hand.length;

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => location.href);
  /** Runs `body` (JS, `t` in scope) inside the Probe script's onButton on the host. */
  const run = async (body) => {
    await host.evaluate((b) => { window.TEST = new Function('t', b); }, body);
    await host.click('#rules-btns [data-rbtn="run"]');
  };
  /** A log round-trip: everything Eve/Bob sent before this has been applied. */
  const reprobe = async () => {
    await enable(host, PROBE);
    await host.waitForFunction(() => document.getElementById('rules-btn').classList.contains('on'), null, { timeout: 8000 });
  };
  /** Waits (bounded) for a host log line; false instead of a crash. */
  const seen = (txt, ms = 8000) => logHas(host, txt, ms).then(() => true, () => false);
  /** Pre-fix builds can lose the Probe rules mid-suite: put them back. */
  const ensureProbe = async () => { if (!(await rulesOn(host))) await reprobe(); };
  let pings = 0;
  const sync = async () => {
    await host.fill('#chat-input', 'ping');
    await host.press('#chat-input', 'Enter');
    await host.waitForFunction((n) => (document.getElementById('log').textContent.match(/pong/g) || []).length >= n, ++pings, { timeout: 10000 });
  };

  section('ENG-10: a script may end with a // comment');
  await enable(host, "({ name: 'Commented' }) // my game");
  await logHas(host, '«Commented» enabled', 8000).then(() => ok(true, 'a trailing // comment evaluates'), () => ok(false, 'a trailing // comment evaluates'));
  if (await host.$('#rules-dialog[open]')) await closeDialog(host);
  await enable(host, "({ name: 'Commented2' })\n// the end");
  await logHas(host, '«Commented2» enabled', 8000).then(() => ok(true, 'a final comment line evaluates'), () => ok(false, 'a final comment line evaluates'));
  if (await host.$('#rules-dialog[open]')) await closeDialog(host);

  section('ENG-3/EDGE-2: re-enabling the same game keeps its state; Reset starts fresh');
  await enable(host, PROBE);
  await logHas(host, 'setup n=1');
  await logHas(host, '«Probe» enabled by Alice');
  await enable(host, PROBE);
  await logHas(host, 'setup n=2', 8000).then(() => ok(true, 're-enable keeps t.data (setup sees n=2)'), () => ok(false, 're-enable keeps t.data (setup sees n=2)'));
  ok((await logText(host)).includes('(game state kept)'), 'the log says the game state was kept');
  await enable(host, PROBE, true);
  await host.waitForFunction(() => (document.getElementById('log').textContent.match(/setup n=1/g) || []).length === 2, null, { timeout: 8000 })
    .then(() => ok(true, 'Reset game state starts from empty t.data'), () => ok(false, 'Reset game state starts from empty t.data'));
  ok((await logText(host)).includes('(game state reset)'), 'the log says the game state was reset');
  if (await host.$('#rules-reset')) {
    await host.click('#rules-btn');
    ok(!(await host.isChecked('#rules-reset')), 'the Reset box is unticked again when the dialog reopens');
    await closeDialog(host);
    await guest.click('#rules-btn');
    ok(await guest.locator('#rules-reset-lbl').isHidden(), 'guests have no Reset box');
    await closeDialog(guest);
  }

  section('ENG-6: a broken edit leaves the running rules alone');
  await enable(host, "({ name: 'broken', ");
  await host.waitForFunction(() => document.getElementById('rules-err').textContent.length > 0);
  ok(await host.evaluate(() => !!document.querySelector('#rules-dialog[open]')), 'the dialog stays open with the error');
  await toastHas(host, 'running rules are unchanged').then(() => ok(true, 'the toast says the running rules are unchanged'), () => ok(false, 'the toast says the running rules are unchanged'));
  await closeDialog(host);
  ok(await rulesOn(host), 'rules are still ON on the host');
  await h.sleep(800);
  ok(await rulesOn(guest), 'rules are still ON for guests');
  if (!(await rulesOn(host))) await reprobe(); // (pre-fix: the edit killed them)
  await run("t.say('probe still runs')");
  await logHas(host, 'probe still runs', 8000).then(() => ok(true, 'the previous script keeps running'), () => ok(false, 'the previous script keeps running'));

  section('SEC-6/ENG-2: onAction never sees an action that did nothing');
  const E = await eve(env, invite);
  await E.evaluate(() => window.E.send({ t: 'hello' }));
  await logHas(host, 'Eve joined the table');
  await E.evaluate(() => window.E.send({ t: 'play', idx: 0, d: 'nope', i: 7, up: true, x: 600, y: 600 }));
  const items0 = await host.locator('.item').count();
  await E.evaluate(() => window.E.send({ t: 'chat', msg: 'eve-sent' }));
  await logHas(host, 'eve-sent');
  await sync();
  ok(!(await logText(host)).includes('onAction play'), 'a phantom play (card not in hand) never reaches onAction');
  ok((await host.locator('.item').count()) === items0, 'and nothing landed on the table');
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 1);
  await h.playFromHand(guest, 0, 0.62, 0.62);
  await logHas(host, 'onAction play').then(() => ok(true, 'a real play still reaches onAction'), () => ok(false, 'a real play still reaches onAction'));

  section('ENG-4: validate() that throws blocks the action (fail closed)');
  const pileId = Object.entries((await eveView(E)).items).find(([, it]) => it.k === 'p')[0];
  await E.evaluate((id) => window.E.send({ t: 'draw', id, boom: {} }), pileId);
  await logHas(host, 'script error in validate()');
  await logHas(host, 'blocked Eve').then(() => ok(true, 'the crashing draw is blocked and logged'), () => ok(false, 'the crashing draw is blocked and logged'));
  await sync().catch(() => {}); // rules are off now: no pong — just let the state settle
  await h.sleep(1000);
  ok((await eveHand(E)) === 0, "Eve's hand stayed empty");
  ok(!(await rulesOn(host)), 'the rules disabled themselves loudly');
  await reprobe();

  section('ENG-8: t.playFromHand refuses a bad index');
  await run(`const me = t.players().find((p) => p.name === 'Alice').id;
    t.draw(me, t.piles()[0].id, 2);
    t.say('pfh(-1) -> ' + t.playFromHand(me, -1) + ' / pfh(x) -> ' + t.playFromHand(me, 'x') + ', hand ' + t.hand(me).length);`);
  ok(await seen('pfh(-1) ->'), 'the probe ran');
  ok((await logText(host)).includes('pfh(-1) -> false / pfh(x) -> false, hand 2'), 'idx -1 and "x" play nothing (hand keeps 2 cards)');
  ok(await rulesOn(host), 'the refusal is not a script error');
  await ensureProbe();

  section('ENG-11: t.stack');
  await run(`const p = t.piles()[0].id;
    const a = t.deal(p, { x: 300, y: 300, up: true }), b = t.deal(p, { x: 500, y: 300, up: true });
    const id = t.stack(a.id, b.id);
    t.say('stack -> ' + (id ? 'pile of ' + t.items().find((it) => it.id === id).cards.length : id));`);
  ok(await seen('stack -> pile of 2'), 't.stack makes a 2-card pile');
  ok((await logText(host)).includes('stacked'), 'and logs it like the human op');
  await ensureProbe();

  section('ENG-12: script rotations and buttons() errors are on the record');
  await run("t.rot(t.piles()[0].id, 90);");
  ok(await seen('rotated'), 't.rot is logged');

  section('UX-13: text-only cards are named by their (quoted) text');
  await run(`const d = t.newDeck({ name: 'Txt', cards: [{ text: 'A very long white card text that goes on and on and on forever' }, { text: 'Short' }] });
    const p = t.newPile([{ d, i: 0 }, { d, i: 1 }], { x: 200, y: 600 });
    t.deal(p, { up: true, x: 700, y: 650 }); t.deal(p, { up: true, x: 820, y: 650 });`);
  await logHas(host, 'dealt “Short”').then(() => ok(true, 'a short text card is logged as “Short”'), () => ok(false, 'a short text card is logged as “Short”'));
  ok((await logText(host)).includes('dealt “A very long white card text that goes o…”'), 'long texts are truncated with …');

  section('UX-I7: public.facedown locks the face-down toggle');
  const alicePid = await host.evaluate(() => localStorage.getItem('ct-pid'));
  const fd = (page) => page.locator('#facedown-toggle').evaluate((el) => ({ on: el.classList.contains('on'), locked: el.classList.contains('locked'), title: el.title }));
  await run('t.public.facedown = true;');
  await guest.waitForFunction(() => document.getElementById('facedown-toggle').classList.contains('locked'), null, { timeout: 8000 })
    .catch(() => {});
  let g = await fd(guest);
  ok(g.on && g.locked && /rules require/.test(g.title), `facedown:true locks the guest toggle on with a tooltip (${JSON.stringify(g)})`);
  await guest.click('#facedown-toggle');
  await toastHas(guest, 'require face-down').then(() => ok(true, 'clicking it explains why'), () => ok(false, 'clicking it explains why'));
  ok((await fd(guest)).on, 'and it stays on');
  await run("t.draw(t.players().find((p) => p.name === 'Bob').id, t.piles()[0].id, 1);");
  await h.waitHand(guest, 1);
  await h.playFromHand(guest, 0, 0.4, 0.62);
  ok(await seen('Bob played a card face down'), 'the play lands face down');
  await run(`t.public.facedown = [${JSON.stringify(alicePid)}];`);
  await guest.waitForFunction(() => !document.getElementById('facedown-toggle').classList.contains('locked'), null, { timeout: 8000 }).catch(() => {});
  g = await fd(guest);
  ok(!g.on && !g.locked, "a pid list leaves other players' toggles to them");
  const a = await fd(host);
  ok(a.on && a.locked, 'and locks the listed player');
  await run('delete t.public.facedown;');
  await host.waitForFunction(() => !document.getElementById('facedown-toggle').classList.contains('on'), null, { timeout: 8000 }).catch(() => {});
  ok(!(await fd(host)).on, 'unset, the toggle is the player\'s own again (off)');
  await guest.click('#facedown-toggle');
  ok((await fd(guest)).on, 'and a plain click toggles it');
  await guest.click('#facedown-toggle');

  section('ENG-9: t.schedule rejects a non-numeric delay loudly');
  await run("t.schedule('soon', 'nan');");
  await toastHas(host, 't.schedule: seconds must be a number').then(() => ok(true, 'a NaN delay is a script error, not a silently dropped timer'), () => ok(false, 'a NaN delay is a script error, not a silently dropped timer'));
  const src = fs.readFileSync(path.join(h.APP_ROOT, 'cardtable/core.js'), 'utf8');
  const at = src.indexOf('function runTimers('), loop = src.slice(at, src.indexOf('\n  }\n', at));
  ok(at > 0 && count(loop, 'now()') === 1, 'the timer loop reads the clock once (no timer falls between the due/remaining filters)');

  section('ENG-12: a buttons() error disables the rules on the record');
  await enable(host, "({ name: 'BadButtons', buttons() { throw new Error('kaboom'); } })");
  await logHas(host, 'script error in buttons()').then(() => ok(true, 'the buttons() failure is logged'), () => ok(false, 'the buttons() failure is logged'));
  if (await host.$('#rules-dialog[open]')) await closeDialog(host);

  section('ENG-7/ENG-13: documented hook semantics');
  const doc = fs.readFileSync(path.join(h.APP_ROOT, 'cardtable/ENGINE.md'), 'utf8');
  ok(/nextSeat\(pid\)` \(the next seat clockwise whose player is \*\*online\*\*/.test(doc), 'ENGINE.md: nextSeat = next ONLINE seat');
  ok(/`onJoin` also fires on reconnect after a host reload\*\*,\s+without a\s+preceding `onLeave`/.test(doc), 'ENGINE.md: onJoin fires on reconnect after a host reload, without onLeave');
  ok(/`t\.stack\(cardId, ontoCardId\)`/.test(doc) && !doc.includes('toHand: true') && !doc.includes('Poker dealer'), 'ENGINE.md: t.stack documented, stale examples gone');
  ok(/`facedown` \(`true`, or a list of pids\)/.test(doc), 'ENGINE.md §4: public.facedown documented');

  section('EDGE-11: a newcomer gets a color no online player wears');
  await E.close();
  await guest.close();
  await host.waitForFunction(() => document.querySelectorAll('.seat.offline').length === 2, null, { timeout: 20000 });
  // Seven ghost seats (offline ex-players) wearing colors 2..8, as a long
  // session leaves behind; the old count-based pick then hands the next
  // newcomer color #1 — the host's own.
  await host.goto(`${env.base}/cardtable/style.css`); // pagehide saves the table
  const room = invite.match(/#room~([0-9a-f]+)/)[1], save = await h.idb(host, 'saves', room);
  const ps = save.state.players;
  for (const [p, pl] of Object.entries(ps)) if (pl.name !== 'Alice') delete ps[p];
  for (let i = 1; i < 8; i++) ps[`ab${i}`.padEnd(16, '0')] = { name: `Ghost${i}`, color: COLORS[i], online: false, hand: [], seat: 10 + i * 30 };
  await h.plantSave(host, room, save.state);
  await host.goto(invite);
  await host.waitForSelector('.item.pile .count');
  const carol = await env.page('Carol');
  await carol.goto(invite);
  await h.joinAs(carol, 'Carol');
  await host.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('Carol')), null, { timeout: 30000 });
  const cols = await host.evaluate(() => Object.fromEntries([...document.querySelectorAll('.seat')].map((s) => [s.textContent.split(' ')[0], s.style.borderColor])));
  ok(cols.Carol !== cols.Alice, `Carol's color differs from the host's (${cols.Carol} vs ${cols.Alice})`);
  await env.done();
})().catch(h.crash);
