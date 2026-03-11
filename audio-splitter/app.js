/**
 * Audio Splitter — separate vocals from instrumentals using SCNet + ONNX Runtime.
 *
 * Pipeline: Upload → Decode → Chunk → Worker (STFT → ONNX → iSTFT) → Crossfade → Output
 *
 * Chunks are distributed across N parallel Web Workers, each owning an ONNX session.
 * The SCNet model separates audio into 4 stems: drums, bass, other, vocals.
 * We combine drums+bass+other as "instrumental" and keep vocals as "acapella".
 */

import {
  SAMPLE_RATE, N_FREQ, HOP_LENGTH, N_FFT,
  stft, istft, decodeAudio, encodeWav,
} from './audio-processor.js';

// ── Configuration ──────────────────────────────────────────────────────────

/** URL to the ONNX model file. Update after uploading to HuggingFace. */
const MODEL_URL = localStorage.getItem('scnet_model_url')
  || 'https://huggingface.co/bgkb/scnet_onnx/resolve/main/scnet.onnx';

/** Process audio in 11-second chunks (matching SCNet training config). */
const CHUNK_SECONDS = 11;
const CHUNK_SAMPLES = CHUNK_SECONDS * SAMPLE_RATE;

/** 1-second overlap between adjacent chunks for crossfade. */
const OVERLAP_SAMPLES = 1 * SAMPLE_RATE;

// ── DOM elements ───────────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);
const el = {
  dropZone: $('#drop-zone'),
  fileInput: $('#file-input'),
  fileName: $('#file-name'),
  progress: $('#progress'),
  progressBar: $('#progress-bar'),
  progressText: $('#progress-text'),
  results: $('#results'),
  vocalPlayer: $('#vocal-player'),
  instrPlayer: $('#instr-player'),
  vocalDl: $('#vocal-download'),
  instrDl: $('#instr-download'),
  modelUrl: $('#model-url'),
  modelUrlSave: $('#model-url-save'),
  workerCount: $('#worker-count'),
  workerCountVal: $('#worker-count-val'),
  threadCount: $('#thread-count'),
  threadCountVal: $('#thread-count-val'),
};

// ── State ──────────────────────────────────────────────────────────────────

let modelBytes = null;  // Uint8Array — kept for worker initialization
let workers    = [];    // ChunkWorker instances, created on model load

// ── Worker settings ────────────────────────────────────────────────────────

function getNumWorkers() {
  return parseInt(localStorage.getItem('scnet_num_workers') || '2', 10);
}

function getNumThreads() {
  return parseInt(localStorage.getItem('scnet_num_threads') || '1', 10);
}

// ── IndexedDB model cache ──────────────────────────────────────────────────

const DB_NAME = 'audio-splitter-cache';
const STORE_NAME = 'models';

/** Open or create the IndexedDB for caching the ONNX model binary. */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedModel(url) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    console.warn('IndexedDB read failed:', e);
    return null;
  }
}

async function setCachedModel(url, data) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, url);
  } catch (e) {
    console.warn('IndexedDB write failed:', e);
  }
}

// ── Progress helpers ───────────────────────────────────────────────────────

function showProgress(text, fraction) {
  el.progress.classList.remove('hidden');
  el.results.classList.add('hidden');
  el.progressText.textContent = text;
  el.progressBar.style.width = `${Math.round(fraction * 100)}%`;
}

function showCompletion(elapsed) {
  el.progressText.textContent = `Done in ${fmt(elapsed)}`;
  el.progressBar.style.width = '100%';
}

/** Yield control to the browser so the UI can repaint. */
function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

/** Format seconds as m:ss */
function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ── Web Worker pool ────────────────────────────────────────────────────────

/**
 * Wraps a splitter-worker.js Web Worker with a Promise-based API.
 * Each worker loads its own ONNX session and processes one chunk at a time.
 */
class ChunkWorker {
  constructor(bytes) {
    this._pending = new Map();
    this.worker = new Worker(new URL('./splitter-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        this._pending.get('init')?.resolve(); this._pending.delete('init');
      } else if (data.type === 'result') {
        this._pending.get(data.chunkIdx)?.resolve(data); this._pending.delete(data.chunkIdx);
      } else if (data.type === 'error') {
        const key = data.chunkIdx ?? 'init';
        this._pending.get(key)?.reject(new Error(data.message)); this._pending.delete(key);
      }
    };
    this.worker.onerror = (e) => {
      console.error('[ChunkWorker]', e);
      for (const { reject } of this._pending.values()) reject(new Error(e.message));
      this._pending.clear();
    };
    this.ready = new Promise((resolve, reject) => this._pending.set('init', { resolve, reject }));
    // Copy model bytes for this worker (each needs its own copy for its ORT session)
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    this.worker.postMessage({ type: 'init', modelBytes: copy, numThreads: getNumThreads() }, [copy]);
  }

  process(left, right, originalLen, chunkIdx) {
    return new Promise((resolve, reject) => {
      this._pending.set(chunkIdx, { resolve, reject });
      this.worker.postMessage(
        { type: 'process', chunkIdx, originalLen, leftData: left.buffer, rightData: right.buffer },
        [left.buffer, right.buffer],
      );
    });
  }

  terminate() { this.worker.terminate(); }
}

// ── Model loading ──────────────────────────────────────────────────────────

async function loadModel(url) {
  showProgress('Checking model cache...', 0);

  modelBytes = await getCachedModel(url);

  if (!modelBytes) {
    showProgress('Downloading model...', 0);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download model: ${resp.status} ${resp.statusText}`);

    const total = parseInt(resp.headers.get('content-length') || '0', 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        showProgress(
          `Downloading model... ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`,
          received / total,
        );
      }
    }

    modelBytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { modelBytes.set(chunk, offset); offset += chunk.length; }
    await setCachedModel(url, modelBytes);
  }

  const n = getNumWorkers();
  showProgress(`Initializing ${n} worker${n > 1 ? 's' : ''}…`, 0.95);
  workers = Array.from({ length: n }, () => new ChunkWorker(modelBytes));
  await Promise.all(workers.map(w => w.ready));
  showProgress('Model loaded', 1);
}

// ── Audio processing pipeline ──────────────────────────────────────────────

/**
 * Zero-pad signal to exactly CHUNK_SAMPLES so STFT always produces T=474 frames.
 * The SCNet FeatureConversion uses a fixed DFT matrix built for T=474, so every
 * chunk (including the last, shorter one) must be padded to this length.
 */
function padToChunkSize(signal) {
  if (signal.length === CHUNK_SAMPLES) return signal;
  const out = new Float32Array(CHUNK_SAMPLES);
  out.set(signal);
  return out;
}

/**
 * Distribute chunks across the worker pool, collect results, then merge with crossfade.
 * @param {Float32Array} left - Full left channel
 * @param {Float32Array} right - Full right channel
 * @returns {{ vocalL, vocalR, instrL, instrR: Float32Array, elapsed: number }}
 */
async function processAudio(left, right) {
  const totalSamples = left.length;
  const step = CHUNK_SAMPLES - OVERLAP_SAMPLES;
  const nChunks = Math.ceil((totalSamples - OVERLAP_SAMPLES) / step);

  const vocalL = new Float32Array(totalSamples);
  const vocalR = new Float32Array(totalSamples);
  const instrL = new Float32Array(totalSamples);
  const instrR = new Float32Array(totalSamples);

  const results = new Array(nChunks);
  const queue   = Array.from({ length: nChunks }, (_, i) => i);
  const startTime = Date.now();
  let completed = 0;

  // Each worker pulls from the queue until empty
  await Promise.all(workers.map(async (worker) => {
    while (queue.length > 0) {
      const i = queue.shift();
      const start = i * step;
      const end   = Math.min(start + CHUNK_SAMPLES, totalSamples);

      results[i] = await worker.process(
        padToChunkSize(left.slice(start, end)),
        padToChunkSize(right.slice(start, end)),
        end - start,
        i,
      );

      completed++;
      const elapsed = (Date.now() - startTime) / 1000;
      const eta = completed < nChunks ? (elapsed / completed) * (nChunks - completed) : 0;
      const label = `Processing chunk ${completed} / ${nChunks}`
        + (completed < nChunks ? ` — ${fmt(elapsed)} elapsed, ~${fmt(eta)} remaining` : '');
      showProgress(label, completed / nChunks);
      await tick();
    }
  }));

  // Merge results with crossfade at overlap boundaries
  for (let i = 0; i < nChunks; i++) {
    const start = i * step;
    const end   = Math.min(start + CHUNK_SAMPLES, totalSamples);
    const { vocalL: vL, vocalR: vR, instrL: iL, instrR: iR } = results[i];
    const writeLen = end - start;

    for (let j = 0; j < writeLen; j++) {
      const pos = start + j;
      if (pos >= totalSamples) break;
      if (i > 0 && j < OVERLAP_SAMPLES) {
        const w = j / OVERLAP_SAMPLES;
        vocalL[pos] = vocalL[pos] * (1 - w) + vL[j] * w;
        vocalR[pos] = vocalR[pos] * (1 - w) + vR[j] * w;
        instrL[pos] = instrL[pos] * (1 - w) + iL[j] * w;
        instrR[pos] = instrR[pos] * (1 - w) + iR[j] * w;
      } else {
        vocalL[pos] = vL[j]; vocalR[pos] = vR[j];
        instrL[pos] = iL[j]; instrR[pos] = iR[j];
      }
    }
  }

  return { vocalL, vocalR, instrL, instrR, elapsed: (Date.now() - startTime) / 1000 };
}

// ── File handling ──────────────────────────────────────────────────────────

async function handleFile(file) {
  if (!file || !file.type.startsWith('audio/')) {
    console.error('Invalid file type:', file?.type);
    return;
  }

  el.fileName.textContent = file.name;
  el.results.classList.add('hidden');
  el.progressBar.style.background = '';

  try {
    if (!workers.length) {
      const url = localStorage.getItem('scnet_model_url') || MODEL_URL;
      await loadModel(url);
    }

    showProgress('Decoding audio...', 0);
    await tick();
    const { left, right } = await decodeAudio(await file.arrayBuffer());
    showProgress('Decoding audio...', 1);

    const { vocalL, vocalR, instrL, instrR, elapsed } = await processAudio(left, right);

    showProgress('Encoding output…', 0.95);
    await tick();

    const vocalUrl = URL.createObjectURL(encodeWav(vocalL, vocalR));
    const instrUrl = URL.createObjectURL(encodeWav(instrL, instrR));

    el.vocalPlayer.src = vocalUrl;
    el.instrPlayer.src = instrUrl;
    el.vocalDl.href = vocalUrl;
    el.instrDl.href = instrUrl;

    const baseName = file.name.replace(/\.[^.]+$/, '');
    el.vocalDl.download = `${baseName}_vocals.wav`;
    el.instrDl.download = `${baseName}_instrumental.wav`;

    showCompletion(elapsed);
    el.results.classList.remove('hidden');
  } catch (err) {
    console.error('Processing failed:', err);
    showProgress(`Error: ${err.message}`, 0);
    el.progressBar.style.background = '#f44336';
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

el.dropZone.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
el.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropZone.classList.add('dragover'); });
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

el.modelUrlSave.addEventListener('click', () => {
  const url = el.modelUrl.value.trim();
  if (url) {
    localStorage.setItem('scnet_model_url', url);
    workers = [];  // force reload
    el.modelUrl.value = '';
    el.modelUrl.placeholder = url;
  }
});

el.workerCount.addEventListener('input', () => {
  const n = parseInt(el.workerCount.value, 10);
  el.workerCountVal.textContent = n;
  localStorage.setItem('scnet_num_workers', String(n));
  workers = [];  // reinitialize on next run
});

el.threadCount.addEventListener('input', () => {
  const n = parseInt(el.threadCount.value, 10);
  el.threadCountVal.textContent = n;
  localStorage.setItem('scnet_num_threads', String(n));
  workers = [];  // reinitialize on next run
});

// Init: restore saved settings
const savedUrl = localStorage.getItem('scnet_model_url');
if (savedUrl) el.modelUrl.placeholder = savedUrl;
el.workerCount.value = getNumWorkers();
el.workerCountVal.textContent = getNumWorkers();
el.threadCount.value = getNumThreads();
el.threadCountVal.textContent = getNumThreads();
