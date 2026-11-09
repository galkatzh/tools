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
import secrets
import sys
import threading
import time
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
        self._listeners = []
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet, but never silent on errors
                pass

            def _cors(self, code, body=b''):
                self.send_response(code)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                url = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(url.query)
                if q.get('token', [''])[0] != bridge.token:
                    return self._cors(403, b'"bad token"')
                if url.path == '/poll':
                    with bridge._cv:
                        bridge._cv.wait_for(lambda: bridge._cmds, timeout=20)
                        out, bridge._cmds = bridge._cmds, []
                    return self._cors(200, json.dumps(out).encode())
                self._cors(404, b'"not found"')

            def do_POST(self):
                url = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(url.query)
                if q.get('token', [''])[0] != bridge.token:
                    return self._cors(403, b'"bad token"')
                if url.path == '/state':
                    body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                    try:
                        prev, bridge.state = bridge.state, json.loads(body)
                    except ValueError as e:
                        print(f'bad state payload: {e}', file=sys.stderr)
                        return self._cors(400, b'"bad json"')
                    for fn in list(bridge._listeners):
                        fn(bridge.state, prev)
                    return self._cors(200, b'"ok"')
                self._cors(404, b'"not found"')

        self._server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def url_for(self, invite_url, as_name=None):
        base = invite_url.split('~cli~')[0]
        url = f'{base}~cli~{self.port}-{self.token}'
        if as_name:
            url += f'~as~{urllib.parse.quote(as_name)}'
        return url

    def send(self, **cmd):
        """Queues a command for the tab, e.g. send(t='play', idx=0, up=False)."""
        with self._cv:
            self._cmds.append(cmd)
            self._cv.notify_all()

    def on(self, fn):
        """Subscribes fn(state, prev_state); returns an unsubscribe function."""
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn)

    def wait(self, pred, timeout=30):
        """Blocks until the state matches pred; returns it (raises on timeout)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            s = self.state
            if s and pred(s):
                return s
            time.sleep(0.15)
        raise TimeoutError('wait() timed out')

    # convenience wrappers for bot code
    def chat(self, msg): self.send(t='chat', msg=msg)
    def play(self, idx, up=True, **kw): self.send(t='play', idx=idx, up=up, **kw)
    def draw(self, pile=None): self.send(t='draw', id=pile)
    def btn(self, bid): self.send(t='btn', id=bid)

    def close(self):
        self._server.shutdown()


# ---------------------------------------------------------------------------
HELP = """commands:
  hand                    your cards, with indices
  table                   piles and face-up cards
  players                 who sits where (⏳ turn, ⭐ badges, 🏆)
  log [n]                 last n log lines (default 15)
  buttons                 rules buttons you can press
  play <idx...> [--down]  play hand card(s) at your seat (--down = face down)
  draw [pile]             draw from a pile (default: biggest; id or name)
  deal [pile] [--up]      deal the top card onto the table
  shuffle [pile]          shuffle a pile
  flip|peek|tohand <id>   flip / peek at / take a table card
  move <id> <x> <y>       move an item (table coords)
  btn <id>                press a rules button (see "buttons")
  chat <msg>              say something (also "!commands" for rules scripts)
  quit"""


def fmt_card(c):
    text = c.get('text')
    return c['name'] + (f' — {text}' if text and text != c['name'] else '')


def run_cmd(bridge, line):
    parts = line.split()
    cmd, args = parts[0], parts[1:]
    s = bridge.state
    if s is None and cmd not in ('help', 'quit'):
        print('… no tab connected yet')
        return
    if cmd == 'help':
        print(HELP)
    elif cmd == 'quit':
        raise SystemExit
    elif cmd == 'hand':
        for c in s['hand']:
            print(f" {c['idx']:2}. {fmt_card(c)}")
        if not s['hand']:
            print('(empty hand)')
    elif cmd == 'table':
        for it in s['items']:
            if it['kind'] == 'pile':
                print(f"  [{it['id']}] pile \"{it['name'] or 'stack'}\" ×{it['count']} @{it['x']},{it['y']}")
            else:
                print(f"  [{it['id']}] {fmt_card(it) if it['up'] else 'face-down card'} @{it['x']},{it['y']}")
    elif cmd == 'players':
        for p in s['players']:
            mark = '🏆' if p.get('winner') else ('⏳' if p.get('turn') else ' ')
            you = ' (you)' if p['id'] == s['pid'] else ''
            badge = f" {p['badge']}" if p.get('badge') else ''
            off = '' if p['online'] else ' (offline)'
            print(f"  {mark} {p['name']}{you} 🂠{p['cards']}{badge}{off}")
    elif cmd == 'log':
        n = int(args[0]) if args else 15
        for e in s['log'][-n:]:
            sep = ':' if e.get('chat') else ''
            print(f"  {e['who']}{sep} {e['text']}")
    elif cmd == 'buttons':
        for b in s['buttons']:
            print(f"  [{b['id']}] {b['label']}")
        if not s['buttons']:
            print('(none)')
    elif cmd == 'play':
        idxs = sorted((int(a) for a in args if a.isdigit()), reverse=True)
        if not idxs:
            raise ValueError('play <idx...> — see "hand"')
        for idx in idxs:  # high→low so earlier plays don't shift later indices
            bridge.play(idx, up='--down' not in args)
    elif cmd == 'draw':
        bridge.draw(' '.join(args) or None)
    elif cmd == 'deal':
        pile = ' '.join(a for a in args if a != '--up') or None
        bridge.send(t='deal', id=pile, up='--up' in args)
    elif cmd == 'shuffle':
        bridge.send(t='shuffle', id=' '.join(args) or None)
    elif cmd in ('flip', 'peek'):
        bridge.send(t=cmd, id=args[0])
    elif cmd == 'tohand':
        bridge.send(t='toHand', id=args[0])
    elif cmd == 'move':
        bridge.send(t='move', id=args[0], x=int(args[1]), y=int(args[2]))
    elif cmd == 'btn':
        bridge.btn(args[0])
    elif cmd == 'chat':
        bridge.chat(' '.join(args))
    else:
        print(f'unknown command "{cmd}" — try "help"')


def repl(bridge):
    seen = [0]

    def on_state(s, prev):
        if prev is None:
            print(f"\n✅ tab connected: {s['name']} ({s['role']}) in room {s['room']}")
        for e in s['log']:
            if e['ts'] > seen[0]:
                sep = ':' if e.get('chat') else ''
                print(f"  ▸ {e['who']}{sep} {e['text']}")
        seen[0] = max([seen[0]] + [e['ts'] for e in s['log']])
        for m in s.get('msgs', []):
            print(f'  ✉ {m}')

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
            print(f'✗ {e}')


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
