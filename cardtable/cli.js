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
  /** Rolls dice (ids) together, in one roll. */
  roll(...ids) { this.send({ t: 'roll', ids }); }
  /** Takes a piece from a supply (an id or its type's name): onto the table (at x, y, or beside it), or into the hand. */
  take(supply, x = null, y = null, hand = false) { this.send({ t: 'take', id: supply, x, y, hand }); }
  /** Puts item `ref` on a board's spot `addr` ('e4', 'bar', 'map:c3'): an item id moves there; a supply (id or type name) hands out a piece there. */
  place(ref, addr) { this.send({ t: 'place', id: ref, at: addr }); }
  /** Answers the rules' question `id` (see state.asks) with `value`: an
   *  option's index or label, an item id, an address, hand indices ([0, 3] or
   *  '0,3'), a number — the tab turns it into the answer the host checks. */
  answer(id, value) { this.send({ t: 'answer', id, v: value }); }
  /** Selects item `id`: rules that want it may answer with a hint (state.hint). */
  select(id) { this.send({ t: 'select', id }); }
  /** Sits in named seat `id`; '-' stands up to watch, '+' sits down again (automatic seating). */
  seat(id) { this.send(id === '-' ? { t: 'seat', watch: true } : id === '+' ? { t: 'seat', sit: true } : { t: 'seat', id }); }
  /** Host: sets game box `box` up (its id or name; see state.boxes): `keep` keeps the table's items, `rules` enables
   *  its rules — the host still confirms a box's rules on the page unless the box is built in. */
  setup(box, keep = false, rules = false) { this.send({ t: 'setup', box, keep, rules }); }
  /** Host: lays the box last set up (state.lastSetup) out again. */
  reset() { this.send({ t: 'reset' }); }
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
  hand                    your cards (and pieces), with indices
  table                   cards, piles, pieces, supplies and bags
  players                 who sits where (⏳ turn, ⭐ badges, 🏆, [seat], watching)
  log [n]                 last n log lines (default 15)
  buttons                 rules buttons you can press
  play <idx...> [--down]  play hand card(s) at your seat (--down = face down)
  discard <idx> [pile]    put a hand card onto a pile (default: biggest)
  draw [pile]             draw from a pile (default: biggest; id or name)
  deal [pile] [--up]      deal the top card onto the table
  shuffle [pile]          shuffle a pile
  flip|peek|tohand <id>   flip / peek at / take a table card
  move <id> <x> <y>       move an item (table coords)
  roll <id...> | roll all roll dice together (all: every die you may handle, at most 20)
  face <id> <f>           turn a piece to face f (0, 1, …; not a die)
  take <supply> [x y] [--hand]  take a piece from a supply (id or type name)
  pull <bag> [x y] [--hand]     draw a random piece from a bag (id or name)
  split <id> [n] [x y]    take n (default 1) off a ×N stack
  place <ref> <addr>      put a piece on a board's spot (e4, bar, map:c3); a supply (id or type name) hands one out there
  bag <id> <bag>          put a piece into a bag
  lock|unlock <id>        lock an item in place, or free it
  claim|release <id>      make an item yours, or nobody's
  seat <id> | seat - | seat +   sit in a named seat; - stand up to watch; + sit down again
  btn <id>                press a rules button (see "buttons")
  asks                    the rules' questions waiting for you (new ones print as they come)
  answer <id> <value>     answer one: an option's label or number, an item id, a spot, hand indices (0,3), a number
  select <id>             select a piece: the rules may hint where it can go
  boxes                   the game boxes on this table (📜 has rules; "set up": the last one set up)
  setup <box> [--keep] [--rules]  host: set a box up (id or name); --keep keeps the table, --rules runs its rules
  reset                   host: set the last box up again
  chat <msg>              say something (also "!commands" for rules scripts)
  quit`;

/** A card for the terminal: a text-only card's name is its (cut) quoted text, so show the full text instead. */
function fmtCard(c) { return c.text && c.name.startsWith('“') ? `“${c.text}”` : c.name + (c.text && c.text !== c.name ? ` — ${c.text}` : ''); }
/** A table item as one line: every line keeps the `  [id] … @x,y` frame
 *  (parsers split on it), then the owner and 🔒 when present (spec §2i). */
function fmtItem(it) {
  const at = ` @${it.x},${it.y}${it.at ? ` at:${it.at}` : ''}`, tail = `${it.owner ? ` owner:${it.owner}` : ''}${it.locked ? ' 🔒' : ''}`, n = it.n ? ` ×${it.n}` : '';
  const head = `  [${it.id}] `;
  switch (it.kind) {
    case 'card': return `${head}${it.up ? fmtCard(it) : 'face-down card'}${at}${tail}`;
    case 'pile': return `${head}pile "${it.name || 'stack'}" ×${it.count}${it.top ? ` top: ${fmtTop(it.top)}` : ''}${at}${tail}`;
    case 'bag': return `${head}bag "${it.name}" ×${it.count}${at}${tail}`;
    case 'supply': return `${head}supply ${it.hidden ? 'of hidden pieces' : it.unknown ? '? unknown piece' : `${fmtPiece(it)} (${it.pieceKind})`} ∞${at}${tail}`;
    case 'hidden': return `${head}hidden piece${n}${at}${tail}`;
    case 'board': return `${head}board ${it.type} (board)${at}${tail}`;
    case 'unknown': return `${head}? unknown piece${at}${tail}`;
    default: return `${head}${fmtPiece(it)} (${it.kind})${n}${at}${tail}`;
  }
}
/** A shown piece: its face's label (if any), then its type's name. */
const fmtPiece = (p) => `${p.label != null ? `${p.label} ` : ''}${p.type}`;
/** A pile's top: a hidden piece, a shown piece, or a card. */
const fmtTop = (t) => (t.hidden ? 'hidden piece' : 'type' in t ? fmtPiece(t) : fmtCard(t));
/** A hand entry: a card, or a piece (its label, then its type's name). */
const fmtHand = (c) => (c.kind === 'piece' ? fmtPiece({ label: c.label, type: c.name }) : fmtCard(c));
/** A game box as one line (spec §4i): its id, name, size, rules, where it comes from, and whether it was set up last. */
function fmtBox(b, last) {
  const from = b.builtin ? 'built in' : { upload: "a guest's upload", script: 'made by the rules' }[b.src] || "the host's";
  return `  [${b.id}] ${b.name} — ${b.types} piece type${b.types === 1 ? '' : 's'}${b.rules ? ' · 📜 rules' : ''} · ${from}${b.id === last ? ' · set up' : ''}`;
}
/** Splits `args` into [the rest joined, x, y]: x and y when the last two are numbers. */
function spot(args) {
  const k = args.length;
  return k >= 2 && args.slice(-2).every((a) => Number.isFinite(+a) && a !== '') ? [args.slice(0, -2).join(' '), +args[k - 2], +args[k - 1]] : [args.join(' '), null, null];
}

/** Prints table text: names, cards and log lines come from other players, and
 *  their control characters (ESC sequences: clear screen, set title, OSC 52
 *  clipboard writes) must never reach the terminal. Newlines stay. */
const out = (s) => console.log(String(s).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ''));
/** Throws `usage` unless args[0] is present and args[1..n) are finite numbers. */
function need(args, n, usage) {
  if (args.length < n || args.slice(1, n).some((a) => !Number.isFinite(+a))) throw new Error(usage);
}
const STALE_MS = 25000; // a live tab re-polls at least every 20 s

function repl(bridge) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '🂡 > ' });
  let logSeen = 0;
  bridge.on((s, prev) => {
    if (!prev) out(`\n✅ tab connected: ${s.name} (${s.role}) in room ${s.room}`);
    const fresh = s.log.filter((e) => e.ts > logSeen);
    for (const e of fresh) out(`  ▸ ${e.who}${e.chat ? ':' : ''} ${e.text}`);
    if (fresh.length) logSeen = Math.max(...s.log.map((e) => e.ts));
    for (const m of s.msgs || []) out(`  ✉ ${m}`);
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
  if (!s && !['quit', 'help'].includes(cmd)) return out('… no tab connected yet');
  if (s && bridge.idle() > STALE_MS && !['quit', 'help'].includes(cmd)) {
    out(`⚠ tab not seen for ${Math.round(bridge.idle() / 1000)}s — commands queue until it is back`);
  }
  switch (cmd) {
    case 'help': return out(HELP);
    case 'quit': return process.exit(0);
    case 'hand':
      if (!s.hand.length) return out('(empty hand)');
      return s.hand.forEach((c) => out(` ${String(c.idx).padStart(2)}. ${fmtHand(c)}`));
    case 'table':
      return s.items.forEach((it) => out(fmtItem(it)));
    case 'players':
      return s.players.forEach((p) => out(`  ${p.winner ? '🏆' : p.turn ? '⏳' : ' '} ${p.name}${p.id === s.pid ? ' (you)' : ''}${p.seatId ? ` [${p.seatId}]` : ''} 🂠${p.cards}${p.badge ? ' ' + p.badge : ''}${p.watching ? ' (watching)' : ''}${p.online ? '' : ' (offline)'}`));
    case 'log':
      return s.log.slice(-(+args[0] || 15)).forEach((e) => out(`  ${e.who}${e.chat ? ':' : ''} ${e.text}`));
    case 'boxes':
      return s.boxes.length ? s.boxes.forEach((b) => out(fmtBox(b, s.lastSetup))) : out('(no game boxes on this table)');
    case 'setup': {
      const box = args.filter((a) => !a.startsWith('--')).join(' ');
      if (!box) throw new Error('setup <box> [--keep] [--rules] — see "boxes"');
      return bridge.setup(box, args.includes('--keep'), args.includes('--rules'));
    }
    case 'reset': return bridge.reset();
    case 'buttons':
      return s.buttons.length ? s.buttons.forEach((b) => out(`  [${b.id}] ${b.label}`)) : out('(none)');
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
    case 'roll':
      if (!args.length) throw new Error('roll <id...> | roll all');
      return args[0] === 'all' ? bridge.send({ t: 'roll', all: true }) : bridge.roll(...args);
    case 'face':
      need(args, 2, 'face <id> <f>');
      return bridge.send({ t: 'face', id: args[0], f: +args[1] });
    case 'take': case 'pull': {
      const [ref, x, y] = spot(args.filter((a) => a !== '--hand'));
      if (!ref) throw new Error(`${cmd} <${cmd === 'take' ? 'supply' : 'bag'}> [x y] [--hand]`);
      return bridge.send({ t: cmd, id: ref, x, y, hand: args.includes('--hand') });
    }
    case 'split': {
      need(args, 1, 'split <id> [n] [x y]');
      const nums = args.slice(1).map(Number);
      if (nums.some((v) => !Number.isFinite(v)) || nums.length > 3) throw new Error('split <id> [n] [x y]');
      const [n, x, y] = nums.length === 2 ? [null, ...nums] : nums;
      return bridge.send({ t: 'split', id: args[0], n: n ?? null, x: x ?? null, y: y ?? null });
    }
    case 'place':
      if (args.length < 2) throw new Error('place <ref> <addr>');
      return bridge.place(args.slice(0, -1).join(' '), args.at(-1));
    case 'bag':
      if (args.length < 2) throw new Error('bag <id> <bag>');
      return bridge.send({ t: 'toBag', id: args[0], bag: args.slice(1).join(' ') });
    case 'lock': case 'unlock':
      need(args, 1, `${cmd} <id>`);
      return bridge.send({ t: 'lock', id: args[0], on: cmd === 'lock' });
    case 'claim': case 'release':
      need(args, 1, `${cmd} <id>`);
      return bridge.send({ t: 'owner', id: args[0], to: cmd === 'claim' ? s.pid : null });
    case 'seat':
      need(args, 1, 'seat <id> | seat - | seat +');
      return bridge.seat(args[0]);
    case 'asks': return bridge.send({ t: 'asks' }); // (the tab writes the text: the same in both REPLs)
    case 'answer':
      if (args.length < 2) throw new Error('answer <id> <value>');
      return bridge.answer(args[0], args.slice(1).join(' '));
    case 'select':
      need(args, 1, 'select <id>');
      return bridge.select(args[0]);
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
