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

function updateQueryString(value) {
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
  const markdownFromUrl = decodeQueryMarkdown();
  const hasUrlMarkdown = markdownFromUrl.trim().length > 0;

  markdownInput.value = hasUrlMarkdown ? markdownFromUrl : DEFAULT_MARKDOWN;
  macrosInput.value = DEFAULT_MACROS;
  setEditorHidden(hasUrlMarkdown);

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
const exportStickerBtn = document.getElementById('export-sticker-btn');
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

/** Returns true when Web Share API with file support is available (mobile). */
function canShareFiles() {
  try {
    return typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([''], 'test.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
}

/** Sets the primary export button label based on platform capabilities. */
function updateExportPngBtnLabel() {
  if (canShareFiles()) {
    exportPngBtn.textContent = 'Share PNG';
  } else if (navigator.clipboard && window.ClipboardItem) {
    exportPngBtn.textContent = 'Copy PNG';
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
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

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
function buildExportNode() {
  const { width, maxHeight } = getLogicalDims();
  const isDark = exportTheme === 'dark';
  const clone = renderedOutput.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

  const innerMaxH = maxHeight - 64;
  Object.assign(clone.style, {
    position: 'absolute',
    top: '-99999px',
    left: '-99999px',
    width: `${width}px`,
    padding: '32px',
    boxSizing: 'border-box',
    fontSize: `${exportFontSize}px`,
    lineHeight: '1.6',
    fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
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

  document.body.appendChild(clone);
  return clone;
}

/** Captures a DOM node as a PNG blob using html-to-image. */
async function captureNode(node) {
  const { width } = getLogicalDims();
  const blob = await htmlToImage.toBlob(node, {
    pixelRatio: exportPixelRatio,
    width,
    skipFonts: true, // avoid CORS crash on cross-origin CDN stylesheets
  });
  if (!blob) throw new Error('html-to-image returned null blob');
  return blob;
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
  const node = buildExportNode();
  try {
    const blob = await captureNode(node);
    const file = new File([blob], 'mdmath.png', { type: 'image/png' });

    if (canShareFiles()) {
      await navigator.share({ files: [file], title: 'Rendered math' });
      exportStatus.textContent = 'Shared.';
    } else if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      exportStatus.textContent = 'PNG copied to clipboard.';
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
    node.remove();
    exportPngBtn.disabled = false;
  }
}

/**
 * Converts a canvas to a WebP blob ≤100KB (quality reduction loop).
 * Falls back to PNG on Safari, which silently ignores the WebP MIME type.
 */
async function canvasToStickerBlob(canvas) {
  const toBlob = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

  const probe = await toBlob('image/webp', 0.9);
  if (!probe || probe.type !== 'image/webp') {
    // Safari fallback
    const png = await toBlob('image/png');
    if (png.size > 100 * 1024) console.warn(`Sticker PNG is ${Math.round(png.size / 1024)}KB, exceeds 100KB target`);
    return png;
  }

  let quality = 0.85;
  while (quality >= 0.3) {
    const blob = await toBlob('image/webp', quality);
    if (blob.size <= 100 * 1024) return blob;
    quality = Math.round((quality - 0.1) * 10) / 10;
  }
  return toBlob('image/webp', 0.3);
}

/** Exports a 512×512 WhatsApp sticker (WebP ≤100KB, PNG fallback on Safari). */
async function exportSticker() {
  exportStatus.textContent = 'Generating sticker\u2026';
  exportStickerBtn.disabled = true;
  const node = buildExportNode();
  try {
    const { width } = getLogicalDims();
    const sourceCanvas = await htmlToImage.toCanvas(node, {
      pixelRatio: 1,
      width,
      skipFonts: true,
    });

    const sticker = document.createElement('canvas');
    sticker.width = 512;
    sticker.height = 512;
    const ctx = sticker.getContext('2d');

    const isDark = exportTheme === 'dark';
    ctx.fillStyle = isDark ? '#0f172a' : '#ffffff';
    ctx.fillRect(0, 0, 512, 512);

    // Letterbox: scale source to fit within 480×480 (16px margin each side)
    const inner = 480;
    const scale = Math.min(inner / sourceCanvas.width, inner / sourceCanvas.height);
    const dw = Math.round(sourceCanvas.width * scale);
    const dh = Math.round(sourceCanvas.height * scale);
    const dx = Math.round((512 - dw) / 2);
    const dy = Math.round((512 - dh) / 2);
    ctx.drawImage(sourceCanvas, dx, dy, dw, dh);

    const blob = await canvasToStickerBlob(sticker);
    const ext = blob.type === 'image/webp' ? 'webp' : 'png';
    const filename = `sticker.${ext}`;

    if (canShareFiles()) {
      await navigator.share({ files: [new File([blob], filename, { type: blob.type })], title: 'Math sticker' });
      exportStatus.textContent = `Sticker shared (${Math.round(blob.size / 1024)}KB ${ext.toUpperCase()}).`;
    } else {
      downloadBlob(blob, filename);
      exportStatus.textContent = `Sticker downloaded (${Math.round(blob.size / 1024)}KB ${ext.toUpperCase()}).`;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Sticker export failed:', err);
      exportStatus.textContent = `Sticker failed: ${err.message}`;
    } else {
      exportStatus.textContent = '';
    }
  } finally {
    node.remove();
    exportStickerBtn.disabled = false;
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
exportStickerBtn.addEventListener('click', exportSticker);
