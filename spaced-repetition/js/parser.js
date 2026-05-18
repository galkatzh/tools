// Parse Obsidian-flavoured markdown into flashcards.
//
// A file is split into blank-line-separated blocks. Each block yields one or
// more cards depending on which delimiter it contains. SR metadata comments
// are stripped before classification and re-attached positionally.

import { getConfig } from './config.js';
import { stripSR, parsePayload, serialize as serializeSR } from './srcomment.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build the regex that matches a cloze span for the current delimiters. */
export function clozeRegex(delim) {
  return new RegExp(escapeRe(delim.clozeOpen) + '(.+?)' + escapeRe(delim.clozeClose), 'g');
}

/** Split file text into blocks with their character ranges. */
function segment(text) {
  const lines = text.split('\n');
  const blocks = [];
  let offset = 0;
  let cur = null;
  for (const line of lines) {
    const start = offset;
    if (line.trim() === '') {
      if (cur) blocks.push(cur);
      cur = null;
    } else {
      if (!cur) cur = { start, end: 0 };
      cur.end = start + line.length;
    }
    offset += line.length + 1; // +1 for the '\n'
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => ({ range: [b.start, b.end], raw: text.slice(b.start, b.end) }));
}

function card(type, front, back, clozeIndex) {
  return { type, front, back, clozeIndex, sr: null };
}

/** Turn one block's clean text into card objects. */
function classify(clean, delim) {
  const lines = clean.split('\n');

  const mlr = lines.findIndex((l) => l.trim() === delim.multilineReversed);
  if (mlr !== -1) {
    const a = lines.slice(0, mlr).join('\n').trim();
    const b = lines.slice(mlr + 1).join('\n').trim();
    return [card('basic', a, b), card('basic', b, a)];
  }

  const ml = lines.findIndex((l) => l.trim() === delim.multiline);
  if (ml !== -1) {
    const a = lines.slice(0, ml).join('\n').trim();
    const b = lines.slice(ml + 1).join('\n').trim();
    return [card('basic', a, b)];
  }

  // Check the reversed delimiter first — it contains the basic one.
  for (const [d, reversed] of [[delim.inlineReversed, true], [delim.inline, false]]) {
    const idx = clean.indexOf(d);
    if (idx !== -1) {
      const a = clean.slice(0, idx).trim();
      const b = clean.slice(idx + d.length).trim();
      return reversed ? [card('basic', a, b), card('basic', b, a)] : [card('basic', a, b)];
    }
  }

  const clozeCount = (clean.match(clozeRegex(delim)) || []).length;
  if (clozeCount > 0) {
    return Array.from({ length: clozeCount }, (_, i) => card('cloze', clean, null, i));
  }

  return [];
}

/**
 * Parse a markdown file into card blocks.
 * Each block: { range:[start,end], cleanText, cards:[...] }.
 * Blocks with no cards are dropped.
 */
export function parseFile(text) {
  const delim = getConfig().delim;
  return segment(text)
    .map((seg) => {
      const { clean, payloads } = stripSR(seg.raw);
      const cards = classify(clean, delim);
      cards.forEach((c, i) => {
        if (payloads[i]) c.sr = parsePayload(payloads[i]);
      });
      return { range: seg.range, cleanText: clean, cards };
    })
    .filter((b) => b.cards.length > 0);
}

/**
 * Rebuild a block's text: clean content followed by one SR comment per card.
 * Every card must have an `sr` set (callers fill new cards with empty state).
 */
export function serializeBlock(block) {
  const comments = block.cards.map((c) => serializeSR(c.sr));
  return block.cleanText + '\n' + comments.join('\n');
}

/**
 * Re-attach SR metadata to deck text edited without it (see the editor UI).
 * Any block whose clean text is unchanged from `originalContent` keeps its
 * original SR comments; new or modified blocks are left bare, so they pick up
 * fresh scheduling state on their first review.
 */
export function reattachSR(editedText, originalContent) {
  // Map each original block's clean text to its raw form (SR comments intact).
  const originalBlocks = new Map();
  for (const seg of segment(originalContent)) {
    const { clean } = stripSR(seg.raw);
    if (clean) originalBlocks.set(clean, seg.raw);
  }
  // Splice matching blocks back in, latest first so earlier ranges stay valid.
  const segments = segment(editedText);
  let out = editedText;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const orig = originalBlocks.get(stripSR(seg.raw).clean);
    if (orig && orig !== seg.raw) {
      out = out.slice(0, seg.range[0]) + orig + out.slice(seg.range[1]);
    }
  }
  return out;
}
