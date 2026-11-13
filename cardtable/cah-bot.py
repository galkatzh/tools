#!/usr/bin/env python3
"""A Cards Against Humanity bot for the card table — an example of scripting
the terminal bridge (cli.py) as a SEPARATE player.

    python3 cah-bot.py <invite-url> [--name Botty] [--open] [--patience 60]

Run it, open the printed URL in any browser tab (that tab is the bot's body,
this process is its brain), and the bot plays CAH by the same rules as
everyone else: when a black prompt appears it answers with random white cards
face down (re-sending any card that didn't land); when it is the Card Czar it
judges by picking a random answer, and presses "Judge now" once the round is
--patience seconds old so one idle player can't stall it. Every move goes
through the host's validation and lands in the table log.
"""
import argparse
import random
import re
import time
import webbrowser

from cli import Bridge


def czar_id(state):
    return next((p['id'] for p in state['players'] if p.get('turn')), None)


def rules_lines(state, pattern):
    """(ts, match) for the rules script's own log lines matching pattern. A
    player can chat — or rename itself to — the same words, but only script
    lines carry the `rules` flag."""
    return [(e['ts'], m) for e in state['log'] if e.get('rules')
            for m in [re.search(pattern, e['text'])] if m]


def main():
    ap = argparse.ArgumentParser(description='CAH bot for the card table')
    ap.add_argument('invite', help='room invite URL (contains #room~...)')
    ap.add_argument('--name', default='Botty', help='the bot player name')
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--open', action='store_true', help='open the bot tab automatically')
    ap.add_argument('--patience', type=float, default=60, help='as Czar, force judging after this many seconds')
    args = ap.parse_args()

    bridge = Bridge(port=args.port)
    url = bridge.url_for(args.invite, args.name)
    print(f'open the bot tab:\n\n  {url}\n')
    if args.open:
        webbrowser.open(url)

    while bridge.state is None:  # however long it takes to open the tab
        try:
            bridge.wait(lambda s: True, timeout=60)
        except TimeoutError:
            print('… still waiting for the bot tab — open the URL above')
    print(f'connected as {bridge.state["name"]}')

    current = (0, 0.0)  # (ts, local time first seen) of the current round prompt
    keep = 0            # hand size once this round's answer is in
    tries = 0           # answer attempts this round
    sent = 0.0          # when the last attempt went out
    judged = forced = 0  # ts of the judge announce / round we last acted on
    while True:
        time.sleep(1)
        s = bridge.state
        if s.get('rules') != 'Cards Against Humanity':
            continue
        me, czar = s['pid'], czar_id(s)
        # A new round?  The rules script announces "... answer with N card(s)".
        rounds = rules_lines(s, r'answer with (\d) card')
        if not rounds or not czar:
            continue
        ts, m = rounds[-1]
        if ts != current[0]:
            current, keep, tries, sent = (ts, time.time()), len(s['hand']) - int(m.group(1)), 0, 0.0
            if czar != me:
                time.sleep(random.uniform(1, 2))  # let stragglers see it happen
        if czar != me:
            # Answer, and re-send whatever didn't land (a lost or vetoed play
            # leaves the card in hand); each attempt gets a few seconds to show.
            hand = len(s['hand'])
            if hand > keep >= 0 and tries < 3 and time.time() - sent > 5:
                tries, sent = tries + 1, time.time()
                for idx in random.sample(range(hand), hand - keep):
                    bridge.play(idx, up=False)  # by card identity, so order is free
                print(f'answered with {hand - keep} card(s)' if tries == 1
                      else f'answer incomplete — re-sent {hand - keep} card(s)')
            continue
        # My turn to judge?  The czar-only 👉 buttons show up in the state.
        buttons = [b['id'] for b in s['buttons']]
        picks = [b for b in buttons if b.startswith('pick')]
        judge_ann = rules_lines(s, r'judges — press')
        if picks and judge_ann and judge_ann[-1][0] > judged:
            judged = judge_ann[-1][0]
            time.sleep(random.uniform(1, 2))
            choice = random.choice(picks)
            bridge.btn(choice)
            print(f'judged: pressed {choice}')
        elif 'force' in buttons and forced != ts and time.time() - current[1] > args.patience:
            forced = ts  # a straggler would stall the round: judge what's in
            bridge.btn('force')
            print('judging now: pressed force')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nbot stopped')
