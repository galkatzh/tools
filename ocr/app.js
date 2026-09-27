import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import Tesseract from 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const $ = (s) => document.querySelector(s);
const [filesInput, drop, langSel, queryInput, tolInput, tolOut, countEl, statusEl, resultsEl, pagesEl] =
  ['#files', '#drop', '#lang', '#query', '#tol', '#tol-out', '#count', '#status', '#results', '#pages'].map($);

/** Long side (px) PDF pages are rendered at before OCR — roughly 250 dpi for A4/Letter. */
const PDF_RENDER_PX = 2800;

/**
 * Every uploaded image / PDF page. Fields:
 * label, blob (PNG fed to OCR), w/h (its pixel size), el/img/overlay/textEl/stateEl (DOM),
 * words [{text, bbox}], text, index {norm, spans} (search index), done (has OCR words), failed (last OCR errored).
 */
const pages = [];
let matches = [];     // [{page, words: [wordIdx], dist, start}]
let current = -1;     // index into matches
let worker = null;
let workerLang = null;
let activePage = null; // page being recognized, for progress reports
let queue = Promise.resolve();

window.addEventListener('error', (e) => report('Unexpected error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => report('Unhandled promise rejection', e.reason));

try { langSel.value = localStorage.getItem('ocr-lang') || 'eng'; } catch (err) { console.error(err); }
langSel.addEventListener('change', () => {
  try { localStorage.setItem('ocr-lang', langSel.value); } catch (err) { console.error(err); }
});

filesInput.addEventListener('change', () => { addFiles([...filesInput.files]); filesInput.value = ''; });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  addFiles([...e.dataTransfer.files]);
});
document.addEventListener('paste', (e) => {
  const files = [...e.clipboardData.files];
  if (files.length) addFiles(files);
});

queryInput.addEventListener('input', search);
queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go(current + (e.shiftKey ? -1 : 1));
});
tolInput.addEventListener('input', () => { tolOut.value = `${Math.round(tolInput.value * 100)}%`; search(); });
$('#prev').addEventListener('click', () => go(current - 1));
$('#next').addEventListener('click', () => go(current + 1));
$('#view-pages').addEventListener('click', () => setView(false));
$('#view-text').addEventListener('click', () => setView(true));
$('#copy').addEventListener('click', () => navigator.clipboard.writeText(allText())
  .then(() => setStatus('Text copied to clipboard.'), (err) => report('Copy failed', err)));
$('#download').addEventListener('click', () => {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([allText()], { type: 'text/plain' })),
    download: 'ocr.txt',
  });
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#rerun').addEventListener('click', () => pages.forEach(enqueue));
$('#clear').addEventListener('click', () => {
  pages.forEach((p) => URL.revokeObjectURL(p.img.src));
  pages.length = 0;
  pagesEl.replaceChildren();
  search();
  setStatus('Cleared. Add images or PDFs to start.');
});

// ---------- Loading files ----------

/** Turn each file into one page (image) or many (PDF) and queue them for OCR. */
async function addFiles(files) {
  for (const file of files) {
    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) await addPdf(file);
      else if (file.type.startsWith('image/')) await addPage(file.name, await imageToCanvas(file));
      else throw new Error(`unsupported file type "${file.type || file.name}"`);
    } catch (err) {
      report(`Failed to load ${file.name}`, err);
    }
  }
}

/**
 * Decode an image to a canvas. Going through createImageBitmap applies the EXIF
 * orientation, so phone photos are OCR'd the same way up as they are displayed.
 */
async function imageToCanvas(file) {
  const bmp = await createImageBitmap(file);
  const canvas = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return canvas;
}

async function addPdf(file) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    setStatus(`Rendering ${file.name} page ${i}/${pdf.numPages}…`);
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PDF_RENDER_PX / Math.max(base.width, base.height) });
    const canvas = Object.assign(document.createElement('canvas'), {
      width: Math.round(viewport.width), height: Math.round(viewport.height),
    });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PDFs would otherwise OCR as black-on-black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    await addPage(`${file.name} — p. ${i}`, canvas);
  }
  pdf.destroy();
}

/** Create the page card and queue the page for OCR. */
async function addPage(label, canvas) {
  const blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas.toBlob returned null'))), 'image/png'));
  const el = document.createElement('article');
  el.className = 'page';
  el.innerHTML = `<h2><span></span> <small class="state"></small></h2>
    <div class="img-wrap"><img alt=""><div class="overlay"></div></div>
    <div class="text"></div>`;
  el.querySelector('h2 span').textContent = label;
  const page = {
    label, blob, el, w: canvas.width, h: canvas.height, words: [], text: '', index: null, done: false, failed: false,
    img: el.querySelector('img'), overlay: el.querySelector('.overlay'),
    textEl: el.querySelector('.text'), stateEl: el.querySelector('.state'),
  };
  page.img.src = URL.createObjectURL(blob);
  pages.push(page);
  pagesEl.append(el);
  enqueue(page);
}

// ---------- OCR ----------

/** OCR runs one page at a time on a single Tesseract worker. */
function enqueue(page) {
  page.stateEl.textContent = 'queued';
  queue = queue.then(() => recognize(page));
}

async function recognize(page) {
  if (!pages.includes(page)) return; // cleared while queued
  try {
    activePage = page;
    page.stateEl.textContent = 'loading OCR…';
    const w = await getWorker(langSel.value);
    const { data } = await w.recognize(page.blob, {}, { blocks: true, text: true });
    setWords(page, data.blocks ?? []);
    page.stateEl.textContent = `${workerLang} · ${Math.round(data.confidence)}% confidence`;
    page.failed = false;
  } catch (err) {
    console.error(`OCR failed for ${page.label}`, err);
    page.stateEl.textContent = `OCR failed: ${err?.message ?? err}`;
    page.failed = true;
  } finally {
    activePage = null;
  }
  page.el.classList.toggle('failed', page.failed);
  const failed = pages.filter((p) => p.failed).length;
  const ok = pages.filter((p) => p.done && !p.failed).length;
  setStatus(`Recognized ${ok}/${pages.length} page(s)` +
    (failed ? ` · ${failed} failed (see the page cards; Re-run OCR to retry)` : ''), failed > 0);
  search();
}

/** Lazily create the worker, switching its language if the selection changed. */
async function getWorker(lang) {
  if (!worker) {
    worker = await Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          if (activePage) activePage.stateEl.textContent = `recognizing ${Math.round(m.progress * 100)}%`;
        } else {
          setStatus(`${m.status}${m.progress ? ` ${Math.round(m.progress * 100)}%` : ''}`);
        }
      },
      errorHandler: (err) => report('Tesseract worker error', err),
    });
  } else if (workerLang !== lang) {
    await worker.reinitialize(lang, 1);
  }
  workerLang = lang;
  return worker;
}

/**
 * Store the recognized words and render the text view. Paragraphs become <p>,
 * lines are separated by <br>, and each word is a <span data-w=idx> so search
 * hits can be marked in the text as well as on the image.
 */
function setWords(page, blocks) {
  page.words = [];
  const paras = blocks.flatMap((b) => b.paragraphs);
  page.text = paras.map((p) => p.lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n')).join('\n\n');
  page.textEl.replaceChildren(...paras.map((p) => {
    const pEl = document.createElement('p');
    pEl.dir = 'auto';
    p.lines.forEach((line, li) => {
      if (li) pEl.append(document.createElement('br'));
      line.words.forEach((w, wi) => {
        const span = document.createElement('span');
        span.textContent = w.text;
        span.dataset.w = page.words.length;
        pEl.append(...(wi ? [' ', span] : [span]));
        page.words.push({ text: w.text, bbox: w.bbox });
      });
    });
    return pEl;
  }));
  if (!paras.length) page.textEl.textContent = '(no text found)';
  page.index = buildIndex(page.words);
  page.done = true;
}

// ---------- Fuzzy search ----------

/** Lowercase, strip diacritics/punctuation, collapse whitespace. */
const normalize = (s) => s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The page's words joined into one normalized string, plus the char span each
 * word occupies in it, so a char range found by fuzzyFind maps back to words.
 */
function buildIndex(words) {
  let norm = '';
  const spans = [];
  words.forEach((w, i) => {
    const t = normalize(w.text);
    if (!t) return;
    if (norm) norm += ' ';
    spans.push({ start: norm.length, end: norm.length + t.length, word: i });
    norm += t;
  });
  return { norm, spans };
}

/**
 * Approximate substring search (Sellers' algorithm): Levenshtein DP where the
 * match may start anywhere in `text` (first row is all zeros). Alongside each
 * cell's cost we carry the text position where its best path started, so each
 * end position j yields a full [start, j) range. Returns non-overlapping hits
 * with ≤ k edits, best first.
 */
function fuzzyFind(q, text, k) {
  const m = q.length, n = text.length;
  let prev = new Int32Array(n + 1), prevS = Int32Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Int32Array(n + 1), curS = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i; curS[0] = 0;
    for (let j = 1; j <= n; j++) {
      let d = prev[j - 1] + (q[i - 1] === text[j - 1] ? 0 : 1), s = prevS[j - 1]; // match / substitute
      if (prev[j] + 1 < d) { d = prev[j] + 1; s = prevS[j]; }                      // query char missing in text
      if (cur[j - 1] + 1 < d) { d = cur[j - 1] + 1; s = curS[j - 1]; }             // extra char in text
      cur[j] = d; curS[j] = s;
    }
    [prev, cur, prevS, curS] = [cur, prev, curS, prevS];
  }
  const hits = [];
  for (let j = 1; j <= n; j++) if (prev[j] <= k) hits.push({ start: prevS[j], end: j, dist: prev[j] });
  // Each true occurrence also shows up as several slightly worse overlapping
  // ranges; keep the best one and drop anything that overlaps it.
  hits.sort((a, b) => a.dist - b.dist || Math.abs(a.end - a.start - m) - Math.abs(b.end - b.start - m));
  const taken = new Uint8Array(n);
  return hits.filter((h) => {
    for (let c = h.start; c < h.end; c++) if (taken[c]) return false;
    taken.fill(1, h.start, h.end);
    return true;
  });
}

/** Search every recognized page, then redraw results and highlights. */
function search() {
  const q = normalize(queryInput.value);
  const k = Math.min(Math.floor(q.length * tolInput.value), q.length - 1);
  matches = !q ? [] : pages.flatMap((page, pi) => !page.done ? [] :
    fuzzyFind(q, page.index.norm, k).map((h) => ({
      page, pi, dist: h.dist, start: h.start,
      words: page.index.spans.filter((s) => s.start < h.end && s.end > h.start).map((s) => s.word),
    })));
  matches.sort((a, b) => a.dist - b.dist || a.pi - b.pi || a.start - b.start);
  current = matches.length ? 0 : -1;
  renderMatches();
  if (matches.length) go(0);
  else countEl.textContent = '0 / 0';
}

/** Draw a box per matched word on the image, mark the words in the text view, and list results. */
function renderMatches() {
  for (const p of pages) {
    p.overlay.replaceChildren();
    p.textEl.querySelectorAll('mark').forEach((m) => m.replaceWith(...m.childNodes));
  }
  resultsEl.replaceChildren(...matches.map((m, i) => {
    const { w: W, h: H } = m.page;
    m.els = m.words.flatMap((wi) => {
      const { x0, y0, x1, y1 } = m.page.words[wi].bbox;
      const box = document.createElement('div');
      box.className = 'hl';
      Object.assign(box.style, {
        left: `${(x0 / W) * 100}%`, top: `${(y0 / H) * 100}%`,
        width: `${((x1 - x0) / W) * 100}%`, height: `${((y1 - y0) / H) * 100}%`,
      });
      m.page.overlay.append(box);
      const span = m.page.textEl.querySelector(`span[data-w="${wi}"]`);
      const mark = document.createElement('mark');
      span.replaceWith(mark);
      mark.append(span);
      return [box, mark];
    });
    const li = document.createElement('li');
    const words = m.page.words.map((w) => w.text);
    const [a, b] = [m.words[0], m.words.at(-1) + 1];
    li.innerHTML = `<div class="meta"></div><div class="snippet" dir="auto"><span></span><mark></mark><span></span></div>`;
    li.querySelector('.meta').textContent = `${m.page.label} · ${m.dist ? `${m.dist} edit${m.dist > 1 ? 's' : ''}` : 'exact'}`;
    const [pre, hit, post] = li.querySelectorAll('.snippet > *');
    pre.textContent = `${a > 6 ? '…' : ''}${words.slice(Math.max(0, a - 6), a).join(' ')} `;
    hit.textContent = words.slice(a, b).join(' ');
    post.textContent = ` ${words.slice(b, b + 6).join(' ')}${b + 6 < words.length ? '…' : ''}`;
    li.addEventListener('click', () => go(i));
    m.li = li;
    return li;
  }));
}

/** Make match i (wrapping around) the active one and scroll it into view. */
function go(i) {
  if (!matches.length) return;
  matches[current]?.els.forEach((e) => e.classList.remove('active'));
  matches[current]?.li.classList.remove('active');
  current = (i + matches.length) % matches.length;
  const m = matches[current];
  m.els.forEach((e) => e.classList.add('active'));
  m.li.classList.add('active');
  m.li.scrollIntoView({ block: 'nearest' });
  const textMode = pagesEl.classList.contains('text-mode');
  m.els.find((e) => (e.tagName === 'MARK') === textMode)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  countEl.textContent = `${current + 1} / ${matches.length}`;
}

// ---------- Misc ----------

function setView(text) {
  pagesEl.classList.toggle('text-mode', text);
  $('#view-pages').classList.toggle('on', !text);
  $('#view-text').classList.toggle('on', text);
  if (current >= 0) go(current);
}

function allText() {
  return pages.filter((p) => p.done).map((p) => `===== ${p.label} =====\n${p.text}`).join('\n\n');
}

function setStatus(msg, error = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', error);
}

function report(msg, err) {
  console.error(msg, err);
  setStatus(`${msg}: ${err?.message ?? err}`, true);
}
