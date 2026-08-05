#!/usr/bin/env python3
"""A Cards Against Humanity bot for the card table — an example of scripting
the terminal bridge (cli.py) as a SEPARATE player.

    python3 cah-bot.py <invite-url> [--name Botty] [--open]

Run it, open the printed URL in any browser tab (that tab is the bot's body,
this process is its brain), and the bot plays CAH by the same rules as
everyone else: when a black prompt appears it answers with random white cards
face down; when it is the Card Czar it judges by picking a random answer.
Every move goes through the host's validation and lands in the table log.
"""
import argparse
import random
import re
import time
import webbrowser

from cli import Bridge


def czar_id(state):
    return next((p['id'] for p in state['players'] if p.get('turn')), None)


def main():
    ap = argparse.ArgumentParser(description='CAH bot for the card table')
    ap.add_argument('invite', help='room invite URL (contains #room~...)')
    ap.add_argument('--name', default='Botty', help='the bot player name')
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--open', action='store_true', help='open the bot tab automatically')
    args = ap.parse_args()

    bridge = Bridge(port=args.port)
    url = bridge.url_for(args.invite, args.name)
    print(f'open the bot tab:\n\n  {url}\n')
    if args.open:
        webbrowser.open(url)

    bridge.wait(lambda s: True, timeout=120)
    print(f'connected as {bridge.state["name"]}')

    answered = 0  # ts of the round-start announce we last answered
    judged = 0    # ts of the judge announce we last acted on
    while True:
        time.sleep(1)
        s = bridge.state
        if not s or s.get('rules') != 'Cards Against Humanity':
            continue
        me, czar = s['pid'], czar_id(s)
        # A new round?  The rules script announces "... answer with N card(s)".
        rounds = [(e['ts'], m) for e in s['log']
                  for m in [re.search(r'answer with (\d) card', e['text'])] if m]
        if rounds and czar and czar != me:
            ts, m = rounds[-1]
            if ts > answered:
                pick = int(m.group(1))
                if len(s['hand']) >= pick:
                    answered = ts
                    time.sleep(random.uniform(1, 2))  # let stragglers see it happen
                    idxs = random.sample(range(len(s['hand'])), pick)
                    for idx in sorted(idxs, reverse=True):  # high→low keeps indices valid
                        bridge.play(idx, up=False)
                    print(f'answered with {pick} card(s)')
        # My turn to judge?  The czar-only 👉 buttons show up in the state.
        picks = [b['id'] for b in s['buttons'] if b['id'].startswith('pick')]
        if czar == me and picks:
            judge_ann = [e['ts'] for e in s['log'] if 'judges — press' in e['text']]
            if judge_ann and judge_ann[-1] > judged:
                judged = judge_ann[-1]
                time.sleep(random.uniform(1, 2))
                choice = random.choice(picks)
                bridge.btn(choice)
                print(f'judged: pressed {choice}')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nbot stopped')
