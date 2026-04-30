"""Extract plain Hebrew words (no nikud) from a Hebrew Wiktionary XML dump."""
import bz2
import re
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# Nikud (vowel points) and cantillation marks
NIKUD_RE = re.compile(r'[֑-ׇװ-״]')
HEB_LETTER = re.compile(r'[א-ת]')
LATIN_RE = re.compile(r'[a-zA-Z]')

def strip_nikud(text: str) -> str:
    return NIKUD_RE.sub('', text)

def is_valid(title: str) -> bool:
    """Accept only clean Hebrew words/phrases from main namespace.

    Rejects: namespaces (colons), user subpages (slashes), Latin chars,
    leading hyphens (suffixes/prefixes), and titles with fewer than 2 Hebrew letters.
    """
    if ':' in title or '/' in title or '\\' in title:
        return False
    if title.startswith('-'):
        return False
    if LATIN_RE.search(title):
        return False
    return len(HEB_LETTER.findall(title)) >= 2

dump_path = Path(__file__).parent.parent / 'hewiktionary-2026-04-01-p2p64178.xml.bz2'
NS = 'http://www.mediawiki.org/xml/export-0.11/'
tag = lambda t: f'{{{NS}}}{t}'

words: set[str] = set()
page: dict = {}
count = 0

print(f'Reading {dump_path} ...', file=sys.stderr)
with bz2.open(dump_path, 'rb') as f:
    for event, elem in ET.iterparse(f, events=['start', 'end']):
        if event == 'start' and elem.tag == tag('page'):
            page = {}
        elif event == 'end':
            if elem.tag == tag('ns'):
                page['ns'] = elem.text
            elif elem.tag == tag('title'):
                page['title'] = elem.text or ''
            elif elem.tag == tag('page'):
                if page.get('ns') == '0':  # main article namespace only
                    title = page['title']
                    stripped = strip_nikud(title.strip())
                    if is_valid(stripped):
                        words.add(stripped)
                    count += 1
                    if count % 5000 == 0:
                        print(f'  {count} main pages, {len(words)} words', file=sys.stderr)
                elem.clear()

word_list = sorted(words)
print(f'Done: {len(word_list)} unique Hebrew words', file=sys.stderr)

out = Path(__file__).parent / 'words.json'
out.write_text(json.dumps(word_list, ensure_ascii=False), encoding='utf-8')
print(f'Wrote {out}', file=sys.stderr)
