#!/usr/bin/env node
// Card Table terminal bridge — Node edition (zero dependencies).
//
// Play from your terminal, or drive a bot. This process runs a tiny HTTP
// server on 127.0.0.1; a card-table browser tab pairs with it when its URL
// hash carries "~cli~PORT-TOKEN". The tab stays the WebRTC peer — this is a
// remote control, so every command goes through the same validated, logged
// path as a click in the page.
//
//   Control YOUR seat:   node cli.js <invite-url>
//   Run a SEPARATE user: node cli.js <invite-url> --as BotName
//
// Either way it prints the exact URL to open in a browser tab (with --as,
// the tab joins as a new player named BotName — a bot's body; this terminal
// is its brain). Commands: type "help" at the prompt.
//
// Scripting: require this file to get { Bridge } and write bots in ~20 lines
// (see cah-bot.py for the same idea in Python).
'use strict';
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');

/** The bridge server: pairs with one tab, queues commands, mirrors state. */
class Bridge {
  constructor({ port = 0, token = crypto.randomBytes(6).toString('hex') } = {}) {
    this.token = token;
    this.state = null;
    this.cmds = [];              // queued for the tab
    this.waiter = null;          // the tab's newest pending long-poll
    this.seen = 0;               // when the tab last called in (ms)
    this.listeners = new Set();  // state subscribers: fn(state, prevState)
    this.server = http.createServer((req, res) => this.route(req, res));
    this.ready = new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this); });
    });
  }
  urlFor(inviteUrl, asName) {
    // '~' separates hash fields but is URL-safe, so encodeURIComponent keeps it.
    return inviteUrl.replace(/~cli~.*$/, '') + `~cli~${this.port}-${this.token}` + (asName ? `~as~${encodeURIComponent(asName).replace(/~/g, '%7E')}` : '');
  }
  /** Subscribes to state updates; returns an unsubscribe function. */
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  send(cmd) {
    // NaN/Infinity aren't JSON (they'd arrive as null): refuse them here, like cli.py.
    JSON.stringify(cmd, (k, v) => {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`send(): ${k} is not a finite number`);
      return v;
    });
    this.cmds.push(cmd);
    const res = this.waiter;
    this.waiter = null;
    if (res) this.flush(res);
  }
  /** Answers a long-poll with every queued command (or `[]`). A poll whose
   *  tab already hung up takes nothing: the commands stay for the next one. */
  flush(res, cmds) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(cmds ?? this.cmds.splice(0)));
  }
  /** ms since the tab last called in (Infinity before it ever did). */
  idle() { return this.seen ? Date.now() - this.seen : Infinity; }
  // convenience wrappers for bot code (same as cli.py)
  chat(msg) { this.send({ t: 'chat', msg }); }
  /** Plays a hand card, sent by identity (key) so the tab's state lag can't
   *  shift which card goes: a card object from a state you hold (safest), a
   *  key, or an index — resolved against `state` as it is when you call. */
  play(card, up = true, extra = {}) {
    const c = typeof card === 'number' ? this.state?.hand?.[card] ?? { idx: card } : typeof card === 'string' ? { key: card } : card;
    this.send({ t: 'play', idx: c.idx ?? null, key: c.key ?? null, up, ...extra });
  }
  draw(pile) { this.send({ t: 'draw', id: pile }); }
  btn(id) { this.send({ t: 'btn', id }); }
  route(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== this.token) {
      res.writeHead(403, { 'Access-Control-Allow-Origin': '*' });
      return res.end('bad token');
    }
    this.seen = Date.now();
    if (url.pathname === '/poll') {
      if (this.cmds.length) return this.flush(res);
      // Newest poll wins: a tab keeps one poll in flight, so an older one is
      // from a reloaded tab (an aborted socket would swallow commands). It is
      // only demoted — answered [] at its timeout — so two tabs on one URL
      // take turns instead of re-polling each other in a hot loop.
      this.waiter = res;
      res.on('close', () => { if (this.waiter === res) this.waiter = null; });
      // Cap the long-poll so the tab re-arms regularly.
      setTimeout(() => {
        if (this.waiter === res) this.waiter = null;
        this.flush(res, []);
      }, 20000).unref();
      return;
    }
    if (url.pathname === '/state' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const prev = this.state;
        try {
          this.state = JSON.parse(body);
        } catch (err) {
          console.error('bad state payload', err.message);
          res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
          return res.end('bad json');
        }
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end('ok');
        // A throwing subscriber is the bot's bug, not the tab's: report it and
        // keep the others (and the tab's push/poll loop) going.
        for (const fn of [...this.listeners]) {
          try { fn(this.state, prev); } catch (err) { console.error('bridge listener failed', err); }
        }
      });
      return;
    }
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
  }
  /** Resolves when the state matches pred (rejects on timeout, or if pred throws). */
  wait(pred, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (this.state && pred(this.state)) return resolve(this.state);
      const done = (fn, v) => { off(); clearTimeout(tm); fn(v); };
      const off = this.on((s) => {
        let hit;
        try { hit = pred(s); } catch (err) { return done(reject, err); }
        if (hit) done(resolve, s);
      });
      const tm = setTimeout(() => done(reject, new Error('wait() timed out')), timeoutMs);
      tm.unref();
    });
  }
  close() { this.server.close(); }
}

// ---------------------------------------------------------------------------
// REPL
const HELP = `commands:
  hand                    your cards, with indices
  table                   piles (with a face-up top card) and table cards
  players                 who sits where (⏳ turn, ⭐ badges, 🏆)
  log [n]                 last n log lines (default 15)
  buttons                 rules buttons you can press
  play <idx...> [--down]  play hand card(s) at your seat (--down = face down)
  discard <idx> [pile]    put a hand card onto a pile (default: biggest)
  draw [pile]             draw from a pile (default: biggest; id or name)
  deal [pile] [--up]      deal the top card onto the table
  shuffle [pile]          shuffle a pile
  flip|peek|tohand <id>   flip / peek at / take a table card
  move <id> <x> <y>       move an item (table coords)
  btn <id>                press a rules button (see "buttons")
  chat <msg>              say something (also "!commands" for rules scripts)
  quit`;

function fmtCard(c) { return c.name + (c.text && c.text !== c.name ? ` — ${c.text}` : ''); }
/** Throws `usage` unless args[0] is present and args[1..n) are finite numbers. */
function need(args, n, usage) {
  if (args.length < n || args.slice(1, n).some((a) => !Number.isFinite(+a))) throw new Error(usage);
}
const STALE_MS = 25000; // a live tab re-polls at least every 20 s

function repl(bridge) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '🂡 > ' });
  let logSeen = 0;
  bridge.on((s, prev) => {
    if (!prev) console.log(`\n✅ tab connected: ${s.name} (${s.role}) in room ${s.room}`);
    const fresh = s.log.filter((e) => e.ts > logSeen);
    for (const e of fresh) console.log(`  ▸ ${e.who}${e.chat ? ':' : ''} ${e.text}`);
    if (fresh.length) logSeen = Math.max(...s.log.map((e) => e.ts));
    for (const m of s.msgs || []) console.log(`  ✉ ${m}`);
    rl.prompt(true);
  });
  rl.on('line', (line) => {
    try { runCmd(bridge, line.trim()); } catch (err) { console.error('✗', err.message); }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
  rl.prompt();
}

function runCmd(bridge, line) {
  if (!line) return;
  const [cmd, ...args] = line.split(/\s+/);
  const s = bridge.state;
  if (!s && !['quit', 'help'].includes(cmd)) return console.log('… no tab connected yet');
  if (s && bridge.idle() > STALE_MS && !['quit', 'help'].includes(cmd)) {
    console.log(`⚠ tab not seen for ${Math.round(bridge.idle() / 1000)}s — commands queue until it is back`);
  }
  switch (cmd) {
    case 'help': return console.log(HELP);
    case 'quit': return process.exit(0);
    case 'hand':
      if (!s.hand.length) return console.log('(empty hand)');
      return s.hand.forEach((c) => console.log(` ${String(c.idx).padStart(2)}. ${fmtCard(c)}`));
    case 'table':
      return s.items.forEach((it) => console.log(it.kind === 'pile'
        ? `  [${it.id}] pile "${it.name || 'stack'}" ×${it.count}${it.top ? ` top: ${fmtCard(it.top)}` : ''} @${it.x},${it.y}`
        : `  [${it.id}] ${it.up ? fmtCard(it) : 'face-down card'} @${it.x},${it.y}`));
    case 'players':
      return s.players.forEach((p) => console.log(`  ${p.winner ? '🏆' : p.turn ? '⏳' : ' '} ${p.name}${p.id === s.pid ? ' (you)' : ''} 🂠${p.cards}${p.badge ? ' ' + p.badge : ''}${p.online ? '' : ' (offline)'}`));
    case 'log':
      return s.log.slice(-(+args[0] || 15)).forEach((e) => console.log(`  ${e.who}${e.chat ? ':' : ''} ${e.text}`));
    case 'buttons':
      return s.buttons.length ? s.buttons.forEach((b) => console.log(`  [${b.id}] ${b.label}`)) : console.log('(none)');
    case 'play': {
      const down = args.includes('--down');
      const idxs = new Set(args.filter((a) => /^\d+$/.test(a)).map(Number));
      if (!idxs.size) throw new Error('play <idx...> — see "hand"');
      for (const idx of idxs) bridge.play(s.hand[idx] ?? idx, !down); // the cards the user saw
      return;
    }
    case 'discard':
      if (!/^\d+$/.test(args[0] || '')) throw new Error('discard <idx> [pile]');
      return bridge.send({ t: 'discard', idx: +args[0], key: s.hand[+args[0]]?.key, pile: args.slice(1).join(' ') || undefined });
    case 'draw': return bridge.send({ t: 'draw', id: args.join(' ') || undefined });
    case 'deal': return bridge.send({ t: 'deal', id: args.filter((a) => a !== '--up').join(' ') || undefined, up: args.includes('--up') });
    case 'shuffle': return bridge.send({ t: 'shuffle', id: args.join(' ') || undefined });
    case 'flip': case 'peek': case 'tohand': case 'btn':
      need(args, 1, `${cmd} <id>`);
      return bridge.send({ t: cmd === 'tohand' ? 'toHand' : cmd, id: args[0] });
    case 'move':
      need(args, 3, 'move <id> <x> <y>');
      return bridge.send({ t: 'move', id: args[0], x: +args[1], y: +args[2] });
    case 'chat': return bridge.send({ t: 'chat', msg: args.join(' ') });
    default: throw new Error(`unknown command "${cmd}" — try "help"`);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const asIdx = args.indexOf('--as');
  const asName = asIdx >= 0 ? args[asIdx + 1] : null;
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? +args[portIdx + 1] : 0;
  const invite = args.find((a) => a.includes('#room~'));
  if (!invite) {
    console.error('usage: node cli.js <invite-url> [--as BotName] [--port N]');
    process.exit(1);
  }
  const bridge = await new Bridge({ port }).ready;
  console.log(`Card Table bridge listening on 127.0.0.1:${bridge.port}`);
  console.log(`\nOpen this URL in a browser tab${asName ? ` (it will join as "${asName}")` : ' (it will control YOUR seat)'}:\n`);
  console.log(`  ${bridge.urlFor(invite, asName)}\n`);
  console.log('type "help" for commands\n');
  repl(bridge);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { Bridge };
