import { Marp } from 'https://esm.sh/@marp-team/marp-core@3?bundle';
import 'https://esm.sh/@marp-team/marp-core@3/browser?bundle'; // side-effect: registers custom elements
import jsPDF from 'https://esm.sh/jspdf@2?bundle';
import html2canvas from 'https://esm.sh/html2canvas@1?bundle';

const textarea = document.getElementById('markdown');
const container = document.getElementById('slide-container');
const prevBtn = document.getElementById('prev-slide');
const nextBtn = document.getElementById('next-slide');
const indicator = document.getElementById('slide-indicator');
const exportBtn = document.getElementById('export-html');
const pdfBtn = document.getElementById('pdf-btn');
const themeInput = document.getElementById('theme-input');
const clearThemeBtn = document.getElementById('clear-theme');
const preambleInput = document.getElementById('preamble-input');
const clearPreambleBtn = document.getElementById('clear-preamble');

let currentSlide = 0;
let svgSlides = [];
let renderedCss = '';
let customThemeCss = '';
let customThemeName = '';
let customThemeFileName = '';
let preambleText = '';
let preambleFileName = '';
let fragmentIndex = 0;
let fragmentCount = 0;
let slideTransitions = []; // per-slide transition name (e.g. 'slide', 'fade')

// ---------------------------------------------------------------------------
// IndexedDB helpers for theme persistence
// ---------------------------------------------------------------------------

const DB_NAME = 'marp-renderer';
const DB_VERSION = 2;
const THEME_STORE = 'themes';
const PREAMBLE_STORE = 'preambles';

/** Open (or create) the IndexedDB database. */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(THEME_STORE)) db.createObjectStore(THEME_STORE);
      if (!db.objectStoreNames.contains(PREAMBLE_STORE)) db.createObjectStore(PREAMBLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.error('IndexedDB open failed:', req.error); reject(req.error); };
  });
}

/** Save the current custom theme to IndexedDB. */
async function saveTheme() {
  const db = await openDB();
  const tx = db.transaction(THEME_STORE, 'readwrite');
  const store = tx.objectStore(THEME_STORE);
  store.put({ css: customThemeCss, name: customThemeName, fileName: customThemeFileName }, 'current');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => { console.error('Theme save failed:', tx.error); reject(tx.error); };
  });
}

/** Delete the stored theme from IndexedDB. */
async function deleteTheme() {
  const db = await openDB();
  const tx = db.transaction(THEME_STORE, 'readwrite');
  tx.objectStore(THEME_STORE).delete('current');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => { console.error('Theme delete failed:', tx.error); reject(tx.error); };
  });
}

/** Load a previously saved theme from IndexedDB. Returns null if none. */
async function loadTheme() {
  const db = await openDB();
  const tx = db.transaction(THEME_STORE, 'readonly');
  const req = tx.objectStore(THEME_STORE).get('current');
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => { console.error('Theme load failed:', req.error); reject(req.error); };
  });
}

// ---------------------------------------------------------------------------
// Preamble persistence
// ---------------------------------------------------------------------------

/** Save the current preamble to IndexedDB. */
async function savePreamble() {
  const db = await openDB();
  const tx = db.transaction(PREAMBLE_STORE, 'readwrite');
  tx.objectStore(PREAMBLE_STORE).put({ text: preambleText, fileName: preambleFileName }, 'current');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => { console.error('Preamble save failed:', tx.error); reject(tx.error); };
  });
}

/** Delete the stored preamble from IndexedDB. */
async function deletePreamble() {
  const db = await openDB();
  const tx = db.transaction(PREAMBLE_STORE, 'readwrite');
  tx.objectStore(PREAMBLE_STORE).delete('current');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => { console.error('Preamble delete failed:', tx.error); reject(tx.error); };
  });
}

/** Load a previously saved preamble from IndexedDB. Returns null if none. */
async function loadPreamble() {
  const db = await openDB();
  const tx = db.transaction(PREAMBLE_STORE, 'readonly');
  const req = tx.objectStore(PREAMBLE_STORE).get('current');
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => { console.error('Preamble load failed:', req.error); reject(req.error); };
  });
}

// ---------------------------------------------------------------------------
// Preamble injection — prepends macro definitions to the first slide
// ---------------------------------------------------------------------------

/**
 * Inject preamble macros into markdown as a hidden math block after frontmatter.
 * MathJax processes \newcommand and makes macros available to all subsequent
 * math blocks. The definitions produce no visible output on the slide.
 */
function injectPreamble(md) {
  if (!preambleText.trim()) return md;
  const preambleBlock = `\n$$\n${preambleText.trim()}\n$$\n`;
  // Insert after frontmatter closing '---' so it lands on the first slide
  const fmClose = md.match(/^---\s*\n[\s\S]*?\n---\s*$/m);
  if (fmClose) {
    const insertAt = fmClose.index + fmClose[0].length;
    return md.slice(0, insertAt) + preambleBlock + md.slice(insertAt);
  }
  // No frontmatter — prepend directly
  return preambleBlock + md;
}

// ---------------------------------------------------------------------------
// Marp rendering
// ---------------------------------------------------------------------------

/** Create a Marp instance, optionally with a custom theme registered. */
function createMarp() {
  const marp = new Marp({ html: true, script: false });
  if (customThemeCss && customThemeName) {
    marp.themeSet.add(customThemeCss);
  }
  return marp;
}

/**
 * Parse transition directives from markdown source.
 * Reads global `transition: X` from frontmatter and per-slide `<!-- _transition: X -->`.
 * Returns an array of transition names, one per slide.
 */
function parseTransitions(md) {
  // Split into slides on horizontal rules (--- on its own line)
  const slides = md.split(/^---$/m);
  // First chunk may be frontmatter if the doc starts with ---
  let globalTransition = null;
  const fmMatch = slides[0]?.trim() === ''
    ? slides[1]?.match(/^transition:\s*(.+)$/m)
    : null;
  if (fmMatch) globalTransition = fmMatch[1].trim().split(/\s+/)[0];

  // The actual slide content starts after frontmatter (index 2+) or index 0 if no FM
  const slideContents = fmMatch ? slides.slice(2) : slides;
  // First "slide" before any --- could also be content if there's frontmatter
  // But with marp: true, structure is: "" | frontmatter | slide1 | slide2 ...

  return slideContents.map(content => {
    const m = content?.match(/<!--\s*_transition:\s*(\S+)\s*-->/);
    return m ? m[1] : (globalTransition || null);
  });
}

/** Render markdown into slides and update the preview. */
function render() {
  try {
    const marp = createMarp();
    const { html, css } = marp.render(injectPreamble(textarea.value));
    renderedCss = css;

    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    svgSlides = [...tmp.querySelectorAll('svg[data-marpit-svg]')];

    slideTransitions = parseTransitions(textarea.value);

    if (currentSlide >= svgSlides.length) currentSlide = Math.max(0, svgSlides.length - 1);
    showSlide();
  } catch (err) {
    console.error('Marp render error:', err);
    container.innerHTML = `<p style="color:red">${err.message}</p>`;
  }
}

/** Return fragment elements inside the slide shadow DOM, sorted by index. */
function getFragments() {
  const shadow = container.querySelector('#slide-wrapper')?.shadowRoot;
  if (!shadow) return [];
  return [...shadow.querySelectorAll('[data-marpit-fragment]')]
    .sort((a, b) => (+a.dataset.marpitFragment || 0) - (+b.dataset.marpitFragment || 0));
}

/** Show/hide fragments based on the current fragmentIndex. */
function applyFragmentVisibility() {
  for (const el of getFragments()) {
    const idx = +el.dataset.marpitFragment || 0;
    el.style.opacity = idx <= fragmentIndex ? '' : '0';
    el.style.transition = 'opacity 0.3s';
  }
  updateNav();
}

/** Update nav buttons and indicator text. */
function updateNav() {
  indicator.textContent = `${currentSlide + 1} / ${svgSlides.length}`;
  prevBtn.disabled = currentSlide === 0 && fragmentIndex === 0;
  nextBtn.disabled = currentSlide === svgSlides.length - 1 && fragmentIndex >= fragmentCount;
}

/** Display the current slide in the preview pane. */
function showSlide() {
  if (!svgSlides.length) {
    container.innerHTML = '<p style="color:#666">No slides to show</p>';
    indicator.textContent = '0 / 0';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.id = 'slide-wrapper';
  const shadow = wrapper.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = renderedCss;
  shadow.appendChild(style);

  const marpitDiv = document.createElement('div');
  marpitDiv.className = 'marpit';
  marpitDiv.appendChild(svgSlides[currentSlide].cloneNode(true));
  shadow.appendChild(marpitDiv);

  container.appendChild(wrapper);
  requestAnimationFrame(() => fitSlide(wrapper));

  // Discover fragments and apply visibility
  const frags = getFragments();
  fragmentCount = frags.length
    ? Math.max(...frags.map(f => +f.dataset.marpitFragment || 0))
    : 0;
  applyFragmentVisibility();
}

/** Scale the slide wrapper to fit within #slide-container. */
function fitSlide(wrapper) {
  const slideW = 1280, slideH = 720;
  const cw = container.clientWidth - 32;
  const ch = container.clientHeight - 32;
  const scale = Math.min(cw / slideW, ch / slideH);
  wrapper.style.cssText = `width:${slideW}px;height:${slideH}px;transform:scale(${scale});transform-origin:center center;`;
}

// ---------------------------------------------------------------------------
// Slide transitions — CSS keyframes for the View Transitions API
// ---------------------------------------------------------------------------

/** Transition animation definitions: { old, new } CSS animation values per direction. */
const TRANSITIONS = {
  none: () => ({ old: 'none', new: 'none' }),
  fade: () => ({
    old: 'vt-fade-out 0.3s ease',
    new: 'vt-fade-in 0.3s ease',
  }),
  slide: (fwd) => ({
    old: `${fwd ? 'vt-to-left' : 'vt-to-right'} 0.4s ease-in-out`,
    new: `${fwd ? 'vt-from-right' : 'vt-from-left'} 0.4s ease-in-out`,
  }),
  push: (fwd) => ({
    old: `${fwd ? 'vt-to-left' : 'vt-to-right'} 0.35s ease-out`,
    new: `${fwd ? 'vt-from-right' : 'vt-from-left'} 0.35s ease-out`,
  }),
  cover: (fwd) => ({
    old: 'none',
    new: `${fwd ? 'vt-from-right' : 'vt-from-left'} 0.35s ease-out`,
  }),
  reveal: (fwd) => ({
    old: `${fwd ? 'vt-to-left' : 'vt-to-right'} 0.35s ease-in`,
    new: 'none',
    // Old snapshot must stay on top to "reveal" new underneath
    extra: '::view-transition-old(slide){z-index:1}::view-transition-new(slide){z-index:0}',
  }),
  wipe: (fwd) => ({
    old: 'none',
    new: `${fwd ? 'vt-wipe-ltr' : 'vt-wipe-rtl'} 0.4s ease-in-out`,
  }),
  zoom: () => ({
    old: 'vt-zoom-out 0.35s ease-in',
    new: 'vt-zoom-in 0.35s ease-out',
  }),
  drop: () => ({
    old: 'vt-fade-out 0.3s ease',
    new: 'vt-drop-in 0.4s ease-out',
  }),
  flip: (fwd) => ({
    old: `${fwd ? 'vt-flip-out' : 'vt-flip-out-rev'} 0.3s ease-in`,
    new: `${fwd ? 'vt-flip-in' : 'vt-flip-in-rev'} 0.3s 0.15s ease-out`,
  }),
};

// Inject keyframes once into the document
const vtStyle = document.createElement('style');
vtStyle.id = 'vt-keyframes';
vtStyle.textContent = `
@keyframes vt-fade-out { to { opacity: 0 } }
@keyframes vt-fade-in { from { opacity: 0 } }
@keyframes vt-to-left { to { transform: translateX(-100%) } }
@keyframes vt-from-right { from { transform: translateX(100%) } }
@keyframes vt-to-right { to { transform: translateX(100%) } }
@keyframes vt-from-left { from { transform: translateX(-100%) } }
@keyframes vt-wipe-ltr { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0) } }
@keyframes vt-wipe-rtl { from { clip-path: inset(0 0 0 100%) } to { clip-path: inset(0) } }
@keyframes vt-zoom-out { to { transform: scale(0); opacity: 0 } }
@keyframes vt-zoom-in { from { transform: scale(0); opacity: 0 } }
@keyframes vt-drop-in { from { transform: translateY(-100%); opacity: 0 } }
@keyframes vt-flip-out { to { transform: perspective(1200px) rotateY(-90deg) } }
@keyframes vt-flip-in { from { transform: perspective(1200px) rotateY(90deg) } }
@keyframes vt-flip-out-rev { to { transform: perspective(1200px) rotateY(90deg) } }
@keyframes vt-flip-in-rev { from { transform: perspective(1200px) rotateY(-90deg) } }
`;
document.head.appendChild(vtStyle);

// Dynamic style element for per-transition animation rules
const vtDynamic = document.createElement('style');
vtDynamic.id = 'vt-dynamic';
document.head.appendChild(vtDynamic);

/** Inject the correct ::view-transition-* CSS for a given transition name + direction. */
function setTransitionCSS(name, forward) {
  const factory = TRANSITIONS[name] || TRANSITIONS.none;
  const t = factory(forward);
  vtDynamic.textContent = `
::view-transition-old(slide) { animation: ${t.old} !important; }
::view-transition-new(slide) { animation: ${t.new} !important; }
${t.extra || ''}`;
}

// ---------------------------------------------------------------------------
// Navigation — handles fragments, then slides, with View Transitions
// ---------------------------------------------------------------------------

/** Navigate forward (delta=1) or backward (delta=-1), stepping through fragments first. */
function navigate(delta) {
  if (!svgSlides.length) return;

  // Step through fragments before changing slides
  if (delta > 0 && fragmentIndex < fragmentCount) {
    fragmentIndex++;
    applyFragmentVisibility();
    return;
  }
  if (delta < 0 && fragmentIndex > 0) {
    fragmentIndex--;
    applyFragmentVisibility();
    return;
  }

  const next = currentSlide + delta;
  if (next < 0 || next >= svgSlides.length) return;

  // Use the target slide's transition (the slide being revealed)
  const transName = slideTransitions[next] || 'none';

  currentSlide = next;

  // When going back, reveal all fragments of the target slide
  const reveal = () => {
    fragmentIndex = 0;
    showSlide();
    if (delta < 0) {
      fragmentIndex = fragmentCount;
      applyFragmentVisibility();
    }
  };

  if (document.startViewTransition && transName !== 'none') {
    setTransitionCSS(transName, delta > 0);
    document.startViewTransition(reveal);
  } else {
    reveal();
  }
}

prevBtn.addEventListener('click', () => navigate(-1));
nextBtn.addEventListener('click', () => navigate(1));

document.addEventListener('keydown', (e) => {
  if (e.target === textarea) return;
  if (e.key === 'ArrowLeft') { navigate(-1); e.preventDefault(); }
  if (e.key === 'ArrowRight') { navigate(1); e.preventDefault(); }
});

// ---------------------------------------------------------------------------
// Live rendering with debounce
// ---------------------------------------------------------------------------

let debounceTimer;
textarea.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(render, 300);
});

window.addEventListener('resize', () => {
  const wrapper = container.querySelector('#slide-wrapper');
  if (wrapper) fitSlide(wrapper);
});

// ---------------------------------------------------------------------------
// Export to HTML
// ---------------------------------------------------------------------------

exportBtn.addEventListener('click', () => {
  const md = injectPreamble(textarea.value);
  const marp = createMarp();
  const { html, css } = marp.render(md);
  const transitions = JSON.stringify(parseTransitions(textarea.value));

  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Marp Presentation</title>
<style>${css}</style>
<style>
  body { margin: 0; background: #222; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; overflow: hidden; }
  .marpit { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; view-transition-name: slide; }
  .marpit > svg { max-width: 100vw; max-height: 100vh; }
  .controls { position: fixed; bottom: 1rem; display: flex; gap: 0.5rem; z-index: 10; transition: opacity 0.3s; }
  .controls button {
    background: rgba(0,0,0,0.6); color: #fff; border: none; padding: 0.5rem 1rem;
    border-radius: 4px; cursor: pointer; font-size: 1rem;
  }
  .controls button:hover { background: rgba(0,0,0,0.8); }
  body.idle { cursor: none; }
  body.idle .controls { opacity: 0; pointer-events: none; }
  @keyframes vt-fade-out { to { opacity: 0 } }
  @keyframes vt-fade-in { from { opacity: 0 } }
  @keyframes vt-to-left { to { transform: translateX(-100%) } }
  @keyframes vt-from-right { from { transform: translateX(100%) } }
  @keyframes vt-to-right { to { transform: translateX(100%) } }
  @keyframes vt-from-left { from { transform: translateX(-100%) } }
  @keyframes vt-wipe-ltr { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0) } }
  @keyframes vt-wipe-rtl { from { clip-path: inset(0 0 0 100%) } to { clip-path: inset(0) } }
  @keyframes vt-zoom-out { to { transform: scale(0); opacity: 0 } }
  @keyframes vt-zoom-in { from { transform: scale(0); opacity: 0 } }
  @keyframes vt-drop-in { from { transform: translateY(-100%); opacity: 0 } }
  @keyframes vt-flip-out { to { transform: perspective(1200px) rotateY(-90deg) } }
  @keyframes vt-flip-in { from { transform: perspective(1200px) rotateY(90deg) } }
  @keyframes vt-flip-out-rev { to { transform: perspective(1200px) rotateY(90deg) } }
  @keyframes vt-flip-in-rev { from { transform: perspective(1200px) rotateY(-90deg) } }
</style>
<style id="vt-dynamic"></style>
</head>
<body>
${html}
<div class="controls">
  <button onclick="nav(-1)">\u25C0 Prev</button>
  <span id="ind" style="color:#fff;padding:0.5rem">1/1</span>
  <button onclick="nav(1)">Next \u25B6</button>
</div>
<script>
  const svgs = [...document.querySelectorAll('svg[data-marpit-svg]')];
  const slideTransitions = ${transitions};
  let cur = 0;

  /** Transition animation definitions matching the app. */
  const TR = {
    none: () => ({ old: 'none', new: 'none' }),
    fade: () => ({ old: 'vt-fade-out 0.3s ease', new: 'vt-fade-in 0.3s ease' }),
    slide: f => ({ old: (f?'vt-to-left':'vt-to-right')+' 0.4s ease-in-out', new: (f?'vt-from-right':'vt-from-left')+' 0.4s ease-in-out' }),
    push: f => ({ old: (f?'vt-to-left':'vt-to-right')+' 0.35s ease-out', new: (f?'vt-from-right':'vt-from-left')+' 0.35s ease-out' }),
    cover: f => ({ old: 'none', new: (f?'vt-from-right':'vt-from-left')+' 0.35s ease-out' }),
    reveal: f => ({ old: (f?'vt-to-left':'vt-to-right')+' 0.35s ease-in', new: 'none', extra: '::view-transition-old(slide){z-index:1}::view-transition-new(slide){z-index:0}' }),
    wipe: f => ({ old: 'none', new: (f?'vt-wipe-ltr':'vt-wipe-rtl')+' 0.4s ease-in-out' }),
    zoom: () => ({ old: 'vt-zoom-out 0.35s ease-in', new: 'vt-zoom-in 0.35s ease-out' }),
    drop: () => ({ old: 'vt-fade-out 0.3s ease', new: 'vt-drop-in 0.4s ease-out' }),
    flip: f => ({ old: (f?'vt-flip-out':'vt-flip-out-rev')+' 0.3s ease-in', new: (f?'vt-flip-in':'vt-flip-in-rev')+' 0.3s 0.15s ease-out' }),
  };

  function show() {
    svgs.forEach((s, i) => s.style.display = i === cur ? '' : 'none');
    document.getElementById('ind').textContent = (cur+1)+'/'+svgs.length;
  }

  function nav(d) {
    const next = Math.max(0, Math.min(svgs.length - 1, cur + d));
    if (next === cur) return;
    const name = slideTransitions[next] || 'none';
    cur = next;
    const reveal = () => show();

    if (document.startViewTransition && name !== 'none') {
      const fac = TR[name] || TR.none;
      const t = fac(d > 0);
      document.getElementById('vt-dynamic').textContent =
        '::view-transition-old(slide){animation:'+t.old+' !important}' +
        '::view-transition-new(slide){animation:'+t.new+' !important}' +
        (t.extra || '');
      document.startViewTransition(reveal);
    } else {
      reveal();
    }
  }

  document.addEventListener('keydown', e => {
    if (e.key==='ArrowLeft') nav(-1);
    if (e.key==='ArrowRight') nav(1);
  });
  show();

  /* Hide cursor and controls after 2s of mouse inactivity */
  var idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
  });
<\/script>
</body>
</html>`;

  const blob = new Blob([doc], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'presentation.html';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------------------
// PDF export — renders each slide via html2canvas, then assembles into PDF.
// Bypasses window.print() entirely so there are no browser-imposed margins.
// ---------------------------------------------------------------------------

pdfBtn.addEventListener('click', async () => {
  const marp = createMarp();
  const { html, css } = marp.render(injectPreamble(textarea.value));

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const slides = [...tmp.querySelectorAll('svg[data-marpit-svg]')];
  if (!slides.length) return;

  pdfBtn.disabled = true;
  pdfBtn.textContent = 'Exporting\u2026';

  try {
    const W = 1280, H = 720;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [W, H], hotfixes: ['px_scaling'] });

    // Offscreen container for rendering slides with Marp CSS applied
    const offscreen = document.createElement('div');
    offscreen.style.cssText = `position:fixed;left:-9999px;top:0;width:${W}px;height:${H}px;`;
    const shadow = offscreen.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css + `\n.marpit { width:${W}px; height:${H}px; }`;
    shadow.appendChild(style);
    const slideHost = document.createElement('div');
    slideHost.className = 'marpit';
    shadow.appendChild(slideHost);
    document.body.appendChild(offscreen);

    for (let i = 0; i < slides.length; i++) {
      if (i > 0) pdf.addPage([W, H], 'landscape');

      slideHost.innerHTML = '';
      slideHost.appendChild(slides[i].cloneNode(true));
      // html2canvas needs a real DOM element (not shadow DOM), so clone out
      const renderTarget = document.createElement('div');
      renderTarget.style.cssText = `position:fixed;left:-9999px;top:0;width:${W}px;height:${H}px;overflow:hidden;`;
      renderTarget.innerHTML = `<style>${css}\n.marpit{width:${W}px;height:${H}px;}</style>` +
        `<div class="marpit">${slides[i].outerHTML}</div>`;
      document.body.appendChild(renderTarget);

      const canvas = await html2canvas(renderTarget, {
        width: W, height: H, scale: 2, useCORS: true, backgroundColor: '#ffffff',
      });
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, W, H);
      document.body.removeChild(renderTarget);
    }

    document.body.removeChild(offscreen);
    pdf.save('presentation.pdf');
  } catch (err) {
    console.error('PDF export failed:', err);
    alert('PDF export failed: ' + err.message);
  } finally {
    pdfBtn.disabled = false;
    pdfBtn.textContent = '\u2B07 PDF';
  }
});

// ---------------------------------------------------------------------------
// Custom theme loading (with IndexedDB persistence)
// ---------------------------------------------------------------------------

/** Apply a theme (update state + UI + re-render). */
function applyTheme(css, name, fileName) {
  customThemeCss = css;
  customThemeName = name;
  customThemeFileName = fileName;
  clearThemeBtn.hidden = false;
  clearThemeBtn.textContent = `\u2715 ${fileName}`;
  render();
}

themeInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    const css = reader.result;
    const match = css.match(/@theme\s+([\w-]+)/);
    const name = match ? match[1] : 'custom';
    applyTheme(css, name, file.name);
    await saveTheme().catch(err => console.error('Failed to persist theme:', err));
  };
  reader.onerror = () => console.error('Failed to read theme file:', reader.error);
  reader.readAsText(file);
});

clearThemeBtn.addEventListener('click', async () => {
  customThemeCss = '';
  customThemeName = '';
  customThemeFileName = '';
  themeInput.value = '';
  clearThemeBtn.hidden = true;
  render();
  await deleteTheme().catch(err => console.error('Failed to delete theme:', err));
});

// ---------------------------------------------------------------------------
// Preamble loading (with IndexedDB persistence)
// ---------------------------------------------------------------------------

/** Apply a preamble (update state + UI + re-render). */
function applyPreamble(text, fileName) {
  preambleText = text;
  preambleFileName = fileName;
  clearPreambleBtn.hidden = false;
  clearPreambleBtn.textContent = `\u2715 ${fileName}`;
  render();
}

preambleInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    applyPreamble(reader.result, file.name);
    await savePreamble().catch(err => console.error('Failed to persist preamble:', err));
  };
  reader.onerror = () => console.error('Failed to read preamble file:', reader.error);
  reader.readAsText(file);
});

clearPreambleBtn.addEventListener('click', async () => {
  preambleText = '';
  preambleFileName = '';
  preambleInput.value = '';
  clearPreambleBtn.hidden = true;
  render();
  await deletePreamble().catch(err => console.error('Failed to delete preamble:', err));
});

// ---------------------------------------------------------------------------
// Tab key inserts spaces in textarea
// ---------------------------------------------------------------------------

textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    render();
  }
});

// ---------------------------------------------------------------------------
// Init: restore persisted theme + preamble, then render
// ---------------------------------------------------------------------------

(async () => {
  const [savedTheme, savedPreamble] = await Promise.all([
    loadTheme().catch(() => null),
    loadPreamble().catch(() => null),
  ]);

  if (savedPreamble) {
    preambleText = savedPreamble.text;
    preambleFileName = savedPreamble.fileName;
    clearPreambleBtn.hidden = false;
    clearPreambleBtn.textContent = `\u2715 ${savedPreamble.fileName}`;
  }

  if (savedTheme) applyTheme(savedTheme.css, savedTheme.name, savedTheme.fileName);
  else render();
})();
