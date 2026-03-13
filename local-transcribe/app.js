/**
 * Local Transcribe — speech-to-text in the browser via Transformers.js + ONNX Runtime.
 *
 * Pipeline: Upload / Record → Decode (16 kHz mono) → Chunk → Workers (ASR) → Merge text
 *
 * Audio chunks are distributed across N parallel Web Workers, each running its own model.
 * This mirrors the audio-splitter architecture: work-stealing queue, per-worker sessions.
 */

// ── Model registry ──────────────────────────────────────────────────────────

const MODELS = [
  {
    id: 'moonshine-tiny',
    name: 'Moonshine Tiny (27 M)',
    repo: 'onnx-community/moonshine-tiny-ONNX',
    apiType: 'pipeline',
    dtype: 'fp32',
    device: 'wasm',
    download: '~60 MB',
    ram: '~120 MB',
  },
  {
    id: 'whisper-base',
    name: 'Whisper Base (74 M)',
    repo: 'onnx-community/whisper-base',
    apiType: 'pipeline',
    dtype: 'fp32',
    device: 'wasm',
    download: '~150 MB',
    ram: '~300 MB',
  },
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large V3 Turbo 4-bit (809 M)',
    repo: 'onnx-community/whisper-large-v3-turbo',
    apiType: 'pipeline',
    dtype: {
      encoder_model: 'fp16',
      decoder_model_merged: 'q4f16',
    },
    device: 'webgpu',
    download: '~560 MB',
    ram: '~1 GB',
  },
  {
    id: 'voxtral-4b-realtime',
    name: 'Voxtral Mini 4B Realtime 4-bit',
    repo: 'onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX',
    apiType: 'voxtral',
    dtype: {
      embed_tokens: 'fp16',
      audio_encoder: 'q4',
      decoder_model_merged: 'q4',
    },
    device: 'webgpu',
    download: '~2.5 GB',
    ram: '~3 GB',
  },
];

// ── DOM ─────────────────────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);
const el = {
  modelSelect: $('#model-select'),
  modelInfo: $('#model-info'),
  dropZone: $('#drop-zone'),
  fileInput: $('#file-input'),
  fileName: $('#file-name'),
  recordBtn: $('#record-btn'),
  recordTimer: $('#record-timer'),
  progress: $('#progress'),
  progressBar: $('#progress-bar'),
  progressText: $('#progress-text'),
  results: $('#results'),
  resultText: $('#result-text'),
  copyBtn: $('#copy-btn'),
  workerCount: $('#worker-count'),
  workerCountVal: $('#worker-count-val'),
  chunkSize: $('#chunk-size'),
  chunkSizeVal: $('#chunk-size-val'),
};

// ── State ───────────────────────────────────────────────────────────────────

let workers = [];
let currentModelId = null;
let processing = false;

// ── Settings persistence ────────────────────────────────────────────────────

function getSetting(key, fallback) {
  return localStorage.getItem(`lt_${key}`) ?? fallback;
}

function setSetting(key, val) {
  localStorage.setItem(`lt_${key}`, val);
}

function getNumWorkers() {
  return parseInt(getSetting('workers', '2'), 10);
}

function getChunkSeconds() {
  return parseInt(getSetting('chunk_s', '30'), 10);
}

function getSelectedModel() {
  return MODELS.find((m) => m.id === el.modelSelect.value) || MODELS[0];
}

// ── Progress helpers ────────────────────────────────────────────────────────

function showProgress(text, fraction) {
  el.progress.classList.remove('hidden');
  el.results.classList.add('hidden');
  el.progressText.textContent = text;
  el.progressBar.style.width = `${Math.round(fraction * 100)}%`;
  el.progressBar.style.background = '';
}

function showError(msg) {
  el.progress.classList.remove('hidden');
  el.progressText.textContent = `Error: ${msg}`;
  el.progressBar.style.width = '100%';
  el.progressBar.style.background = '#f44336';
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

// ── Audio decoding ──────────────────────────────────────────────────────────

/** Decode an audio ArrayBuffer to 16 kHz mono Float32Array. */
async function decodeAudio(arrayBuffer) {
  const audioCtx = new AudioContext();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const numSamples = Math.ceil(decoded.duration * 16000);
  const offlineCtx = new OfflineAudioContext(1, Math.max(numSamples, 1), 16000);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();
  const resampled = await offlineCtx.startRendering();
  return resampled.getChannelData(0);
}

// ── Worker pool ─────────────────────────────────────────────────────────────

/**
 * Wraps a transcribe-worker.js module Worker with a Promise-based API.
 * Each worker loads its own Transformers.js pipeline / model.
 */
class TranscribeWorker {
  constructor(modelConfig) {
    this._pending = new Map();
    this.worker = new Worker(
      new URL('./transcribe-worker.js', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        this._pending.get('init')?.resolve();
        this._pending.delete('init');
      } else if (data.type === 'result') {
        this._pending.get(data.chunkIdx)?.resolve(data.text);
        this._pending.delete(data.chunkIdx);
      } else if (data.type === 'error') {
        const key = data.chunkIdx ?? 'init';
        this._pending.get(key)?.reject(new Error(data.message));
        this._pending.delete(key);
      } else if (data.type === 'load-progress') {
        if (this.onProgress) this.onProgress(data);
      }
    };
    this.worker.onerror = (e) => {
      console.error('[TranscribeWorker]', e);
      for (const { reject } of this._pending.values()) reject(new Error(e.message));
      this._pending.clear();
    };
    this.ready = new Promise((resolve, reject) => {
      this._pending.set('init', { resolve, reject });
    });
    this.worker.postMessage({ type: 'init', model: modelConfig });
  }

  /** Send an audio chunk (Float32Array) for transcription. */
  transcribe(audioChunk, chunkIdx) {
    return new Promise((resolve, reject) => {
      this._pending.set(chunkIdx, { resolve, reject });
      const copy = new Float32Array(audioChunk);
      this.worker.postMessage(
        { type: 'transcribe', chunkIdx, audio: copy.buffer },
        [copy.buffer],
      );
    });
  }

  terminate() { this.worker.terminate(); }
}

/** Terminate all workers and clear the pool. */
function teardownWorkers() {
  workers.forEach((w) => w.terminate());
  workers = [];
  currentModelId = null;
}

/** Create the worker pool for the selected model. */
async function initWorkers(model) {
  teardownWorkers();
  const n = getNumWorkers();
  showProgress(`Loading model into ${n} worker${n > 1 ? 's' : ''}…`, 0);

  /* Track download progress from the first worker. */
  const downloadFiles = new Map();
  const progressHandler = (p) => {
    if (p.status === 'progress' && p.file) {
      downloadFiles.set(p.file, p.progress ?? 0);
      const avg = [...downloadFiles.values()].reduce((a, b) => a + b, 0) / downloadFiles.size;
      showProgress(`Downloading model files… ${Math.round(avg)}%`, avg / 100);
    } else if (p.status === 'ready') {
      showProgress('Model loaded', 1);
    }
  };

  workers = Array.from({ length: n }, () => new TranscribeWorker(model));
  workers[0].onProgress = progressHandler;
  await Promise.all(workers.map((w) => w.ready));
  currentModelId = model.id;
  showProgress('Model loaded — ready', 1);
}

// ── Transcription pipeline ──────────────────────────────────────────────────

/**
 * Split audio into chunks, distribute to worker pool, merge text results.
 * Uses a work-stealing queue: each worker pulls the next available chunk.
 */
async function transcribeAudio(audio) {
  const chunkSamples = getChunkSeconds() * 16000;
  const nChunks = Math.ceil(audio.length / chunkSamples);
  const results = new Array(nChunks);
  const queue = Array.from({ length: nChunks }, (_, i) => i);
  const startTime = Date.now();
  let completed = 0;

  await Promise.all(workers.map(async (worker) => {
    while (queue.length > 0) {
      const i = queue.shift();
      const start = i * chunkSamples;
      const end = Math.min(start + chunkSamples, audio.length);
      const chunk = audio.subarray(start, end);

      results[i] = await worker.transcribe(chunk, i);

      completed++;
      const elapsed = (Date.now() - startTime) / 1000;
      const eta = completed < nChunks ? (elapsed / completed) * (nChunks - completed) : 0;
      const label = `Transcribing chunk ${completed}/${nChunks}`
        + (completed < nChunks ? ` — ${fmtTime(elapsed)} elapsed, ~${fmtTime(eta)} left` : '');
      showProgress(label, completed / nChunks);
    }
  }));

  const elapsed = (Date.now() - startTime) / 1000;
  return { text: results.join(' ').trim(), elapsed };
}

// ── File handling ───────────────────────────────────────────────────────────

async function handleFile(file) {
  if (!file || !file.type.startsWith('audio/')) {
    console.error('Invalid file type:', file?.type);
    return;
  }
  if (processing) return;
  processing = true;

  el.fileName.textContent = file.name;
  el.results.classList.add('hidden');

  try {
    const model = getSelectedModel();
    if (currentModelId !== model.id) {
      await initWorkers(model);
    }

    showProgress('Decoding audio…', 0);
    const audio = await decodeAudio(await file.arrayBuffer());
    const duration = audio.length / 16000;
    showProgress(`Decoded ${fmtTime(duration)} of audio`, 1);

    const { text, elapsed } = await transcribeAudio(audio);

    showProgress(`Done in ${fmtTime(elapsed)}`, 1);
    el.resultText.textContent = text || '(no speech detected)';
    el.results.classList.remove('hidden');
  } catch (err) {
    console.error('Processing failed:', err);
    showError(err.message);
  } finally {
    processing = false;
  }
}

// ── Recording ───────────────────────────────────────────────────────────────

let mediaRecorder = null;
let recordChunks = [];
let recordStart = 0;
let timerInterval = null;

function getRecordingMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function extForMime(mime) {
  if (!mime) return 'm4a';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'm4a';
}

function startTimer() {
  recordStart = Date.now();
  el.recordTimer.classList.remove('hidden');
  el.recordTimer.textContent = '0:00';
  timerInterval = setInterval(() => {
    el.recordTimer.textContent = fmtTime((Date.now() - recordStart) / 1000);
  }, 250);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  el.recordTimer.classList.add('hidden');
}

async function startRecording() {
  const mimeType = getRecordingMime();
  if (mimeType === null) throw new Error('Recording not supported in this browser.');

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recordChunks = [];
  const opts = mimeType ? { mimeType } : undefined;
  mediaRecorder = new MediaRecorder(stream, opts);
  const chosenMime = mediaRecorder.mimeType || mimeType;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(recordChunks, { type: chosenMime });
    const ext = extForMime(chosenMime);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    handleFile(new File([blob], `recording-${ts}.${ext}`, { type: blob.type }));
  };
  mediaRecorder.start();
  el.recordBtn.classList.add('recording');
  el.recordBtn.querySelector('.mic-icon').classList.add('hidden');
  el.recordBtn.querySelector('.stop-icon').classList.remove('hidden');
  startTimer();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  el.recordBtn.classList.remove('recording');
  el.recordBtn.querySelector('.mic-icon').classList.remove('hidden');
  el.recordBtn.querySelector('.stop-icon').classList.add('hidden');
  stopTimer();
  mediaRecorder = null;
}

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    try {
      await startRecording();
    } catch (err) {
      console.error('Microphone access denied:', err);
      alert('Microphone access is required to record audio.');
    }
  }
}

// ── Event listeners ─────────────────────────────────────────────────────────

el.dropZone.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
el.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropZone.classList.add('dragover'); });
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

el.recordBtn.addEventListener('click', toggleRecording);

el.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.resultText.textContent);
    el.copyBtn.textContent = 'Copied!';
    setTimeout(() => { el.copyBtn.textContent = 'Copy'; }, 1500);
  } catch (err) {
    console.error('Copy failed:', err);
  }
});

el.modelSelect.addEventListener('change', () => {
  const model = getSelectedModel();
  el.modelInfo.textContent = `Download: ${model.download} · RAM per worker: ${model.ram}`;
  setSetting('model', model.id);
  teardownWorkers(); // force re-init on next transcription
});

el.workerCount.addEventListener('input', () => {
  const n = parseInt(el.workerCount.value, 10);
  el.workerCountVal.textContent = n;
  setSetting('workers', String(n));
  teardownWorkers();
});

el.chunkSize.addEventListener('input', () => {
  const s = parseInt(el.chunkSize.value, 10);
  el.chunkSizeVal.textContent = `${s}s`;
  setSetting('chunk_s', String(s));
});

// ── Init ────────────────────────────────────────────────────────────────────

function init() {
  /* Populate model dropdown. */
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    el.modelSelect.appendChild(opt);
  }

  /* Restore saved settings. */
  const savedModel = getSetting('model', MODELS[0].id);
  if (MODELS.some((m) => m.id === savedModel)) el.modelSelect.value = savedModel;
  el.modelSelect.dispatchEvent(new Event('change'));

  el.workerCount.value = getNumWorkers();
  el.workerCountVal.textContent = getNumWorkers();

  el.chunkSize.value = getChunkSeconds();
  el.chunkSizeVal.textContent = `${getChunkSeconds()}s`;
}

init();
