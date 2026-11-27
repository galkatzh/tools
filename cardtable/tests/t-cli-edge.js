// Terminal bridge edge cases, checked against BOTH bridges (cli.js and cli.py
// must behave identically): the long-poll protocol, the bot API, the REPL,
// and the tab side (status toasts, restarts, notices, piles, hash parsing).
const h = require('./h');
const { ok, section } = h;
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const APP = path.join(h.APP_ROOT, 'cardtable');

// --- a scriptable bridge per language --------------------------------------
// stdin: JSON lines {send: cmd} | {play: idx|key} | {hold} | {playHeld: idx} |
// {bad} (send a NaN). stdout: READY port token url, STATE <json>, HELD,
// SEND REFUSED <msg>, WAIT REJECTED <msg>. Each driver also subscribes a listener
// that throws and a wait() whose predicate throws (EDGE-3).
const NODE_DRV = `
const { Bridge } = require(${JSON.stringify(path.join(APP, 'cli.js'))});
(async () => {
  const b = await new Bridge({ port: +process.argv[1] || 0, token: process.argv[2] || undefined }).ready;
  console.log('READY', b.port, b.token, b.urlFor('http://x/#room~ab~cd~cli~1-old', process.argv[3] || 'Bot'));
  b.on(() => { throw new Error('listener boom'); });
  b.wait((s) => s.hand[5].name === 'never', 600000).catch((e) => console.log('WAIT REJECTED', e.message));
  b.on((s) => console.log('STATE', JSON.stringify(s)));
  let held;
  require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
    const c = JSON.parse(l);
    if ('play' in c) b.play(c.play);
    else if ('hold' in c) { held = b.state; console.log('HELD'); }
    else if ('playHeld' in c) b.play(held.hand[c.playHeld]);
    else if ('bad' in c) { try { b.send({ t: 'move', id: 'p9', x: NaN, y: 0 }); } catch (e) { console.log('SEND REFUSED', e.message); } }
    else b.send(c.send);
  });
})();`;
const PY_DRV = `
import json, sys, threading
sys.path.insert(0, ${JSON.stringify(APP)})
from cli import Bridge
b = Bridge(port=int(sys.argv[1] or 0), token=sys.argv[2] or None)
def boom(s, p): raise RuntimeError('listener boom')
b.on(boom)
def waiter():
    try: b.wait(lambda s: s['hand'][5]['name'] == 'never', 600)
    except Exception as e: print('WAIT REJECTED', e, flush=True)
threading.Thread(target=waiter, daemon=True).start()
b.on(lambda s, p: print('STATE', json.dumps(s), flush=True))
# READY last, once every listener is on: the suite sends a state the moment it reads it
print('READY', b.port, b.token, b.url_for('http://x/#room~ab~cd~cli~1-old', sys.argv[3] or 'Bot'), flush=True)
held = None
for line in sys.stdin:
    c = json.loads(line)
    if 'play' in c: b.play(c['play'])
    elif 'hold' in c: held = b.state; print('HELD', flush=True)
    elif 'playHeld' in c: b.play(held['hand'][c['playHeld']])
    elif 'bad' in c:
        try: b.send(t='move', id='p9', x=float('nan'), y=0)
        except ValueError as e: print('SEND REFUSED', e, flush=True)
    else: b.send(**c['send'])
`;
const kids = [];
/** Spawns a stdout-line-driven child; .out(substr) waits for output containing substr. */
function child(cmd, args, label) {
  const c = spawn(cmd, args, { cwd: APP, stdio: ['pipe', 'pipe', 'pipe'] });
  kids.push(c);
  c.buf = '';
  c.stdout.on('data', (d) => { c.buf += d; });
  c.stderr.on('data', (d) => { c.buf += d; }); // Node's REPL reports ✗ errors on stderr
  c.out = (s, ms = 10000, from = 0) => waitFor(() => c.buf.indexOf(s, from) >= 0, ms, `${label}: "${s}"`);
  return c;
}
async function waitFor(fn, ms, what) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await h.sleep(100)) if (fn()) return true;
  console.error(`  (timed out waiting for ${what})`);
  return false;
}
/** A bridge driver: { lang, port, token, url, cmd(), play(), state(), until(pred) }. */
async function driver(lang, port = 0, token = '', name = '') {
  const c = lang === 'node' ? child('node', ['-e', NODE_DRV, String(port), token, name], 'node drv')
    : child('python3', ['-u', '-c', PY_DRV, String(port), token, name], 'py drv');
  // wait for the WHOLE line: print() may flush its arguments separately
  if (!(await waitFor(() => /READY \d+ \S+ \S+\n/.test(c.buf), 10000, `${lang}: READY line`))) throw new Error(`${lang} driver did not start: ${c.buf}`);
  const [, p, tok, url] = c.buf.match(/READY (\d+) (\S+) (\S+)/);
  const states = () => c.buf.split('\n').filter((l) => l.startsWith('STATE ')).map((l) => JSON.parse(l.slice(6)));
  return {
    lang, c, port: +p, token: tok, url,
    cmd: (send) => c.stdin.write(JSON.stringify({ send }) + '\n'),
    play: (idx) => c.stdin.write(JSON.stringify({ play: idx }) + '\n'),
    state: () => states().at(-1),
    until: (pred, ms = 15000, what = 'state') => waitFor(() => { const s = states().at(-1); return s && pred(s); }, ms, `${lang} ${what}`),
    /** Some state so far matched (msgs show up in ONE push, then they're delivered). */
    ever: (pred, ms = 15000, what = 'state') => waitFor(() => states().some(pred), ms, `${lang} ${what}`),
    kill: () => new Promise((r) => { c.on('exit', r); c.kill(); }),
  };
}

// --- a fake tab -------------------------------------------------------------
function req(port, p, { method = 'GET', body } = {}) {
  let r;
  const done = new Promise((resolve) => {
    r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 'ERR', body: e.message }));
    r.end(body);
  });
  return { done, abort: () => r.destroy() };
}
const SNAP = { pid: 'p1', name: 'Fake', role: 'guest', room: 'r', seq: 1, players: [], buttons: [], log: [], msgs: [],
  hand: [{ idx: 0, key: 'd0:5', name: 'A♠' }, { idx: 1, key: 'd0:9', name: 'K♥' }],
  items: [{ id: 'p9', kind: 'pile', name: 'Deck', count: 3, x: 0, y: 0, top: { name: 'Q♦' } }] };
const settle = (p, ms) => Promise.race([p, h.sleep(ms).then(() => null)]);
/** A response body re-serialized (Python's json.dumps spaces it differently). */
const body = (r) => { try { return JSON.stringify(JSON.parse(r.body)); } catch (e) { return r?.body; } };

async function protocol(lang) {
  section(`${lang} bridge protocol`);
  const d = await driver(lang, 0, '', 'B~2 😀');
  const q = `?token=${d.token}`;
  // EDGE-3: a throwing listener / wait() predicate must not fail the POST.
  const st = await req(d.port, `/state${q}`, { method: 'POST', body: JSON.stringify(SNAP) }).done;
  ok(st.status === 200, `${lang}: state accepted (200) although a listener throws (got ${st.status})`);
  ok(await d.until((s) => s.seq === 1, 5000), `${lang}: the listeners after the throwing one still run`);
  ok(await d.c.out('WAIT REJECTED', 5000), `${lang}: wait() whose predicate throws rejects with that error`);
  // EDGE-1: a reloaded tab's aborted poll must not swallow commands — sent
  // before the new tab's poll arrives, or after.
  const gone = req(d.port, `/poll${q}`);
  await h.sleep(300);
  gone.abort();
  await h.sleep(300);
  d.cmd({ t: 'chat', msg: 'early' });
  await h.sleep(300);
  const late = await settle(req(d.port, `/poll${q}`).done, 5000);
  ok(late && body(late) === JSON.stringify([{ t: 'chat', msg: 'early' }]), `${lang}: a command sent while the tab reloads waits for its next poll (got ${late?.body})`);
  const dead = req(d.port, `/poll${q}`);
  await h.sleep(300);
  dead.abort();
  await h.sleep(300);
  const fresh = req(d.port, `/poll${q}`);
  await h.sleep(300);
  d.cmd({ t: 'chat', msg: 'hi' });
  const got = await settle(fresh.done, 5000);
  ok(got && body(got) === JSON.stringify([{ t: 'chat', msg: 'hi' }]), `${lang}: the new poll gets the command, not the aborted one (got ${got?.body})`);
  // Two live polls (two tabs on one URL): the newest takes commands, the older is not answered with them.
  const older = req(d.port, `/poll${q}`);
  await h.sleep(300);
  const newer = req(d.port, `/poll${q}`);
  await h.sleep(300);
  d.cmd({ t: 'draw' });
  const n = await settle(newer.done, 5000);
  ok(n && body(n) === '[{"t":"draw"}]' && (await settle(older.done, 500)) === null, `${lang}: newest poll wins; the older one stays parked`);
  older.abort();
  // EDGE-6: Bridge.play(idx) names the card by key, resolved when called.
  const pp = req(d.port, `/poll${q}`);
  await h.sleep(300);
  d.play(1);
  const pr = await settle(pp.done, 5000);
  const cmd = pr && JSON.parse(body(pr) || '[]')[0];
  ok(cmd?.t === 'play' && cmd.idx === 1 && cmd.key === 'd0:9' && cmd.up === true, `${lang}: play(1) sends key d0:9 (got ${pr?.body})`);
  // play(card) from a state you hold survives a push that shifts the hand; play(key) works too.
  d.c.stdin.write('{"hold":1}\n');
  await d.c.out('HELD', 5000);
  const shifted = { ...SNAP, seq: 2, hand: [{ idx: 0, key: 'd0:9', name: 'K♥' }, { idx: 1, key: 'd0:7', name: '7♣' }] };
  await req(d.port, `/state${q}`, { method: 'POST', body: JSON.stringify(shifted) }).done;
  await d.until((s) => s.seq === 2, 5000);
  const ph = req(d.port, `/poll${q}`);
  await h.sleep(300);
  d.c.stdin.write('{"playHeld":1}\n');
  d.play('d0:7');
  await h.sleep(300);
  const held = JSON.parse(body(await settle(ph.done, 5000) || {}) || '[]');
  const restP = req(d.port, `/poll${q}`); // the 2nd play may have ridden along in the 1st poll
  const rest = JSON.parse(body(await settle(restP.done, 2000) || {}) || '[]');
  restP.abort(); // or this parked poll would take the next command
  const both = [...held, ...rest].map((x) => `${x.idx}/${x.key}`).join(' ');
  ok(both === '1/d0:9 null/d0:7', `${lang}: play(heldState.hand[1]) sends the held card d0:9, play('d0:7') by key (got ${both})`);
  // NaN/Infinity are not JSON: send() refuses them instead of poisoning a poll batch.
  d.c.stdin.write('{"bad":1}\n');
  ok(await d.c.out('SEND REFUSED', 5000), `${lang}: send() with a NaN raises`);
  await h.sleep(300);
  const afterP = req(d.port, `/poll${q}`);
  await h.sleep(300);
  d.cmd({ t: 'chat', msg: 'after' });
  const after = await settle(afterP.done, 5000);
  ok(after && body(after) === '[{"t":"chat","msg":"after"}]', `${lang}: nothing of the refused command was queued (got ${after?.body})`);
  // EDGE-12: '~' (and everything else) in a bot name is escaped in the URL.
  ok(d.url.endsWith('~cli~' + d.port + '-' + d.token + '~as~B%7E2%20%F0%9F%98%80'), `${lang}: url_for escapes "~" (${d.url})`);
  return d;
}

/** Starts the REPL (cli.js / cli.py) and plays the tab with raw HTTP. */
async function replChecks(lang) {
  section(`${lang} REPL`);
  const c = lang === 'node' ? child('node', [path.join(APP, 'cli.js'), 'http://x/#room~ab~cd'], 'node repl')
    : child('python3', ['-u', path.join(APP, 'cli.py'), 'http://x/#room~ab~cd'], 'py repl');
  await c.out('~cli~');
  const [, port, token] = c.buf.match(/~cli~(\d+)-(\w+)/);
  const q = `?token=${token}`;
  await req(port, `/state${q}`, { method: 'POST', body: JSON.stringify(SNAP) }).done;
  await c.out('tab connected');
  const type = async (line, expect) => { const from = c.buf.length; c.stdin.write(line + '\n'); return c.out(expect, 5000, from); };
  // EDGE-15: missing / bad arguments are reported, not sent as NaN or a bare IndexError.
  ok(await type('move p9 12', 'move <id> <x> <y>'), `${lang}: "move p9 12" prints the usage`);
  ok(await type('move p9 a b', 'move <id> <x> <y>'), `${lang}: "move p9 a b" prints the usage`);
  for (const v of ['nan', 'inf', 'Infinity']) ok(await type(`move p9 ${v} 1`, 'move <id> <x> <y>'), `${lang}: "move p9 ${v} 1" prints the usage (finite numbers only)`);
  ok(await type('flip', 'flip <id>'), `${lang}: "flip" without an id prints the usage`);
  ok(await type('btn', 'btn <id>'), `${lang}: "btn" without an id prints the usage`);
  // EDGE-9: the face-up top of a pile is listed.
  ok(await type('table', 'top: Q♦'), `${lang}: "table" shows a pile's face-up top card`);
  // EDGE-6: repeated indices play once, by key; EDGE-9: discard onto a pile.
  const p1 = req(port, `/poll${q}`);
  await h.sleep(200);
  c.stdin.write('play 1 1\n');
  const r1 = await settle(p1.done, 5000);
  await h.sleep(300);
  const r2 = await settle(req(port, `/poll${q}`).done, 1000); // anything left over?
  const all = [...JSON.parse(r1?.body || '[]'), ...JSON.parse(r2?.body || '[]')];
  ok(all.length === 1 && all[0].key === 'd0:9', `${lang}: "play 1 1" sends ONE play of card d0:9 (got ${JSON.stringify(all)})`);
  const p2 = req(port, `/poll${q}`);
  await h.sleep(200);
  c.stdin.write('discard 0 Deck\n');
  const r3 = JSON.parse((await settle(p2.done, 5000))?.body || '[]')[0];
  ok(r3?.t === 'discard' && r3.idx === 0 && r3.key === 'd0:5' && r3.pile === 'Deck', `${lang}: "discard 0 Deck" (got ${JSON.stringify(r3)})`);
  return c;
}

/** Runs one section; a crash (e.g. against an older app) fails it, not the suite. */
async function step(name, fn) {
  section(name);
  try { await fn(); } catch (e) { ok(false, `${name}: crashed: ${e.message.split('\n')[0]}`); }
}
/** Waits for a fresh toast containing txt. */
async function toastSoon(page, txt, ms = 15000) {
  try { await h.toastHas(page, txt, ms); return true; } catch (e) { console.error('  toast now:', await page.textContent('#toast')); return false; }
}
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
/** Re-opens the page on the invite + hash extras (a hash change alone doesn't re-boot). */
async function open(page, url) { await page.goto(url); await page.reload(); await page.waitForSelector('.item.pile .count', { timeout: 30000 }); }

(async () => {
  const env = await h.start({ quietConsole: true });
  await Promise.all(['node', 'python'].map((l) => protocol(l).catch((e) => ok(false, `${l} protocol crashed: ${e.message}`))));
  const repls = await Promise.all(['node', 'python'].map((l) => replChecks(l).catch((e) => ok(false, `${l} REPL crashed: ${e.message}`))));
  const replsIdle = Date.now();

  const { host, guest } = await h.hostAndGuest(env);
  let hb, hb2, gb; // host seat bridges (Node, then a Python restart) and the guest's (Node)
  const inv = await host.evaluate(() => location.href);

  await step('tab: bridge status is visible (EDGE-4)', async () => {
    await open(host, `${inv}~cli~${await freePort()}-tok123`);
    ok(await toastSoon(host, 'not reachable'), 'a ~cli~ tab with no bridge running says so');
    hb = await driver('node', 0, 'good');
    await open(host, `${inv}~cli~${hb.port}-bad`);
    ok(await toastSoon(host, 'rejected'), 'a stale token is reported as such');
  });

  await step('tab: a broken bridge reply is shown as the error it is (EDGE-4)', async () => {
    // A bridge that answers, but badly: 500 on /poll, then a body that isn't JSON.
    let mode = '500';
    const srv = http.createServer((rq, rs) => {
      const poll = rq.url.startsWith('/poll');
      rs.writeHead(poll && mode === '500' ? 500 : 200, { 'Access-Control-Allow-Origin': '*' });
      rs.end(poll ? (mode === '500' ? 'boom' : 'NaN') : 'ok');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await open(host, `${inv}~cli~${srv.address().port}-tok`);
    ok(await toastSoon(host, 'Terminal bridge error: bridge poll failed (500)'), 'a 500 from the bridge is toasted as that error');
    mode = 'nan';
    ok(await toastSoon(host, 'JSON'), 'an unparsable poll reply is toasted as a JSON error');
    ok(!(await host.textContent('#toast')).includes('not reachable'), 'neither is labelled "not reachable"');
    srv.closeAllConnections();
    srv.close();
  });

  await step('tab: a restarted bridge gets the state (EDGE-5)', async () => {
    await open(host, `${inv}~cli~${hb.port}-good`);
    ok(await hb.until((s) => s.role === 'host'), 'host seat bridged');
    await hb.kill();
    hb2 = await driver('python', hb.port, 'good'); // same port + token (and the other language)
    ok(await hb2.until((s) => s.role === 'host', 15000), 'the restarted bridge receives the state without a table change');
  });

  await step('tab: plays name cards, not shifting indices (EDGE-6)', async () => {
    for (let k = 0; k < 4; k++) hb2.cmd({ t: 'draw' });
    ok(await hb2.until((s) => s.hand.length === 4 && s.hand.every((c) => c.key)), 'drew 4 (each hand card has a key)');
    const keys = hb2.state().hand.map((c) => c.key);
    hb2.play(0); hb2.play(1);
    ok(await hb2.until((s) => s.hand.length === 2), 'played 2');
    ok(JSON.stringify(hb2.state().hand.map((c) => c.key)) === JSON.stringify(keys.slice(2)), 'host seat: play(0); play(1) played the cards that were #0 and #1');
  });

  await step('tab: piles show a face-up top; discard onto a pile (EDGE-9)', async () => {
    const pile = hb2.state().items.find((it) => it.kind === 'pile');
    hb2.cmd({ t: 'flip', id: pile.id });
    ok(await hb2.until((s) => s.items.find((it) => it.id === pile.id)?.top?.name), 'a flipped pile reports its top card');
    const key = hb2.state().hand[1].key;
    hb2.cmd({ t: 'discard', idx: 1, key, pile: pile.id });
    ok(await hb2.until((s) => s.hand.length === 1 && s.items.find((it) => it.id === pile.id)?.count === pile.count + 1), 'discard put the hand card onto the pile');
    ok(await hb2.until((s) => s.log.some((e) => /put .* from hand onto/.test(e.text))), 'logged as a hand→pile move');
  });

  await step('tab: private notices reach the terminal (EDGE-7)', async () => {
    gb = await driver('node');
    await open(guest, `${inv.replace(/~cli~.*$/, '')}~cli~${gb.port}-${gb.token}`);
    ok(await gb.until((s) => s.role === 'guest'), 'guest seat bridged');
    await h.enableRules(host, { code: `({ name: 'Notices',
      validate(t, a) { if (a.t === 'shuffle') return 'No shuffling'; },
      onChat(t, msg, p) { if (msg === '!ping') t.tell(p, 'pong for ' + t.players().find((x) => x.id === p).name); } })` });
    await h.logHas(host, 'enabled by');
    for (const d of [hb2, gb]) { d.cmd({ t: 'chat', msg: '!ping' }); d.cmd({ t: 'shuffle' }); }
    for (const [d, who] of [[hb2, 'host'], [gb, 'guest']]) {
      ok(await d.ever((s) => s.msgs.some((m) => m.startsWith('note: pong for')), 15000, 'tell'), `${who} seat: t.tell() reaches the bridge`);
      ok(await d.ever((s) => s.msgs.includes('note: 🚫 No shuffling'), 15000, 'veto'), `${who} seat: a veto reaches the bridge`);
    }
    const log = gb.state().log;
    ok(log.some((e) => e.rules) && log.every((e) => !!e.rules === (e.who === '📜 Rules')), 'log lines by the script carry rules: true (EDGE-8)');
  });

  await step('tab: hash extras (EDGE-12, EDGE-13)', async () => {
    // Fresh contexts where a human already saved a name ('Human').
    const page = async (label) => {
      const pg = await env.page(label);
      await pg.context().addInitScript(() => localStorage.getItem('ct-name') || localStorage.setItem('ct-name', 'Human'));
      return pg;
    };
    const bot = await page('bot');
    const name = 'B~' + 'x'.repeat(21) + '😀z';
    await open(bot, inv + (await driver('python', 0, '', name)).url.match(/~as~.*$/)[0]);
    const n = await bot.inputValue('#name-input');
    ok(n === name.slice(0, -1), `"~" survives the CLI's URL and the name is cut at 24 code points, not mid-emoji (got ${JSON.stringify(n)})`);
    await bot.fill('#name-input', 'Robo');
    await bot.press('#name-input', 'Enter');
    await h.logHas(host, 'is now known as "Robo"');
    ok(await bot.evaluate(() => localStorage.getItem('ct-name')) === 'Human', 'renaming a bot tab keeps the human\'s saved name');
    const bad = await page('bad');
    await open(bad, `${inv}~as~100%`);
    ok(await toastSoon(bad, 'malformed'), 'a malformed hash extra is reported and the table still boots');
  });

  await step('REPL: commands typed while the tab is gone warn (EDGE-15)', async () => {
    // The fake tabs above stopped calling in; a live one re-polls every ≤20 s.
    await h.sleep(26000 - (Date.now() - replsIdle));
    for (const [c, lang] of [[repls[0], 'node'], [repls[1], 'python']]) {
      const from = c.buf.length;
      c.stdin.write('draw\n');
      ok(await c.out('tab not seen for', 5000, from), `${lang}: a command queued for a silent tab warns`);
    }
  });
  for (const k of kids) k.kill();
  await env.done();
})().catch((e) => { for (const k of kids) k.kill(); h.crash(e); });
