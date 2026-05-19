// Render card markdown to sanitized HTML, with LaTeX (MathJax) and ![[...]] embeds.

import { getConfig } from './config.js';
import { clozeRegex } from './parser.js';

const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|aac|flac|opus)(\?.*)?$/i;

/** Replace Obsidian ![[url]] embeds with <img>/<audio> markup. */
function resolveEmbeds(md) {
  return md.replace(/!\[\[(.+?)\]\]/g, (_, ref) => {
    ref = ref.trim();
    if (!/^https?:\/\//i.test(ref)) {
      console.warn('![[...]] embed is not an http(s) URL:', ref);
      return `\`[missing media: ${ref}]\``;
    }
    const url = encodeURI(ref);
    return AUDIO_EXT.test(ref)
      ? `<audio controls src="${url}"></audio>`
      : `<img src="${url}" alt="">`;
  });
}

/** Reveal or blank the target cloze span; other spans render as plain text. */
function applyCloze(text, delim, clozeIndex, reveal) {
  let i = 0;
  return text.replace(clozeRegex(delim), (_, inner) => {
    const isTarget = i++ === clozeIndex;
    if (!isTarget) return inner;
    return reveal ? `<mark class="cloze">${inner}</mark>` : '<mark class="cloze">[ … ]</mark>';
  });
}

/** Markdown + embeds -> sanitized HTML string. */
function renderMarkdown(md) {
  const html = marked.parse(resolveEmbeds(md));
  return DOMPurify.sanitize(html, { ADD_TAGS: ['audio'], ADD_ATTR: ['controls'] });
}

/** Render one side ('front'|'back') of a card to sanitized HTML. */
export function renderCardSide(card, side) {
  if (card.type === 'cloze') {
    return renderMarkdown(
      applyCloze(card.front, getConfig().delim, card.clozeIndex, side === 'back')
    );
  }
  return renderMarkdown(side === 'front' ? card.front : card.back);
}

/**
 * Build a hidden node holding the configured LaTeX macro preamble, so its
 * \newcommand definitions are in scope when the card's math is typeset.
 * Returns null when no preamble is configured.
 */
function macroPreludeNode() {
  const preamble = (getConfig().mathPreamble || '').trim();
  if (!preamble) return null;
  const span = document.createElement('span');
  span.style.display = 'none';
  span.textContent = `\\(${preamble}\\)`;
  return span;
}

/** Typeset any LaTeX inside a DOM node via MathJax, applying the macro preamble. */
export async function typeset(node) {
  if (!window.MathJax?.typesetPromise) return;
  const prelude = macroPreludeNode();
  if (prelude) node.insertBefore(prelude, node.firstChild);
  try {
    MathJax.texReset();
    await MathJax.typesetPromise([node]);
  } catch (e) {
    console.error('MathJax typesetting failed:', e);
  }
}
