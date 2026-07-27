const markdownInput = document.getElementById('markdown-input');
const macrosInput = document.getElementById('macros-input');
const renderedOutput = document.getElementById('rendered-output');
const macroError = document.getElementById('macro-error');
const urlStatus = document.getElementById('url-status');
const toggleEditorBtn = document.getElementById('toggle-editor');
const getUrlBtn = document.getElementById('get-url');
const editorPanel = document.getElementById('editor-panel');

const DEFAULT_MARKDOWN = '';
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

let renderTimer;

/** Decode markdown from URL query string, supporting both compressed (lz~) and legacy formats. */
function decodeQueryMarkdown() {
  const raw = window.location.search.slice(1);
  if (!raw) return '';
  try {
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
  if (!markdownInput.value) return `${window.location.origin}${window.location.pathname}`;
  const compressed = LZString.compressToEncodedURIComponent(markdownInput.value);
  return `${window.location.origin}${window.location.pathname}?${COMPRESS_PREFIX}${compressed}`;
}

/** Parses the document data embedded in standalone copies; returns null in the hosted app. */
function getEmbeddedDoc() {
  const el = document.getElementById('app-embed');
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch (e) {
    console.error('Failed to parse embedded document data:', e);
    return null;
  }
}

function updateQueryString(value) {
  // history.replaceState throws for file:// pages (opaque origin), e.g. standalone copies
  if (window.location.protocol === 'file:') return;
  if (!value) {
    window.history.replaceState({}, '', window.location.pathname);
    return;
  }
  const compressed = LZString.compressToEncodedURIComponent(value);
  window.history.replaceState({}, '', `${window.location.pathname}?${COMPRESS_PREFIX}${compressed}`);
}

function buildMacroPreludeNode() {
  const macroText = macrosInput.value.trim();
  if (!macroText) {
    return null;
  }

  const preludeNode = document.createElement('span');
  preludeNode.style.display = 'none';
  preludeNode.textContent = `\\(${macroText}\\)`;
  return preludeNode;
}

function protectMathSegments(markdown) {
  const segments = [];
  let protectedMarkdown = '';
  let index = 0;

  while (index < markdown.length) {
    if (markdown[index] !== '$' || markdown[index - 1] === '\\') {
      protectedMarkdown += markdown[index];
      index += 1;
      continue;
    }

    const delimiter = markdown[index + 1] === '$' ? '$$' : '$';
    const start = index;
    let cursor = index + delimiter.length;
    let foundEnd = false;

    while (cursor < markdown.length) {
      if (
        markdown.slice(cursor, cursor + delimiter.length) === delimiter
        && markdown[cursor - 1] !== '\\'
      ) {
        cursor += delimiter.length;
        foundEnd = true;
        break;
      }
      cursor += 1;
    }

    if (!foundEnd) {
      protectedMarkdown += markdown[index];
      index += 1;
      continue;
    }

    const token = `@@MATH${segments.length}@@`;
    segments.push({ token, value: markdown.slice(start, cursor) });
    protectedMarkdown += token;
    index = cursor;
  }

  return { protectedMarkdown, segments };
}

function restoreMathSegments(html, segments) {
  return segments.reduce((currentHtml, segment) => {
    return currentHtml.split(segment.token).join(segment.value);
  }, html);
}

async function render() {
  try {
    const { protectedMarkdown, segments } = protectMathSegments(markdownInput.value);
    const html = marked.parse(protectedMarkdown, {
      gfm: true,
      breaks: true
    });

    renderedOutput.innerHTML = DOMPurify.sanitize(restoreMathSegments(html, segments));

    const preludeNode = buildMacroPreludeNode();
    if (preludeNode) {
      renderedOutput.prepend(preludeNode);
    }

    macroError.textContent = '';
    if (window.MathJax?.typesetPromise) {
      window.MathJax.texReset();
      await window.MathJax.typesetPromise([renderedOutput]);
    }
  } catch (error) {
    macroError.textContent = `Math render error: ${error.message}`;
  }
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    render();
  }, 120);
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
  const embedded = getEmbeddedDoc();
  const markdownFromUrl = decodeQueryMarkdown();
  const initialMarkdown = markdownFromUrl.trim() ? markdownFromUrl : (embedded?.markdown ?? DEFAULT_MARKDOWN);

  markdownInput.value = initialMarkdown;
  macrosInput.value = embedded?.macros ?? DEFAULT_MACROS;
  setEditorHidden(initialMarkdown.trim().length > 0);

  markdownInput.addEventListener('input', () => {
    updateQueryString(markdownInput.value);
    scheduleRender();
  });

  macrosInput.addEventListener('input', scheduleRender);
  toggleEditorBtn.addEventListener('click', () => {
    const hidden = editorPanel.classList.contains('hidden');
    setEditorHidden(!hidden);
  });
  getUrlBtn.addEventListener('click', handleGetUrl);

  updateQueryString(markdownInput.value);
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
  exportDims.textContent = `1600 \u00d7 ${physH}`;
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
  } catch {
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
 * Builds an off-screen DOM node for html-to-image capture.
 * Caller must remove it from the document in a finally block.
 */
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
  exportStatus.textContent = 'Generating image\u2026';
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

// --- Standalone Download ---

const downloadAppBtn = document.getElementById('download-app');

// MathJax CHTML fetches its woff fonts from the CDN at runtime, so standalone
// copies use the SVG renderer instead, which is fully self-contained.
const MATHJAX_CHTML_SRC = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js';
const MATHJAX_SVG_SRC = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js';

/**
 * Escapes sequences that would terminate an inline <script> tag ("</script")
 * or open an HTML comment ("<!--"). Both rewrites only ever land inside JS
 * string/regex literals, where the added backslash is an identity escape.
 */
function escapeInlineScript(code) {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/**
 * Collects the app's HTML/CSS/JS plus all CDN library sources.
 * Hosted app: everything is fetched over the network. Standalone copy: the
 * sources are read back from the inlined tags, so no network is needed.
 */
async function getStandaloneSources() {
  const embedded = getEmbeddedDoc();
  if (embedded) {
    return {
      html: embedded.indexHtml,
      css: document.getElementById('app-style').textContent,
      js: document.getElementById('app-src').textContent,
      libs: [...document.querySelectorAll('script[data-lib]')].map(s => ({
        src: s.dataset.lib,
        code: s.textContent,
      })),
    };
  }

  const fetchText = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    return res.text();
  };

  const [html, css, js] = await Promise.all(['index.html', 'style.css', 'app.js'].map(fetchText));
  const libSrcs = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('script[src]')]
    .map(s => s.getAttribute('src'))
    .filter(src => src !== 'app.js');
  const libs = await Promise.all(libSrcs.map(async src => ({
    src,
    code: await fetchText(src === MATHJAX_CHTML_SRC ? MATHJAX_SVG_SRC : src),
  })));
  return { html, css, js, libs };
}

/** Builds a single-file, offline-capable copy of the app with the given text embedded. */
function buildStandaloneHtml({ html, css, js, libs }, markdown, macros) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const style = doc.createElement('style');
  style.id = 'app-style';
  style.textContent = css;
  doc.querySelector('link[rel="stylesheet"]').replaceWith(style);

  // Inline every external script in place. Head scripts execute in document
  // order during parsing, so all libraries are ready before the app source
  // runs at the end of <body> — this replaces the `defer` loading.
  doc.querySelectorAll('script[src]').forEach(s => {
    const src = s.getAttribute('src');
    if (src === 'app.js') {
      s.remove();
      return;
    }
    const lib = libs.find(l => l.src === src);
    if (!lib) throw new Error(`Missing inlined source for script "${src}"`);
    const inline = doc.createElement('script');
    inline.dataset.lib = src;
    inline.textContent = escapeInlineScript(lib.code);
    s.replaceWith(inline);
  });

  // Embed the current text plus the pristine index.html so the copy can
  // regenerate further standalone copies without network access.
  const data = doc.createElement('script');
  data.id = 'app-embed';
  data.type = 'application/json';
  data.textContent = JSON.stringify({ markdown, macros, indexHtml: html }).replace(/</g, '\\u003c');
  doc.body.appendChild(data);

  const appScript = doc.createElement('script');
  appScript.id = 'app-src';
  appScript.textContent = escapeInlineScript(js);
  doc.body.appendChild(appScript);

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/** Downloads a self-contained single-file copy of the app with the current text in it. */
async function handleDownloadApp() {
  urlStatus.textContent = 'Preparing standalone copy…';
  downloadAppBtn.disabled = true;
  try {
    const sources = await getStandaloneSources();
    const standalone = buildStandaloneHtml(sources, markdownInput.value, macrosInput.value);
    downloadBlob(new Blob([standalone], { type: 'text/html;charset=utf-8' }), 'mdmath.html');
    urlStatus.textContent = 'Standalone copy downloaded.';
  } catch (err) {
    console.error('Standalone download failed:', err);
    urlStatus.textContent = `Download failed: ${err.message}`;
  } finally {
    downloadAppBtn.disabled = false;
  }
}

downloadAppBtn.addEventListener('click', handleDownloadApp);
