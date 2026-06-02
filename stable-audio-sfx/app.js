/**
 * Stable Audio SFX — text-to-sound-effect generation in the browser.
 *
 * worker.js does the model work (download, tokenize, diffuse, decode, WebGPU/WASM). This module
 * owns the UI: prompt + settings, progress, and turning the returned stereo PCM into a WAV.
 */

const $ = (s) => document.querySelector(s);
const el = {
  prompt: $('#prompt'),
  seconds: $('#seconds'), secondsVal: $('#seconds-val'),
  steps: $('#steps'), stepsVal: $('#steps-val'),
  seed: $('#seed'), randomSeed: $('#random-seed'),
  generate: $('#generate'), backend: $('#backend'),
  progress: $('#progress'), progressBar: $('#progress-bar'), progressText: $('#progress-text'),
  results: $('#results'), player: $('#player'), download: $('#download'),
};

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let modelLoaded = false, busy = false, pendingGenerate = null;

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') showProgress(data.text, data.frac);
  else if (data.type === 'loaded') {
    modelLoaded = true;
    el.backend.textContent = data.backend === 'webgpu' ? 'WebGPU' : 'WASM (CPU)';
    if (pendingGenerate) { const g = pendingGenerate; pendingGenerate = null; startGeneration(g); }
  } else if (data.type === 'result') onResult(data);
  else if (data.type === 'error') onError(data.message);
};
worker.onerror = (e) => onError(e.message);

function showProgress(text, fraction) {
  el.progress.classList.remove('hidden');
  el.progressText.textContent = text;
  el.progressBar.style.background = '';
  el.progressBar.style.width = `${Math.round((fraction || 0) * 100)}%`;
}
function setBusy(state) { busy = state; el.generate.disabled = state; el.generate.textContent = state ? 'Generating…' : 'Generate'; }
function onError(message) {
  const text = message || 'Something went wrong (check the console and your network connection).';
  console.error('Generation failed:', text);
  el.progress.classList.remove('hidden');
  el.progressText.textContent = `Error: ${text}`;
  el.progressBar.style.background = '#f44336';
  el.progressBar.style.width = '100%';
  setBusy(false);
}
function onResult({ left, right, seconds }) {
  const url = URL.createObjectURL(encodeWav(left, right, 44100));
  if (el.player.dataset.url) URL.revokeObjectURL(el.player.dataset.url);
  el.player.dataset.url = url;
  el.player.src = url;
  el.download.href = url;
  el.download.download = `${slug(el.prompt.value) || 'sfx'}_${seconds.toFixed(0)}s.wav`;
  el.results.classList.remove('hidden');
  setBusy(false);
}
const slug = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Stereo float → 16-bit PCM WAV. */
function encodeWav(left, right, sampleRate) {
  const n = left.length, buffer = new ArrayBuffer(44 + n * 4), view = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * 4, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    view.setInt16(off, Math.max(-1, Math.min(1, left[i])) * 32767, true); off += 2;
    view.setInt16(off, Math.max(-1, Math.min(1, right[i])) * 32767, true); off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function startGeneration(params) { setBusy(true); el.results.classList.add('hidden'); worker.postMessage({ type: 'generate', ...params }); }

function onGenerateClick() {
  if (busy) return;
  const prompt = el.prompt.value.trim();
  if (!prompt) { el.prompt.focus(); return; }
  const params = { prompt, seconds: parseInt(el.seconds.value, 10), steps: parseInt(el.steps.value, 10), seed: parseInt(el.seed.value, 10) || 0 };
  if (modelLoaded) startGeneration(params);
  else { setBusy(true); pendingGenerate = params; showProgress('Loading model…', 0); worker.postMessage({ type: 'load' }); }
}

el.generate.addEventListener('click', onGenerateClick);
el.seconds.addEventListener('input', () => { el.secondsVal.textContent = `${el.seconds.value}s`; });
el.steps.addEventListener('input', () => { el.stepsVal.textContent = el.steps.value; });
el.randomSeed.addEventListener('click', () => { el.seed.value = Math.floor(Math.random() * 1e9); });

el.secondsVal.textContent = `${el.seconds.value}s`;
el.stepsVal.textContent = el.steps.value;
el.seed.value = Math.floor(Math.random() * 1e9);
el.backend.textContent = navigator.gpu ? 'WebGPU (when loaded)' : 'WASM (CPU)';
