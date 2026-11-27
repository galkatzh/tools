// Helpers for the terminal-bridge suites (t-p2-cli.js, t-p3-cli.js); not a
// suite itself: the REPLs (cli.js, cli.py) and their Bridge APIs run as child
// processes, and a test plays the tab over HTTP, or pairs a real tab.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./h');
const { until } = require('./p1-lib');

const APP = path.join(h.APP_ROOT, 'cardtable');
const LANGS = ['node', 'python'];
const kids = []; // every child started: kill them all at the end (killAll)
/** A child process whose stdout and stderr gather in .buf. */
function child(cmd, args) {
  const c = spawn(cmd, args, { cwd: APP, stdio: ['pipe', 'pipe', 'pipe'] });
  kids.push(c);
  c.buf = '';
  c.stdout.on('data', (d) => { c.buf += d; });
  c.stderr.on('data', (d) => { c.buf += d; }); // (Node's REPL reports a usage error on stderr)
  return c;
}
const killAll = () => { for (const k of kids) k.kill(); };
/** A REPL (cli.js or cli.py) for `invite`: {c, lang, port, token, url}. */
async function repl(lang, invite) {
  const c = lang === 'node' ? child('node', [path.join(APP, 'cli.js'), invite]) : child('python3', ['-u', path.join(APP, 'cli.py'), invite]);
  if (!(await until(() => /~cli~\d+-\w+\S*\n/.test(c.buf), 10000, 100))) throw new Error(`${lang} REPL did not start: ${c.buf}`);
  const [url, port, token] = c.buf.match(/(\S+~cli~(\d+)-(\w+)\S*)/).slice(1);
  return { c, lang, port: +port, token, url };
}
/** The REPL's output from character `from` on, as lines without its prompts. */
const linesOf = (r, from) => r.c.buf.slice(from).split('\n').map((l) => l.replace(/^(?:🂡 > )+/, ''));
/** Types `line` (again every 2 s, as the tab's state may lag) until the
 *  lines printed after it pass `done`; returns them (or the last tried). */
async function type(r, line, done, ms = 20000) {
  let lines = [];
  for (const end = Date.now() + ms; Date.now() < end;) {
    const from = r.c.buf.length;
    r.c.stdin.write(line + '\n');
    if (await until(() => done((lines = linesOf(r, from))), 2000, 100)) return lines;
  }
  console.error(`  (${r.lang}: "${line}" never printed what was expected; got ${JSON.stringify(lines.slice(0, 20))})`);
  return lines;
}
/** An HTTP request to a bridge, as a tab makes it: {done: Promise<{status, body}>, abort}. */
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
/** Pushes `state` to bridge b, as its tab would. */
const push = (b, state) => req(b.port, `/state?token=${b.token}`, { method: 'POST', body: JSON.stringify(state) }).done;
/** Plays the tab: a poll is parked, `fn()` runs (it makes the bridge send),
 *  and every command the bridge then hands out comes back — polling again,
 *  as a tab does, while commands keep coming (a parked poll is answered with
 *  the first one: the rest wait for the next poll). */
async function sent(b, fn) {
  const poll = async (p, ms) => {
    const r = await Promise.race([p.done, h.sleep(ms).then(() => null)]);
    if (!r) { p.abort(); return []; }
    try { return JSON.parse(r.body); } catch (err) { console.error('bad poll body', r.body, err); return null; }
  };
  const first = req(b.port, `/poll?token=${b.token}`);
  await h.sleep(250);
  await fn();
  const all = await poll(first, 5000);
  for (let more = all; more?.length;) all.push(...((more = await poll(req(b.port, `/poll?token=${b.token}`), 600)) || []));
  return all;
}
const json = (x) => JSON.stringify(x);
/** Deep equality of parsed JSON (key order ignored). */
const eq = (a, b) => json(sort(a)) === json(sort(b));
const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
// A Bridge API driver, the same calls in both languages: it reads JSON lines {call, args} and calls b[call](...args).
const NODE_API = `
const { Bridge } = require(${json(path.join(APP, 'cli.js'))});
(async () => {
  const b = await new Bridge().ready;
  console.log('READY', b.port, b.token);
  require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const c = JSON.parse(l); b[c.call](...c.args); });
})();`;
const PY_API = `
import json, sys
sys.path.insert(0, ${json(APP)})
from cli import Bridge
b = Bridge()
print('READY', b.port, b.token, flush=True)
for line in sys.stdin:
    c = json.loads(line)
    getattr(b, c['call'])(*c['args'])
`;
/** A Bridge API driver in `lang`, started: {c, lang, port, token}. */
async function api(lang) {
  const c = lang === 'node' ? child('node', ['-e', NODE_API]) : child('python3', ['-u', '-c', PY_API]);
  if (!(await until(() => /READY \d+ \w+\n/.test(c.buf), 10000, 100))) throw new Error(`${lang} API driver did not start: ${c.buf}`);
  const [, port, token] = c.buf.match(/READY (\d+) (\w+)/);
  return { c, lang, port: +port, token };
}
/** The commands driver b sends for `calls` ([[call, ...args]]), one each, in order. */
const viaApi = (b, calls) => sent(b, async () => {
  for (const [call, ...args] of calls) b.c.stdin.write(json({ call, args }) + '\n');
  await h.sleep(500);
});

module.exports = { APP, LANGS, child, killAll, repl, linesOf, type, req, push, sent, json, eq, sort, api, viaApi };
