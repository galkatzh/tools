import { Marp } from 'https://esm.sh/@marp-team/marp-core@3?bundle';
import applyBrowser from 'https://esm.sh/@marp-team/marp-core@3/browser?bundle';

const textarea = document.getElementById('markdown');
const container = document.getElementById('slide-container');
const prevBtn = document.getElementById('prev-slide');
const nextBtn = document.getElementById('next-slide');
const indicator = document.getElementById('slide-indicator');
const exportBtn = document.getElementById('export-html');
const printBtn = document.getElementById('print-btn');
const themeInput = document.getElementById('theme-input');
const clearThemeBtn = document.getElementById('clear-theme');

let currentSlide = 0;
let svgSlides = [];   // array of <svg> elements (one per slide)
let renderedCss = '';
let renderedHtml = '';
let customThemeCss = '';
let customThemeName = '';

/** Create a Marp instance, optionally with a custom theme registered. */
function createMarp() {
  const marp = new Marp({ html: true, script: false });
  if (customThemeCss && customThemeName) {
    marp.themeSet.add(customThemeCss);
  }
  return marp;
}

/** Render markdown into slides and update the preview. */
function render() {
  try {
    const marp = createMarp();
    const { html, css } = marp.render(textarea.value);
    renderedCss = css;
    renderedHtml = html;

    // Marp v3 wraps each slide in <svg> inside a <div class="marpit">
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    svgSlides = [...tmp.querySelectorAll('svg[data-marpit-svg]')];

    // Clamp current slide index
    if (currentSlide >= svgSlides.length) currentSlide = Math.max(0, svgSlides.length - 1);

    showSlide();
  } catch (err) {
    console.error('Marp render error:', err);
    container.innerHTML = `<p style="color:red">${err.message}</p>`;
  }
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

  // Use shadow DOM to isolate Marp styles from the app
  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.id = 'slide-wrapper';
  const shadow = wrapper.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = renderedCss;
  shadow.appendChild(style);

  // Wrap in marpit div so Marp's CSS selectors match
  const marpitDiv = document.createElement('div');
  marpitDiv.className = 'marpit';
  marpitDiv.appendChild(svgSlides[currentSlide].cloneNode(true));
  shadow.appendChild(marpitDiv);

  // Apply Marp browser helper for auto-scaling text
  try { applyBrowser(shadow); } catch (e) { console.warn('Marp browser helper:', e); }

  container.appendChild(wrapper);

  // Scale to fit
  requestAnimationFrame(() => fitSlide(wrapper));

  indicator.textContent = `${currentSlide + 1} / ${svgSlides.length}`;
  prevBtn.disabled = currentSlide === 0;
  nextBtn.disabled = currentSlide === svgSlides.length - 1;
}

/** Scale the slide wrapper to fit within #slide-container. */
function fitSlide(wrapper) {
  // Marp default viewBox is 1280x720
  const slideW = 1280;
  const slideH = 720;
  const cw = container.clientWidth - 32;
  const ch = container.clientHeight - 32;
  const scale = Math.min(cw / slideW, ch / slideH);
  wrapper.style.cssText = `width:${slideW}px;height:${slideH}px;transform:scale(${scale});transform-origin:center center;`;
}

// --- Navigation ---
prevBtn.addEventListener('click', () => { if (currentSlide > 0) { currentSlide--; showSlide(); } });
nextBtn.addEventListener('click', () => { if (currentSlide < svgSlides.length - 1) { currentSlide++; showSlide(); } });

document.addEventListener('keydown', (e) => {
  if (e.target === textarea) return;
  if (e.key === 'ArrowLeft') { prevBtn.click(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { nextBtn.click(); e.preventDefault(); }
});

// --- Live rendering with debounce ---
let debounceTimer;
textarea.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(render, 300);
});

// --- Resize handling ---
window.addEventListener('resize', () => {
  const wrapper = container.querySelector('#slide-wrapper');
  if (wrapper) fitSlide(wrapper);
});

// --- Export to HTML ---
exportBtn.addEventListener('click', () => {
  const marp = createMarp();
  const { html, css } = marp.render(textarea.value);

  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Marp Presentation</title>
<style>${css}</style>
<style>
  body { margin: 0; background: #222; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; }
  svg[data-marpit-svg] { display: none; max-width: 100vw; max-height: 100vh; }
  svg[data-marpit-svg].active { display: block; }
  .controls { position: fixed; bottom: 1rem; display: flex; gap: 0.5rem; z-index: 10; }
  .controls button {
    background: rgba(0,0,0,0.6); color: #fff; border: none; padding: 0.5rem 1rem;
    border-radius: 4px; cursor: pointer; font-size: 1rem;
  }
  .controls button:hover { background: rgba(0,0,0,0.8); }
</style>
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
  let cur = 0;
  function show() {
    svgs.forEach((s, i) => s.classList.toggle('active', i === cur));
    document.getElementById('ind').textContent = (cur+1)+'/'+svgs.length;
  }
  function nav(d) { cur = Math.max(0, Math.min(svgs.length-1, cur+d)); show(); }
  document.addEventListener('keydown', e => {
    if (e.key==='ArrowLeft') nav(-1);
    if (e.key==='ArrowRight') nav(1);
  });
  show();
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

// --- Print / PDF ---
printBtn.addEventListener('click', () => {
  const marp = createMarp();
  const { html, css } = marp.render(textarea.value);

  const printDoc = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Print Presentation</title>
<style>${css}</style>
<style>
  @page { size: landscape; margin: 0; }
  body { margin: 0; background: #fff; }
  svg[data-marpit-svg] { page-break-after: always; break-after: page; width: 100vw; height: 100vh; }
  svg[data-marpit-svg]:last-of-type { page-break-after: avoid; }
</style>
</head><body>${html}
<script>window.onload = () => { window.print(); }<\/script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) {
    console.error('Popup blocked — allow popups for print export');
    alert('Please allow popups to use the print feature.');
    return;
  }
  w.document.write(printDoc);
  w.document.close();
});

// --- Custom theme loading ---
themeInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    customThemeCss = reader.result;
    // Extract theme name from CSS comment: /* @theme my-theme */
    const match = customThemeCss.match(/@theme\s+([\w-]+)/);
    customThemeName = match ? match[1] : 'custom';
    clearThemeBtn.hidden = false;
    clearThemeBtn.textContent = `\u2715 ${file.name}`;
    render();
  };
  reader.onerror = () => console.error('Failed to read theme file:', reader.error);
  reader.readAsText(file);
});

clearThemeBtn.addEventListener('click', () => {
  customThemeCss = '';
  customThemeName = '';
  themeInput.value = '';
  clearThemeBtn.hidden = true;
  render();
});

// --- Tab key inserts spaces in textarea ---
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

// Initial render
render();
