#!/usr/bin/env python3
"""Card Table terminal bridge — Python edition (stdlib only).

Play from your terminal, or drive a bot. This process runs a tiny HTTP server
on 127.0.0.1; a card-table browser tab pairs with it when its URL hash carries
"~cli~PORT-TOKEN". The tab stays the WebRTC peer — this is a remote control,
so every command goes through the same validated, logged path as a click.

    Control YOUR seat:   python3 cli.py <invite-url>
    Run a SEPARATE user: python3 cli.py <invite-url> --as BotName

Either way it prints the exact URL to open in a browser tab (with --as, the
tab joins as a new player named BotName — a bot's body; this terminal is its
brain). Type "help" at the prompt for commands.

Scripting: ``from cli import Bridge`` and write bots in ~20 lines — see
cah-bot.py for a complete example.
"""
import argparse
import json
import math
import re
import secrets
import select
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Bridge:
    """Pairs with one tab: queues commands out, mirrors table state in."""

    def __init__(self, port=0, token=None):
        self.token = token or secrets.token_hex(6)
        self.state = None
        self._cmds = []
        self._cv = threading.Condition()
        self._poll = 0     # generation of the tab's newest pending long-poll
        self._seen = 0.0   # when the tab last called in
        self._listeners = []
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_request(self, *a):  # quiet access log; log_error still reaches stderr
                pass

            def _cors(self, code, body=b''):
                self.send_response(code)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(body)

            def _gone(self):
                """True once the tab hung up (a reload aborts its pending poll)."""
                try:
                    ready = select.select([self.connection], [], [], 0)[0]
                    return bool(ready) and not self.connection.recv(1, socket.MSG_PEEK)
                except OSError as e:
                    print(f'bridge: poll connection lost: {e}', file=sys.stderr)
                    return True

            def do_GET(self):
                url = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(url.query)
                if q.get('token', [''])[0] != bridge.token:
                    return self._cors(403, b'"bad token"')
                bridge._seen = time.time()
                if url.path == '/poll':
                    # Newest poll wins (see cli.js): only the tab's latest poll
                    # takes commands, and only while its socket is still open,
                    # so a reloaded tab's aborted poll can't swallow them. A
                    # demoted poll just answers [] at its timeout.
                    out = []
                    with bridge._cv:
                        bridge._poll += 1
                        me = bridge._poll
                        take = lambda: bridge._cmds and bridge._poll == me and not self._gone()
                        if bridge._cv.wait_for(take, timeout=20):
                            out, bridge._cmds = bridge._cmds, []
                    return self._cors(200, json.dumps(out).encode())
                self._cors(404, b'"not found"')

            def do_POST(self):
                url = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(url.query)
                if q.get('token', [''])[0] != bridge.token:
                    return self._cors(403, b'"bad token"')
                bridge._seen = time.time()
                if url.path == '/state':
                    body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                    try:
                        prev, bridge.state = bridge.state, json.loads(body)
                    except ValueError as e:
                        print(f'bad state payload: {e}', file=sys.stderr)
                        return self._cors(400, b'"bad json"')
                    self._cors(200, b'"ok"')
                    # A throwing subscriber is the bot's bug, not the tab's:
                    # report it and keep the others (and the tab) going.
                    for fn in list(bridge._listeners):
                        try:
                            fn(bridge.state, prev)
                        except Exception:
                            traceback.print_exc()
                    return
                self._cors(404, b'"not found"')

        self._server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def url_for(self, invite_url, as_name=None):
        base = invite_url.split('~cli~')[0]
        url = f'{base}~cli~{self.port}-{self.token}'
        if as_name:  # '~' separates hash fields, so it must be escaped too
            url += f"~as~{urllib.parse.quote(as_name, safe='').replace('~', '%7E')}"
        return url

    def send(self, **cmd):
        """Queues a command for the tab, e.g. send(t='play', idx=0, up=False)."""
        # NaN/inf would come out as bare NaN/Infinity — invalid JSON that loses
        # the tab the whole poll batch — so refuse them here (raises ValueError).
        json.dumps(cmd, allow_nan=False)
        with self._cv:
            self._cmds.append(cmd)
            self._cv.notify_all()

    def idle(self):
        """Seconds since the tab last called in (inf before it ever did)."""
        return time.time() - self._seen if self._seen else float('inf')

    def on(self, fn):
        """Subscribes fn(state, prev_state); returns an unsubscribe function."""
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn)

    def wait(self, pred, timeout=30):
        """Blocks until the state matches pred; returns it (raises on timeout,
        or whatever pred raises)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            s = self.state
            if s and pred(s):
                return s
            time.sleep(0.15)
        raise TimeoutError('wait() timed out')

    # convenience wrappers for bot code
    def chat(self, msg): self.send(t='chat', msg=msg)

    def play(self, card, up=True, **kw):
        """Plays a hand card, sent by identity (key) so the tab's state lag
        can't shift which card goes: a card dict from a state you hold
        (safest), a key, or an index — resolved against `state` as it is when
        you call."""
        if isinstance(card, int):
            hand = (self.state or {}).get('hand', [])
            card = hand[card] if 0 <= card < len(hand) else {'idx': card}
        elif isinstance(card, str):
            card = {'key': card}
        self.send(t='play', idx=card.get('idx'), key=card.get('key'), up=up, **kw)

    def draw(self, pile=None): self.send(t='draw', id=pile)
    def btn(self, bid): self.send(t='btn', id=bid)

    def roll(self, *ids):
        """Rolls dice (ids) together, in one roll."""
        self.send(t='roll', ids=list(ids))

    def take(self, supply, x=None, y=None, hand=False):
        """Takes a piece from a supply (an id or its type's name): onto the
        table (at x, y, or beside it), or into the hand."""
        self.send(t='take', id=supply, x=x, y=y, hand=hand)

    def place(self, ref, addr):
        """Puts item `ref` on a board's spot `addr` ('e4', 'bar', 'map:c3'):
        an item id moves there; a supply (id or type name) hands out a piece
        there."""
        self.send(t='place', id=ref, at=addr)

    def answer(self, aid, value):
        """Answers the rules' question `aid` (see state['asks']) with `value`:
        an option's index or label, an item id, an address, hand indices
        ([0, 3] or '0,3'), a number — the tab turns it into the answer the
        host checks."""
        self.send(t='answer', id=aid, v=value)

    def select(self, iid):
        """Selects item `iid`: rules that want it may answer with a hint (state['hint'])."""
        self.send(t='select', id=iid)

    def seat(self, sid):
        """Sits in named seat `sid`; '-' stands up to watch, '+' sits down
        again (automatic seating)."""
        if sid == '-':
            self.send(t='seat', watch=True)
        elif sid == '+':
            self.send(t='seat', sit=True)
        else:
            self.send(t='seat', id=sid)

    def setup(self, box, keep=False, rules=False):
        """Host: sets game box `box` up (its id or name; see state['boxes']):
        `keep` keeps the table's items, `rules` enables its rules — the host
        still confirms a box's rules on the page unless the box is built in."""
        self.send(t='setup', box=box, keep=keep, rules=rules)

    def reset(self):
        """Host: lays the box last set up (state['lastSetup']) out again."""
        self.send(t='reset')

    def group(self, op, ids, **kw):
        """One op on many items, as one action (spec §4i): `op` is move (dx=,
        dy=), rot (deg=: a turn by that much each), flip, roll (the dice among
        them), lock, unlock, del or bag (bag=: an id or a name); `ids` a list of
        item ids (or names). The host skips the members you may not handle, and
        says how many in one notice."""
        self.send(t='group', op=op, ids=list(ids), **kw)

    def close(self):
        self._server.shutdown()


# ---------------------------------------------------------------------------
HELP = """commands:
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
  group <op> <id,id,…> [dx dy | deg | bag]  one op on many items: move dx dy, rot deg, flip, roll, lock, unlock, del, bag <bag>
  seat <id> | seat - | seat +   sit in a named seat; - stand up to watch; + sit down again
  btn <id>                press a rules button (see "buttons")
  asks                    the rules' questions waiting for you (new ones print as they come)
  answer <id> <value>     answer one: an option's label or number, an item id, a spot, hand indices (0,3), a number
  select <id>             select a piece: the rules may hint where it can go
  boxes                   the game boxes on this table (📜 has rules; "set up": the last one set up)
  setup <box> [--keep] [--rules]  host: set a box up (id or name); --keep keeps the table, --rules runs its rules
  reset                   host: set the last box up again
  chat <msg>              say something (also "!commands" for rules scripts)
  quit"""


def fmt_card(c):
    """A card for the terminal: a text-only card's name is its (cut) quoted text, so show the full text."""
    text = c.get('text')
    if text and c['name'].startswith('“'):
        return f'“{text}”'
    return c['name'] + (f' — {text}' if text and text != c['name'] else '')


def fmt_piece(p):
    """A shown piece: its face's label (if any), then its type's name."""
    return (f"{p['label']} " if p.get('label') is not None else '') + p['type']


def fmt_top(t):
    """A pile's top: a hidden piece, a shown piece, or a card."""
    return 'hidden piece' if t.get('hidden') else fmt_piece(t) if 'type' in t else fmt_card(t)


def fmt_hand(c):
    """A hand entry: a card, or a piece (its label, then its type's name)."""
    return fmt_piece({'label': c.get('label'), 'type': c['name']}) if c.get('kind') == 'piece' else fmt_card(c)


def fmt_item(it):
    """A table item as one line: every line keeps the `  [id] … @x,y` frame
    (parsers split on it), then the owner and 🔒 when present (spec §2i)."""
    at = f" @{it['x']},{it['y']}" + (f" at:{it['at']}" if it.get('at') else '')
    tail = (f" owner:{it['owner']}" if it.get('owner') else '') + (' 🔒' if it.get('locked') else '')
    n = f" ×{it['n']}" if it.get('n') else ''
    head = f"  [{it['id']}] "
    kind = it['kind']
    if kind == 'card':
        return f"{head}{fmt_card(it) if it['up'] else 'face-down card'}{at}{tail}"
    if kind == 'pile':
        top = f" top: {fmt_top(it['top'])}" if it.get('top') else ''
        return f"{head}pile \"{it['name'] or 'stack'}\" ×{it['count']}{top}{at}{tail}"
    if kind == 'bag':
        return f"{head}bag \"{it['name']}\" ×{it['count']}{at}{tail}"
    if kind == 'supply':
        what = 'of hidden pieces' if it.get('hidden') else '? unknown piece' if it.get('unknown') else f"{fmt_piece(it)} ({it['pieceKind']})"
        return f"{head}supply {what} ∞{at}{tail}"
    if kind == 'hidden':
        return f"{head}hidden piece{n}{at}{tail}"
    if kind == 'board':
        return f"{head}board {it['type']} (board){at}{tail}"
    if kind == 'unknown':
        return f"{head}? unknown piece{at}{tail}"
    return f"{head}{fmt_piece(it)} ({kind}){n}{at}{tail}"


def fmt_box(b, last):
    """A game box as one line (spec §4i): its id, name, size, rules, where it comes from, and whether it was set up last."""
    src = 'built in' if b.get('builtin') else {'upload': "a guest's upload", 'script': 'made by the rules'}.get(b['src'], "the host's")
    n = b['types']
    return (f"  [{b['id']}] {b['name']} — {n} piece type{'' if n == 1 else 's'}"
            + (' · 📜 rules' if b.get('rules') else '') + f' · {src}' + (' · set up' if b['id'] == last else ''))


def spot(args):
    """Splits args into (the rest joined, x, y): x and y when the last two are numbers."""
    try:
        if len(args) >= 2 and all(math.isfinite(float(a)) for a in args[-2:]):
            return ' '.join(args[:-2]), float(args[-2]), float(args[-1])
    except ValueError:
        pass
    return ' '.join(args), None, None


def out(s):
    """Prints table text: names, cards and log lines come from other players, and
    their control characters (ESC sequences: clear screen, set title, OSC 52
    clipboard writes) must never reach the terminal. Newlines stay."""
    print(re.sub(r'[\x00-\x09\x0b-\x1f\x7f-\x9f]', '', str(s)))


def need(args, n, usage):
    """Raises `usage` unless args[0] is present and args[1:n] are finite numbers."""
    try:
        nums = [float(a) for a in args[1:n]]
        if len(args) < n or not all(map(math.isfinite, nums)):
            raise ValueError
        return nums
    except ValueError:
        raise ValueError(usage) from None


STALE_S = 25  # a live tab re-polls at least every 20 s
GROUP_USAGE = 'group <op> <id,id,…> [dx dy | deg | bag] — op: move dx dy, rot deg, flip, roll, lock, unlock, del, bag <bag>'


def run_cmd(bridge, line):
    parts = line.split()
    cmd, args = parts[0], parts[1:]
    s = bridge.state
    if s is None and cmd not in ('help', 'quit'):
        out('… no tab connected yet')
        return
    if s is not None and bridge.idle() > STALE_S and cmd not in ('help', 'quit'):
        out(f'⚠ tab not seen for {round(bridge.idle())}s — commands queue until it is back')
    if cmd == 'help':
        out(HELP)
    elif cmd == 'quit':
        raise SystemExit
    elif cmd == 'hand':
        for c in s['hand']:
            out(f" {c['idx']:2}. {fmt_hand(c)}")
        if not s['hand']:
            out('(empty hand)')
    elif cmd == 'table':
        for it in s['items']:
            out(fmt_item(it))
    elif cmd == 'players':
        for p in s['players']:
            mark = '🏆' if p.get('winner') else ('⏳' if p.get('turn') else ' ')
            you = ' (you)' if p['id'] == s['pid'] else ''
            seat = f" [{p['seatId']}]" if p.get('seatId') else ''
            badge = f" {p['badge']}" if p.get('badge') else ''
            watching = ' (watching)' if p.get('watching') else ''
            off = '' if p['online'] else ' (offline)'
            out(f"  {mark} {p['name']}{you}{seat} 🂠{p['cards']}{badge}{watching}{off}")
    elif cmd == 'log':
        n = int(args[0]) if args else 15
        for e in s['log'][-n:]:
            sep = ':' if e.get('chat') else ''
            out(f"  {e['who']}{sep} {e['text']}")
    elif cmd == 'boxes':
        for b in s['boxes']:
            out(fmt_box(b, s.get('lastSetup')))
        if not s['boxes']:
            out('(no game boxes on this table)')
    elif cmd == 'setup':
        box = ' '.join(a for a in args if not a.startswith('--'))
        if not box:
            raise ValueError('setup <box> [--keep] [--rules] — see "boxes"')
        bridge.setup(box, '--keep' in args, '--rules' in args)
    elif cmd == 'reset':
        bridge.reset()
    elif cmd == 'buttons':
        for b in s['buttons']:
            out(f"  [{b['id']}] {b['label']}")
        if not s['buttons']:
            out('(none)')
    elif cmd == 'play':
        idxs = list(dict.fromkeys(int(a) for a in args if a.isdigit()))
        if not idxs:
            raise ValueError('play <idx...> — see "hand"')
        for idx in idxs:  # the cards the user saw
            bridge.play(s['hand'][idx] if idx < len(s['hand']) else idx, up='--down' not in args)
    elif cmd == 'discard':
        if not args or not args[0].isdigit():
            raise ValueError('discard <idx> [pile]')
        idx = int(args[0])
        key = s['hand'][idx].get('key') if idx < len(s['hand']) else None
        bridge.send(t='discard', idx=idx, key=key, pile=' '.join(args[1:]) or None)
    elif cmd == 'draw':
        bridge.draw(' '.join(args) or None)
    elif cmd == 'deal':
        pile = ' '.join(a for a in args if a != '--up') or None
        bridge.send(t='deal', id=pile, up='--up' in args)
    elif cmd == 'shuffle':
        bridge.send(t='shuffle', id=' '.join(args) or None)
    elif cmd in ('flip', 'peek', 'tohand', 'btn'):
        need(args, 1, f'{cmd} <id>')
        bridge.send(t='toHand' if cmd == 'tohand' else cmd, id=args[0])
    elif cmd == 'move':
        x, y = need(args, 3, 'move <id> <x> <y>')
        bridge.send(t='move', id=args[0], x=x, y=y)
    elif cmd == 'roll':
        if not args:
            raise ValueError('roll <id...> | roll all')
        if args[0] == 'all':
            bridge.send(t='roll', all=True)
        else:
            bridge.roll(*args)
    elif cmd == 'face':
        f, = need(args, 2, 'face <id> <f>')
        bridge.send(t='face', id=args[0], f=f)
    elif cmd in ('take', 'pull'):
        ref, x, y = spot([a for a in args if a != '--hand'])
        if not ref:
            raise ValueError(f"{cmd} <{'supply' if cmd == 'take' else 'bag'}> [x y] [--hand]")
        bridge.send(t=cmd, id=ref, x=x, y=y, hand='--hand' in args)
    elif cmd == 'split':
        nums = need(args, max(len(args), 1), 'split <id> [n] [x y]')
        if len(nums) > 3:
            raise ValueError('split <id> [n] [x y]')
        n, x, y = ([None] + nums) if len(nums) == 2 else (nums + [None] * 3)[:3]
        bridge.send(t='split', id=args[0], n=n, x=x, y=y)
    elif cmd == 'place':
        if len(args) < 2:
            raise ValueError('place <ref> <addr>')
        bridge.place(' '.join(args[:-1]), args[-1])
    elif cmd == 'bag':
        if len(args) < 2:
            raise ValueError('bag <id> <bag>')
        bridge.send(t='toBag', id=args[0], bag=' '.join(args[1:]))
    elif cmd in ('lock', 'unlock'):
        need(args, 1, f'{cmd} <id>')
        bridge.send(t='lock', id=args[0], on=cmd == 'lock')
    elif cmd == 'group':
        op, ids, rest = (args + [''])[0], args[1] if len(args) > 1 else '', args[2:]
        n = {'move': 2, 'rot': 1}.get(op)
        try:
            nums = [float(a) for a in rest] if n else []
        except ValueError:
            nums = None
        if not ids or (n and (len(rest) != n or nums is None or not all(map(math.isfinite, nums)))) or (op == 'bag' and not rest):
            raise ValueError(GROUP_USAGE)
        kw = {'dx': nums[0], 'dy': nums[1]} if op == 'move' else {'deg': nums[0]} if op == 'rot' else {'bag': ' '.join(rest)} if op == 'bag' else {}
        bridge.group(op, [i for i in ids.split(',') if i], **kw)
    elif cmd in ('claim', 'release'):
        need(args, 1, f'{cmd} <id>')
        bridge.send(t='owner', id=args[0], to=s['pid'] if cmd == 'claim' else None)
    elif cmd == 'seat':
        need(args, 1, 'seat <id> | seat - | seat +')
        bridge.seat(args[0])
    elif cmd == 'asks':
        bridge.send(t='asks')  # (the tab writes the text: the same in both REPLs)
    elif cmd == 'answer':
        if len(args) < 2:
            raise ValueError('answer <id> <value>')
        bridge.answer(args[0], ' '.join(args[1:]))
    elif cmd == 'select':
        need(args, 1, 'select <id>')
        bridge.select(args[0])
    elif cmd == 'chat':
        bridge.chat(' '.join(args))
    else:
        out(f'unknown command "{cmd}" — try "help"')


def repl(bridge):
    seen = [0]

    def on_state(s, prev):
        if prev is None:
            out(f"\n✅ tab connected: {s['name']} ({s['role']}) in room {s['room']}")
        for e in s['log']:
            if e['ts'] > seen[0]:
                sep = ':' if e.get('chat') else ''
                out(f"  ▸ {e['who']}{sep} {e['text']}")
        seen[0] = max([seen[0]] + [e['ts'] for e in s['log']])
        for m in s.get('msgs', []):
            out(f'  ✉ {m}')

    bridge.on(on_state)
    while True:
        try:
            line = input('🂡 > ').strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not line:
            continue
        try:
            run_cmd(bridge, line)
        except SystemExit:
            break
        except Exception as e:  # a bad command must not kill the session
            out(f'✗ {e}')


def main():
    ap = argparse.ArgumentParser(description='Card Table terminal bridge')
    ap.add_argument('invite', help='room invite URL (contains #room~...)')
    ap.add_argument('--as', dest='as_name', help='join as a separate player with this name (bot mode)')
    ap.add_argument('--port', type=int, default=0, help='bridge port (default: random)')
    ap.add_argument('--open', action='store_true', help='open the browser tab automatically')
    args = ap.parse_args()
    if '#room~' not in args.invite:
        ap.error('the invite URL must contain #room~...')
    bridge = Bridge(port=args.port)
    url = bridge.url_for(args.invite, args.as_name)
    print(f'Card Table bridge listening on 127.0.0.1:{bridge.port}')
    who = f'it will join as "{args.as_name}"' if args.as_name else 'it will control YOUR seat'
    print(f'\nOpen this URL in a browser tab ({who}):\n\n  {url}\n')
    if args.open:
        webbrowser.open(url)
    print('type "help" for commands\n')
    repl(bridge)


if __name__ == '__main__':
    main()
