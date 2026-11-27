// Final review, the terminal bridges: no peer text can put control
// characters on a terminal (SEC-F5); a terminal "play" honours the rules'
// face-down hint (QUAL-2); text cards print once, in full (QUAL-3); cli.py
// logs the protocol errors its server answers (QUAL-8).
const h = require('./h');
const { ok, section, logHas } = h;
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { mallory } = require('./final-lib');

const APP = path.join(h.APP_ROOT, 'cardtable');
const ESC = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
/** cli.js as a child process: wait(substr) resolves once stdout contains it. */
function cli(invite) {
  const child = spawn('node', [path.join(APP, 'cli.js'), invite], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => process.stderr.write(`[cli.js:err] ${d}`));
  child.out = () => buf;
  child.wait = async (s, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await h.sleep(200)) if (buf.includes(s)) return buf;
    throw new Error(`timeout waiting for "${s}"`);
  };
  return child;
}

(async () => {
  const env = await h.start();
  const { host, guest: bob } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);
  const term = cli(invite);
  const url = (await term.wait('~cli~')).match(/(http:\S+~cli~\S+)/)[1];
  await bob.goto(url);
  await bob.reload(); // hash-only navigation doesn't re-run boot
  await bob.waitForSelector('.item.pile .count', { timeout: 30000 });
  await term.wait('✅ tab connected: Bob');
  ok(true, "cli.js drives Bob's seat");

  section('SEC-F5: control characters never reach the terminal');
  const M = await mallory(env, invite);
  await M.act({ t: 'hello' });
  await M.act({ t: 'addDeck', deck: { name: '\x1b[2J\x1b]0;PWNED\x07Evil', cards: [{ txt: 'x' }] } });
  await term.wait('PWNED');
  await M.close();
  await h.enableRules(host, { code: "({ name: 'Shouty', setup(t) { t.say('\\x1b]52;c;cGF3bmVk\\x07 clipboard \\x9b31m') } })" });
  await term.wait('clipboard');
  ok(!ESC.test(term.out()), 'neither a guest\'s deck name nor a script\'s log line puts a control byte on the terminal');
  ok(term.out().includes('added deck "[2J]0;PWNEDEvil"'), 'the visible text still arrives');
  const py = spawnSync('python3', ['-I', '-B', '-c', `
import sys, socket, time, io, contextlib
sys.path.insert(0, ${JSON.stringify(APP)})
import cli
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    cli.out('\\x1b[2Jhi\\nthere\\x07')
    print(cli.fmt_card({'name': '“' + 'w' * 39 + '…”', 'text': 'w' * 60}))
b = cli.Bridge()
err = io.StringIO()
with contextlib.redirect_stderr(err):
    s = socket.create_connection(('127.0.0.1', b.port)); s.sendall(b'GARBAGE\\r\\n\\r\\n'); s.recv(1000); s.close(); time.sleep(0.3)
print(repr(buf.getvalue())); print('STDERR', repr(err.getvalue()))
`], { encoding: 'utf8', timeout: 20000 });
  const outLine = py.stdout.split('\n')[0];
  ok(outLine === "'[2Jhi\\nthere\\n“" + 'w'.repeat(60) + "”\\n'", `cli.py prints without control bytes and shows a long text card once, in full (${outLine})`);
  ok(/STDERR .*code 400/.test(py.stdout), `cli.py logs a bad request it answered with 400 (QUAL-8: ${py.stdout.split('\n').find((l) => l.startsWith('STDERR')) || py.stderr})`);

  section('QUAL-2 / QUAL-3: CAH from the terminal');
  host.on('dialog', (d) => d.accept().catch((e) => console.error(e)));
  await h.enableRules(host, { tpl: 'cah' });
  await logHas(host, 'Alice is the Card Czar');
  await bob.waitForFunction(() => document.querySelectorAll('.hcard').length >= 10, null, { timeout: 20000 });
  const pick = await host.evaluate(() => +[...document.getElementById('log').textContent.matchAll(/answer with (\d) card/g)].at(-1)[1]);
  await h.sleep(1200); // the tab pushes its state to the bridge every 500 ms
  const mark = term.out().length;
  term.stdin.write('hand\n');
  await term.wait(' 9. ');
  const listing = term.out().slice(mark);
  ok(/ 0\. “[^\n]+”\n/.test(listing) && !/ \d+\. “[^\n]*” — /.test(listing), `text cards print once, in quotes (${listing.split('\n').find((l) => / 0\. /.test(l))})`);
  term.stdin.write(`play ${[...Array(pick).keys()].join(' ')}\n`);
  await logHas(host, 'judges — press 👉', 20000).then(() => ok(true, `"play" (no --down) submits ${pick} answer(s) face down, as CAH requires`), () => ok(false, `"play" (no --down) submits ${pick} answer(s) face down, as CAH requires`));
  ok(!term.out().includes('Submit FACE DOWN'), 'no "toggle 🂠 in the hand bar" veto reaches the terminal');
  term.kill();
  await env.done();
})().catch(h.crash);
