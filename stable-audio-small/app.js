/**
 * Stable Audio — text-to-music generation entirely in the browser.
 *
 * The heavy lifting (model download, tokenization, diffusion, decoding) happens in
 * worker.js. This module owns the UI: collecting the prompt/settings, driving a progress
 * bar from worker messages, and turning the returned stereo PCM into a playable WAV.
 */

const $ = (s) => document.querySelector(s);
const el = {
  prompt: $('#prompt'),
  seconds: $('#seconds'), secondsVal: $('#seconds-val'), durationControl: $('#duration-control'),
  steps: $('#steps'), stepsVal: $('#steps-val'),
  seed: $('#seed'), randomSeed: $('#random-seed'),
  audioInput: $('#audio-input'), audioName: $('#audio-name'), audioClear: $('#audio-clear'), record: $('#record'),
  strengthControl: $('#strength-control'), strength: $('#strength'), strengthVal: $('#strength-val'),
  generate: $('#generate'),
  progress: $('#progress'), progressBar: $('#progress-bar'), progressText: $('#progress-text'),
  results: $('#results'), player: $('#player'), download: $('#download'),
};

// Decoded input clip for audio-to-audio variation, or null for plain text-to-audio.
let inputAudio = null;   // { left: Float32Array, right: Float32Array, name, duration }

// ── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

let modelLoaded = false;
let busy = false;
let pendingGenerate = null;       // generation requested before the model finished loading

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    showProgress(data.text, data.frac);
  } else if (data.type === 'loaded') {
    modelLoaded = true;
    if (pendingGenerate) { const g = pendingGenerate; pendingGenerate = null; startGeneration(g); }
  } else if (data.type === 'result') {
    onResult(data);
  } else if (data.type === 'error') {
    onError(data.message);
  }
};
worker.onerror = (e) => onError(e.message);

// ── UI helpers ───────────────────────────────────────────────────────────────

function showProgress(text, fraction) {
  el.progress.classList.remove('hidden');
  el.progressText.textContent = text;
  el.progressBar.style.background = '';
  el.progressBar.style.width = `${Math.round((fraction || 0) * 100)}%`;
}

function setBusy(state) {
  busy = state;
  el.generate.disabled = state;
  el.generate.textContent = state ? 'Generating…' : 'Generate';
}

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
  const blob = encodeWav(left, right, 44100);
  const url = URL.createObjectURL(blob);
  if (el.player.dataset.url) URL.revokeObjectURL(el.player.dataset.url);
  el.player.dataset.url = url;
  el.player.src = url;
  el.download.href = url;
  el.download.download = `${slug(el.prompt.value) || 'stable-audio-small'}_${seconds.toFixed(0)}s.wav`;
  el.results.classList.remove('hidden');
  setBusy(false);
}

/** Make a filesystem-friendly slug from the prompt. */
function slug(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// ── Audio input (decode + resample to 44.1 kHz stereo) ───────────────────────

/** Decode an uploaded audio file to stereo Float32 channels at 44.1 kHz. */
async function decodeToStereo44k(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ac = new Ctx();
  let decoded;
  try {
    decoded = await ac.decodeAudioData(arrayBuffer);
  } finally {
    ac.close();
  }
  // Render through an OfflineAudioContext to resample to 44.1 kHz and force stereo
  // (mono sources are up-mixed to both channels automatically).
  const length = Math.max(1, Math.ceil(decoded.duration * 44100));
  const off = new OfflineAudioContext(2, length, 44100);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return {
    left: rendered.getChannelData(0).slice(),
    right: rendered.getChannelData(1).slice(),
    duration: rendered.duration,
  };
}

/** Decode a File or recorded Blob into the variation input and reveal the strength control. */
async function loadAudioClip(blob, name) {
  el.audioName.textContent = `Decoding ${name}…`;
  try {
    const { left, right, duration } = await decodeToStereo44k(await blob.arrayBuffer());
    inputAudio = { left, right, name, duration };
    el.audioName.textContent = `${name} — ${duration.toFixed(1)}s`;
    el.audioClear.classList.remove('hidden');
    el.strengthControl.classList.remove('hidden');
    el.durationControl.classList.add('hidden');   // duration now comes from the clip
  } catch (err) {
    console.error('Failed to decode audio:', err);
    el.audioName.textContent = `Couldn't decode that audio (${err.message})`;
    clearAudio();
  }
}

const handleAudioFile = (file) => { if (file) loadAudioClip(file, file.name); };

function clearAudio() {
  inputAudio = null;
  el.audioInput.value = '';
  el.audioName.textContent = '';
  el.audioClear.classList.add('hidden');
  el.strengthControl.classList.add('hidden');
  el.durationControl.classList.remove('hidden');
}

// ── Microphone recording ─────────────────────────────────────────────────────

let mediaRecorder = null;
let recordChunks = [];
let recordTimer = null;

/** Toggle microphone recording; on stop, decode the take like an uploaded clip. */
async function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error('Microphone access failed:', err);
    el.audioName.textContent = `Couldn't access the microphone (${err.message})`;
    return;
  }
  recordChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recordTimer);
    el.record.classList.remove('recording');
    el.record.textContent = '● Rec';
    loadAudioClip(new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' }), 'recording');
  };
  mediaRecorder.start();

  const t0 = Date.now();
  el.record.classList.add('recording');
  el.record.textContent = '■ Stop';
  el.audioClear.classList.add('hidden');
  recordTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    el.audioName.textContent = `Recording… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  el.audioName.textContent = 'Recording… 0:00';
}

// ── WAV encoding (stereo float → 16-bit PCM) ─────────────────────────────────

function encodeWav(left, right, sampleRate) {
  const n = left.length;
  const buffer = new ArrayBuffer(44 + n * 4);
  const view = new DataView(buffer);
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

// ── Generation flow ──────────────────────────────────────────────────────────

function startGeneration(params) {
  setBusy(true);
  el.results.classList.add('hidden');
  worker.postMessage({ type: 'generate', ...params });
}

function onGenerateClick() {
  if (busy) return;
  const prompt = el.prompt.value.trim();
  if (!prompt) { el.prompt.focus(); return; }

  const params = {
    prompt,
    seconds: parseInt(el.seconds.value, 10),
    steps: parseInt(el.steps.value, 10),
    seed: parseInt(el.seed.value, 10) || 0,
    strength: parseFloat(el.strength.value),
    audioLeft: inputAudio ? inputAudio.left : null,
    audioRight: inputAudio ? inputAudio.right : null,
  };

  if (modelLoaded) {
    startGeneration(params);
  } else {
    // First run: kick off the (large) model download, then generate once ready.
    setBusy(true);
    pendingGenerate = params;
    showProgress('Loading model…', 0);
    worker.postMessage({ type: 'load' });
  }
}

// ── Event wiring ─────────────────────────────────────────────────────────────

el.generate.addEventListener('click', onGenerateClick);
el.seconds.addEventListener('input', () => { el.secondsVal.textContent = `${el.seconds.value}s`; });
el.steps.addEventListener('input', () => { el.stepsVal.textContent = el.steps.value; });
el.randomSeed.addEventListener('click', () => { el.seed.value = Math.floor(Math.random() * 1e9); });
el.strength.addEventListener('input', () => { el.strengthVal.textContent = el.strength.value; });
el.audioInput.addEventListener('change', (e) => handleAudioFile(e.target.files[0]));
el.audioClear.addEventListener('click', clearAudio);
el.record.addEventListener('click', toggleRecord);

// Init labels + a random starting seed.
el.secondsVal.textContent = `${el.seconds.value}s`;
el.stepsVal.textContent = el.steps.value;
el.strengthVal.textContent = el.strength.value;
el.seed.value = Math.floor(Math.random() * 1e9);
