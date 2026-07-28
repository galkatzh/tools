import {
  minimalSetup, EditorView, Decoration, WidgetType, placeholder,
  StateEffect, StateField, markdown, markdownLanguage, syntaxTree,
  syntaxHighlighting, HighlightStyle, tags,
} from './codemirror.js';

const macrosInput = document.getElementById('macros-input');
const renderedOutput = document.getElementById('rendered-output');
const macroError = document.getElementById('macro-error');
const urlStatus = document.getElementById('url-status');
const toggleEditorBtn = document.getElementById('toggle-editor');
const getUrlBtn = document.getElementById('get-url');
const editorPanel = document.getElementById('editor-panel');

const COMPRESS_PREFIX = 'lz~';

const DEFAULT_MACROS = String.raw`\newcommand{\sparentheses}[1]{\left[#1\right]}
\newcommand{\co}{{\cal O}}
\newcommand{\ca}{{\cal A}}
\newcommand{\cb}{{\cal B}}
\newcommand{\cd}{{\cal D}}
\newcommand{\cdb}{{\cal D}^{\rm b}}
\newcommand{\cc}{{\cal C}}
\newcommand{\ck}{{\cal K}}
\newcommand{\cq}{{\cal Q}}
\newcommand{\ce}{{\cal E}}
\newcommand{\ct}{{\cal T}}
\newcommand{\cg}{{\cal G}}
\newcommand{\ch}{{\cal H}}
\newcommand{\cm}{{\cal M}}
\newcommand{\ci}{{\cal I}}
\newcommand{\cj}{{\cal J}}
\newcommand{\cw}{{\cal W}}
\newcommand{\cl}{{\cal L}}
\newcommand{\cf}{{\cal F}}
\newcommand{\cv}{{\cal V}}
\newcommand{\cp}{{\cal P}}
\newcommand{\cu}{{\cal U}}
\newcommand{\cx}{{\cal X}}
\newcommand{\cy}{{\cal Y}}
\newcommand{\cz}{{\cal Z}}
\newcommand{\cs}{{\cal S}}
\newcommand{\cn}{{\cal N}}
\newcommand{\ccr}{{\cal R}}
\newcommand{\BB}[1]{\mathbb{#1}}
\newcommand{\FF}{\mathbb{F}}
\newcommand{\bW}{\mathbf{W}}
\newcommand{\x}{\mathbf{x}}
\newcommand{\f}{\mathbf{f}}
\newcommand{\y}{\mathbf{y}}
\newcommand{\z}{\mathbf{z}}
\newcommand{\bt}{\mathbf{t}}
\newcommand{\bw}{\mathbf{w}}
\newcommand{\bv}{\mathbf{v}}
\newcommand{\ba}{\mathbf{a}}
\newcommand{\bu}{\mathbf{u}}
\newcommand{\bc}{\mathbf{c}}
\newcommand{\be}{\mathbf{e}}
\newcommand{\bb}{\mathbf{b}}
\newcommand{\bh}{\mathbf{h}}
\newcommand\ceil[1]{\lceil#1\rceil}
\newcommand{\norm}[1]{\left\lVert#1\right\rVert}
\newcommand{\abs}[1]{\left|#1\right|}
\newcommand{\parentheses}[1]{\left(#1\right)}
\newcommand{\spec}{\mathrm{sp}}
\newcommand{\CC}{\mathcal{C}}
\newcommand{\E}{\mathbb{E}}
\newcommand{\DD}{\mathcal{D}}
\newcommand{\XX}{\mathcal{X}}
\newcommand{\reals}{\mathbb{R}}
\newcommand{\fcnclass}{(\mathbb{R}^d)^\XX}
\newcommand{\cover}[4]{\mathcal{N}_#1(#2, #3, #4)}
\newcommand{\class}[3]{\left[#1\right]_{#2,#3}}
\newcommand{\inner}[1]{{\left\langle #1 \right\rangle}}
\newcommand{\expectation}[1][ ]{\mathbb{E}_{#1}}
\newcommand{\sphere}{\mathbb{S}}
\newcommand{\floor}[1]{\left\lfloor #1 \right\rfloor}
\newcommand{\bracka}[1]{\left[ #1 \right]}
\newcommand{\med}{\mathrm{median}}
\newcommand{\rep}{\mathrm{rep}}
\newcommand{\len}{\mathrm{len}}
\newcommand{\tr}{\mathrm{Tr}}
\newcommand{\var}{\mathrm{Var}}
\newcommand{\adl}{\mathrm{ADL}}
\newcommand{\diag}{\mathrm{diag}}`;

let editorView;
let renderTimer;

window.addEventListener('error', (e) => console.error('Uncaught error:', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled rejection:', e.reason));

/** Current markdown source (the editor document). */
function getMarkdown() {
  return editorView ? editorView.state.doc.toString() : '';
}

/** Decode markdown from the URL: current format is a compressed hash (#lz~…); legacy query-string URLs still work. */
function decodeUrlMarkdown() {
  try {
    const hash = window.location.hash.slice(1);
    if (hash.startsWith(COMPRESS_PREFIX)) {
      return LZString.decompressFromEncodedURIComponent(hash.slice(COMPRESS_PREFIX.length)) || '';
    }
    const raw = window.location.search.slice(1);
    if (!raw) return '';
    if (raw.startsWith(COMPRESS_PREFIX)) {
      return LZString.decompressFromEncodedURIComponent(raw.slice(COMPRESS_PREFIX.length)) || '';
    }
    // Legacy plain URI-encoded URLs
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch (e) {
    console.error('Failed to decode URL markdown:', e);
    return '';
  }
}

function getShareUrl() {
  const value = getMarkdown();
  if (!value) return `${window.location.origin}${window.location.pathname}`;
  const compressed = LZString.compressToEncodedURIComponent(value);
  return `${window.location.origin}${window.location.pathname}#${COMPRESS_PREFIX}${compressed}`;
}

// The payload lives in the URL hash: unlike a query string, the hash is never sent
// to the server, so long documents don't hit server URL-length limits (HTTP 414).
function updateShareUrl(value) {
  if (!value) {
    window.history.replaceState({}, '', window.location.pathname);
    return;
  }
  const compressed = LZString.compressToEncodedURIComponent(value);
  window.history.replaceState({}, '', `${window.location.pathname}#${COMPRESS_PREFIX}${compressed}`);
}

// --- MathJax ---

let mathJaxQueue = Promise.resolve();

/**
 * Serializes MathJax typeset jobs (concurrent typesetPromise calls are unsupported)
 * and defers them until MathJax has finished starting up. The returned promise
 * carries the job's own failure; the queue itself always continues.
 */
function queueTypeset(job) {
  const run = mathJaxQueue.then(async () => {
    await window.MathJax.startup.promise;
    return job();
  });
  mathJaxQueue = run.catch((err) => console.error('MathJax typeset failed:', err));
  return run;
}

/** Scans text for unescaped $…$ / $$…$$ spans; returns [{from, to, display}]. */
function scanMathSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '$' || text[i - 1] === '\\') {
      i += 1;
      continue;
    }
    const delim = text[i + 1] === '$' ? '$$' : '$';
    let cursor = i + delim.length;
    let end = -1;
    while (cursor < text.length) {
      if (text.startsWith(delim, cursor) && text[cursor - 1] !== '\\') {
        end = cursor + delim.length;
        break;
      }
      cursor += 1;
    }
    if (end === -1) {
      i += 1;
      continue;
    }
    spans.push({ from: i, to: end, display: delim === '$$' });
    i = end;
  }
  return spans;
}

/** Replaces math spans with placeholder tokens so marked doesn't mangle TeX. */
function protectMathSegments(markdownText) {
  const segments = [];
  let protectedMarkdown = '';
  let last = 0;
  scanMathSpans(markdownText).forEach((span, n) => {
    const token = `@@MATH${n}@@`;
    segments.push({ token, value: markdownText.slice(span.from, span.to) });
    protectedMarkdown += markdownText.slice(last, span.from) + token;
    last = span.to;
  });
  return { protectedMarkdown: protectedMarkdown + markdownText.slice(last), segments };
}

function restoreMathSegments(html, segments) {
  return segments.reduce((currentHtml, segment) => {
    return currentHtml.split(segment.token).join(segment.value);
  }, html);
}

async function render() {
  try {
    const { protectedMarkdown, segments } = protectMathSegments(getMarkdown());
    const html = marked.parse(protectedMarkdown, {
      gfm: true,
      breaks: true
    });

    renderedOutput.innerHTML = DOMPurify.sanitize(restoreMathSegments(html, segments));

    const macroText = macrosInput.value.trim();
    if (macroText) {
      const preludeNode = document.createElement('span');
      preludeNode.style.display = 'none';
      preludeNode.textContent = `\\(${macroText}\\)`;
      renderedOutput.prepend(preludeNode);
    }

    macroError.textContent = '';
    await queueTypeset(() => {
      window.MathJax.texReset();
      return window.MathJax.typesetPromise([renderedOutput]);
    });
  } catch (error) {
    console.error('Render failed:', error);
    macroError.textContent = `Math render error: ${error.message}`;
  }
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    render();
  }, 120);
}

// --- Editor (CodeMirror live preview) ---

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#93c5fd', textDecoration: 'underline' },
  { tag: tags.url, color: '#64748b' },
  { tag: tags.quote, color: '#94a3b8', fontStyle: 'italic' },
  { tag: tags.contentSeparator, color: '#64748b' },
  // markdown punctuation marks (#, *, >, ```) when visible
  { tag: tags.processingInstruction, color: '#64748b' },
]);

/** Effect dispatched when an async editor math typeset finishes, to trigger a redraw. */
const mathRendered = StateEffect.define();
const mathHtmlCache = new Map(); // 'D|tex' / 'I|tex' -> typeset innerHTML
const mathPending = new Set();

/** Typesets tex off-screen (with the current macro prelude) and caches the resulting HTML. */
function typesetForEditor(tex, display, key) {
  if (mathPending.has(key)) return;
  mathPending.add(key);
  queueTypeset(async () => {
    // Off-screen but laid out: MathJax CHTML needs real layout to measure correctly.
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;';
    const prelude = document.createElement('span');
    prelude.style.display = 'none';
    prelude.textContent = `\\(${macrosInput.value.trim()}\\)`;
    const target = document.createElement('span');
    target.textContent = display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
    host.append(prelude, target);
    document.body.appendChild(host);
    try {
      window.MathJax.texReset();
      await window.MathJax.typesetPromise([host]);
      mathHtmlCache.set(key, target.innerHTML);
    } finally {
      host.remove();
      mathPending.delete(key);
    }
    editorView.dispatch({ effects: mathRendered.of(null) });
  }).catch((err) => console.error('Editor math typeset failed:', err));
}

class MathWidget extends WidgetType {
  constructor(tex, display) {
    super();
    this.tex = tex;
    this.display = display;
    this.key = (display ? 'D|' : 'I|') + tex;
    this.cached = mathHtmlCache.get(this.key) ?? null;
  }
  eq(other) {
    return other.key === this.key && other.cached === this.cached;
  }
  // Let clicks through to CodeMirror so they place the cursor (revealing the source).
  ignoreEvent() {
    return false;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.display ? 'cm-math cm-math-display' : 'cm-math';
    if (this.cached !== null) {
      el.innerHTML = this.cached;
    } else {
      el.textContent = this.tex;
      typesetForEditor(this.tex, this.display, this.key);
    }
    return el;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-live-bullet';
    el.textContent = '•';
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other.checked === this.checked;
  }
  toDOM() {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = this.checked;
    el.disabled = true;
    el.className = 'cm-live-checkbox';
    return el;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-live-hr';
    return el;
  }
}

/**
 * Obsidian-style live preview: markdown syntax is hidden and formatting applied
 * inside the editor, except on lines the cursor/selection touches, which show
 * the raw source. $…$ / $$…$$ spans become MathJax-typeset widgets.
 * A StateField (not a ViewPlugin) because $$ blocks replace line breaks,
 * which plugin-provided decorations aren't allowed to do.
 */
function buildLiveDecorations(state) {
  const doc = state.doc;
  const text = doc.toString();
  const deco = [];

  const activeLines = new Set();
  for (const range of state.selection.ranges) {
    for (let l = doc.lineAt(range.from).number; l <= doc.lineAt(range.to).number; l++) {
      activeLines.add(l);
    }
  }
  const isActive = (from, to) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
      if (activeLines.has(l)) return true;
    }
    return false;
  };
  const hide = (from, to) => deco.push(Decoration.replace({}).range(from, to));
  const hideMark = (from, to) => hide(from, text[to] === ' ' ? to + 1 : to);
  const eachLine = (from, to, cls) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
      deco.push(Decoration.line({ class: cls }).range(doc.line(l).from));
    }
  };

  const tree = syntaxTree(state);

  // Math widgets (lezer-markdown doesn't parse $…$, so scan the text directly)
  for (const span of scanMathSpans(text)) {
    if (isActive(span.from, span.to)) continue;
    let inCode = false;
    for (let n = tree.resolveInner(span.from + 1, 1); n; n = n.parent) {
      if (n.name === 'InlineCode' || n.name === 'FencedCode' || n.name === 'CodeBlock') {
        inCode = true;
        break;
      }
    }
    if (inCode) continue;
    const pad = span.display ? 2 : 1;
    const tex = text.slice(span.from + pad, span.to - pad).trim();
    deco.push(Decoration.replace({
      widget: new MathWidget(tex, span.display),
    }).range(span.from, span.to));
  }

  tree.iterate({
    enter: (node) => {
      const { from, to } = node;
      switch (node.name) {
        case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3':
        case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6':
          eachLine(from, from, 'cm-live-h' + node.name.slice(-1));
          break;
        case 'HeaderMark':
          if (!isActive(from, to)) hideMark(from, to);
          break;
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (!isActive(from, to)) hide(from, to);
          break;
        case 'CodeMark':
          if (node.node.parent?.name === 'InlineCode' && !isActive(from, to)) hide(from, to);
          break;
        case 'InlineCode':
          deco.push(Decoration.mark({ class: 'cm-live-code' }).range(from, to));
          break;
        case 'FencedCode':
          eachLine(from, to, 'cm-live-codeblock');
          break;
        case 'Blockquote':
          eachLine(from, to, 'cm-live-quote');
          break;
        case 'QuoteMark':
          if (!isActive(from, to)) hideMark(from, to);
          break;
        case 'ListMark': {
          if (isActive(from, to)) break;
          // Task-list items get only the checkbox; hide the bullet mark entirely
          if (/^\s?\[[ xX]\]/.test(text.slice(to, to + 4))) {
            hideMark(from, to);
            break;
          }
          const mark = text.slice(from, to);
          if (mark === '-' || mark === '*' || mark === '+') {
            deco.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
          }
          break;
        }
        case 'TaskMarker':
          if (!isActive(from, to)) {
            deco.push(Decoration.replace({
              widget: new CheckboxWidget(/x/i.test(text.slice(from, to))),
            }).range(from, to));
          }
          break;
        case 'HorizontalRule':
          if (!isActive(from, to)) {
            deco.push(Decoration.replace({ widget: new HrWidget() }).range(from, to));
          }
          break;
      }
    },
  });

  return Decoration.set(deco, true);
}

const livePreview = StateField.define({
  create: buildLiveDecorations,
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(mathRendered))) {
      return buildLiveDecorations(tr.state);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function createEditor(initialDoc) {
  return new EditorView({
    parent: document.getElementById('markdown-editor'),
    doc: initialDoc,
    extensions: [
      minimalSetup,
      EditorView.lineWrapping,
      placeholder('# Heading, **bold**, - lists, $E = mc^2$ …'),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdHighlight),
      livePreview,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          updateShareUrl(getMarkdown());
          scheduleRender();
        }
      }),
    ],
  });
}

function setEditorHidden(hidden) {
  editorPanel.classList.toggle('hidden', hidden);
  toggleEditorBtn.textContent = hidden ? 'Show editor' : 'Hide editor';
}

async function handleGetUrl() {
  const shareUrl = getShareUrl();
  try {
    await navigator.clipboard.writeText(shareUrl);
    urlStatus.textContent = 'URL copied to clipboard.';
  } catch {
    window.prompt('Copy this URL:', shareUrl);
    urlStatus.textContent = 'Clipboard unavailable; URL shown in prompt.';
  }
}

function init() {
  const markdownFromUrl = decodeUrlMarkdown();
  editorView = createEditor(markdownFromUrl);
  macrosInput.value = DEFAULT_MACROS;
  setEditorHidden(markdownFromUrl.trim().length > 0);

  macrosInput.addEventListener('input', () => {
    // Macros affect typeset output, so cached editor math is stale
    mathHtmlCache.clear();
    editorView.dispatch({ effects: mathRendered.of(null) });
    scheduleRender();
  });
  toggleEditorBtn.addEventListener('click', () => {
    const hidden = editorPanel.classList.contains('hidden');
    setEditorHidden(!hidden);
    if (hidden) editorView.requestMeasure();
  });
  getUrlBtn.addEventListener('click', handleGetUrl);

  updateShareUrl(getMarkdown());
  scheduleRender();
}

init();

// --- Image Export ---

const exportModal = document.getElementById('export-modal');
const exportPreview = document.getElementById('export-preview');
const exportStatus = document.getElementById('export-status');
const exportPngBtn = document.getElementById('export-png-btn');

const fontSizeSlider = document.getElementById('font-size-slider');
const fontSizeVal = document.getElementById('font-size-val');
const pixelRatioSlider = document.getElementById('pixel-ratio-slider');
const pixelRatioVal = document.getElementById('pixel-ratio-val');
const exportDims = document.getElementById('export-dims');

let exportTheme = 'dark';
let exportFontSize = 16;
let exportPixelRatio = 2;

/** Returns logical CSS dimensions derived from the current pixel ratio. Physical output is always ~1600px. */
function getLogicalDims() {
  const w = Math.round(1600 / exportPixelRatio);
  return { width: w, maxHeight: w };
}

/** Updates the pixel ratio label and physical dimension hint in the modal. */
function updateDimsDisplay() {
  const { maxHeight } = getLogicalDims();
  const clone = exportPreview.firstElementChild;
  // scrollHeight is the natural height before the max-height clamp
  const naturalH = clone ? Math.min(clone.scrollHeight, maxHeight) : maxHeight;
  const physH = Math.round(naturalH * exportPixelRatio);
  pixelRatioVal.textContent = exportPixelRatio;
  exportDims.textContent = `1600 × ${physH}`;
}

/**
 * Prefixes all IDs in a subtree with a unique string and updates all internal
 * cross-references (xlink:href, href, url() in style/attrs). Required so that
 * cloned nodes don't conflict with the original's IDs while keeping internal
 * SVG <use> references (and similar) intact.
 */
function prefixIds(root, prefix) {
  const oldIds = new Set();
  root.querySelectorAll('[id]').forEach(el => oldIds.add(el.id));
  root.querySelectorAll('[id]').forEach(el => { el.id = prefix + el.id; });

  root.querySelectorAll('*').forEach(el => {
    ['href', 'xlink:href'].forEach(attr => {
      const v = el.getAttribute(attr);
      if (v && v.startsWith('#') && oldIds.has(v.slice(1)))
        el.setAttribute(attr, '#' + prefix + v.slice(1));
    });
    ['fill', 'stroke', 'clip-path', 'filter', 'mask'].forEach(attr => {
      const v = el.getAttribute(attr);
      if (v) el.setAttribute(attr, v.replace(/url\(#([^)]+)\)/g,
        (m, id) => oldIds.has(id) ? `url(#${prefix}${id})` : m));
    });
    const s = el.getAttribute('style');
    if (s) el.setAttribute('style', s.replace(/url\(#([^)]+)\)/g,
      (m, id) => oldIds.has(id) ? `url(#${prefix}${id})` : m));
  });
}

/** Returns true when Web Share API with file support is available. */
function canShareFiles() {
  try {
    return typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([''], 'test.png', { type: 'image/png' })] });
  } catch (e) {
    console.error('canShare probe failed:', e);
    return false;
  }
}

/** True on touch-primary devices — used to prefer share over clipboard on mobile. */
function isMobile() {
  return navigator.maxTouchPoints > 0;
}

/** Sets the primary export button label based on platform capabilities. */
function updateExportPngBtnLabel() {
  if (isMobile() && canShareFiles()) {
    exportPngBtn.textContent = 'Share PNG';
  } else if (navigator.clipboard && window.ClipboardItem) {
    exportPngBtn.textContent = 'Copy PNG';
  } else if (canShareFiles()) {
    exportPngBtn.textContent = 'Share PNG';
  } else {
    exportPngBtn.textContent = 'Download PNG';
  }
}

/**
 * Deep-clones the rendered output into the preview pane with current theme/font/size settings.
 * The clone has max-height and overflow:hidden so it exactly mirrors what will be captured.
 */
function refreshExportPreview() {
  const { width, maxHeight } = getLogicalDims();
  const isDark = exportTheme === 'dark';
  const clone = renderedOutput.cloneNode(true);
  prefixIds(clone, 'prev-');

  const innerMaxH = maxHeight - 64; // subtract 2×32px padding
  Object.assign(clone.style, {
    width: `${width}px`,
    padding: '32px',
    boxSizing: 'border-box',
    fontSize: `${exportFontSize}px`,
    lineHeight: '1.6',
    background: isDark ? '#0f172a' : '#ffffff',
    color: isDark ? '#e2e8f0' : '#1e293b',
    maxHeight: `${innerMaxH}px`,
    overflow: 'hidden',
  });

  if (!isDark) {
    clone.querySelectorAll('pre, code').forEach(el => {
      el.style.background = '#f1f5f9';
      el.style.color = '#1e293b';
    });
    clone.querySelectorAll('a').forEach(el => {
      el.style.color = '#2563eb';
    });
  }

  exportPreview.innerHTML = '';
  exportPreview.appendChild(clone);
  scalePreview();
  updateDimsDisplay();
}

/** Scales the preview clone to fit the container width without horizontal scroll. */
function scalePreview() {
  const clone = exportPreview.firstElementChild;
  if (!clone) return;
  clone.style.transform = '';
  const naturalW = clone.scrollWidth;
  const containerW = exportPreview.parentElement.clientWidth - 2; // -2 for border
  if (naturalW > containerW) {
    const scale = containerW / naturalW;
    clone.style.transform = `scale(${scale})`;
    clone.style.transformOrigin = 'top left';
    exportPreview.style.height = `${clone.offsetHeight * scale}px`;
  } else {
    exportPreview.style.height = '';
  }
}

/** Opens the export modal, flushing any pending render first. */
async function openExportModal() {
  clearTimeout(renderTimer);
  await render();
  updateExportPngBtnLabel();
  exportStatus.textContent = '';
  exportModal.showModal();
  // Refresh after showModal so the dialog is in the layout and scrollHeight is correct
  refreshExportPreview();
}

/**
 * Temporarily applies export styles directly to renderedOutput, captures it,
 * then restores the original styles. Must be done this way because html-to-image
 * reads computed styles (including MathJax layout) at call time — using the
 * library's `style` option applies overrides AFTER freezing computed styles,
 * which breaks MathJax CHTML's em-based positioning.
 */
async function captureExport() {
  const { width, maxHeight } = getLogicalDims();
  const isDark = exportTheme === 'dark';
  const bg = isDark ? '#0f172a' : '#ffffff';
  const el = renderedOutput;

  const savedStyle = el.getAttribute('style'); // null if no style attr
  Object.assign(el.style, {
    width: `${width}px`,
    margin: '0',            // remove auto-centering so capture aligns to left edge
    padding: '32px',
    boxSizing: 'border-box',
    fontSize: `${exportFontSize}px`,
    lineHeight: '1.6',
    background: bg,
    color: isDark ? '#e2e8f0' : '#1e293b',
    maxHeight: `${maxHeight - 64}px`,
    overflow: 'hidden',
  });

  // Force layout flush so MathJax CHTML reflows before html-to-image reads styles
  el.getBoundingClientRect();

  // Light theme: inject a temporary <style> for descendant color overrides
  let lightSheet = null;
  if (!isDark) {
    lightSheet = document.createElement('style');
    lightSheet.textContent =
      '#rendered-output pre,#rendered-output code{background:#f1f5f9!important;color:#1e293b!important}' +
      '#rendered-output a{color:#2563eb!important}';
    document.head.appendChild(lightSheet);
  }

  try {
    const opts = { pixelRatio: exportPixelRatio, backgroundColor: bg };
    const blob = await htmlToImage.toBlob(el, opts);
    if (!blob) throw new Error('html-to-image returned null blob');
    return blob;
  } finally {
    if (savedStyle !== null) el.setAttribute('style', savedStyle);
    else el.removeAttribute('style');
    if (lightSheet) lightSheet.remove();
  }
}

/** Triggers a file download from a Blob. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Exports the rendered content as PNG: share on mobile, copy on desktop, download as fallback. */
async function exportPng() {
  exportStatus.textContent = 'Generating image…';
  exportPngBtn.disabled = true;
  try {
    const blob = await captureExport();
    const file = new File([blob], 'mdmath.png', { type: 'image/png' });

    // On mobile, prefer share sheet (richer UX). On desktop, prefer clipboard
    // because Windows/Chrome's share sheet copies as a file, not image pixels.
    if (isMobile() && canShareFiles()) {
      await navigator.share({ files: [file] });
      exportStatus.textContent = 'Shared.';
    } else if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      exportStatus.textContent = 'PNG copied to clipboard.';
    } else if (canShareFiles()) {
      await navigator.share({ files: [file] });
      exportStatus.textContent = 'Shared.';
    } else {
      downloadBlob(blob, 'mdmath.png');
      exportStatus.textContent = 'Image downloaded.';
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('PNG export failed:', err);
      exportStatus.textContent = `Export failed: ${err.message}`;
    } else {
      exportStatus.textContent = '';
    }
  } finally {
    exportPngBtn.disabled = false;
  }
}

// Wire up export modal events
document.getElementById('export-image').addEventListener('click', openExportModal);
document.getElementById('export-modal-close').addEventListener('click', () => exportModal.close());
exportModal.addEventListener('click', e => { if (e.target === exportModal) exportModal.close(); });
exportModal.addEventListener('toggle', () => { if (exportModal.open) { scalePreview(); updateDimsDisplay(); } });
window.addEventListener('resize', () => { if (exportModal.open) scalePreview(); });

document.getElementById('theme-dark').addEventListener('click', () => {
  exportTheme = 'dark';
  document.getElementById('theme-dark').classList.add('active');
  document.getElementById('theme-light').classList.remove('active');
  refreshExportPreview();
});

document.getElementById('theme-light').addEventListener('click', () => {
  exportTheme = 'light';
  document.getElementById('theme-light').classList.add('active');
  document.getElementById('theme-dark').classList.remove('active');
  refreshExportPreview();
});

fontSizeSlider.addEventListener('input', () => {
  exportFontSize = Number(fontSizeSlider.value);
  fontSizeVal.textContent = exportFontSize;
  refreshExportPreview();
});

pixelRatioSlider.addEventListener('input', () => {
  exportPixelRatio = Number(pixelRatioSlider.value);
  refreshExportPreview();
});

exportPngBtn.addEventListener('click', exportPng);
