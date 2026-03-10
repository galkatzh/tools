/**
 * Audio Splitter — separate vocals from instrumentals using SCNet + ONNX Runtime.
 *
 * Pipeline: Upload → Decode → Chunk → STFT → ONNX inference → iSTFT → Output
 *
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

/** Source indices in model output (drums=0, bass=1, other=2, vocals=3). */
const VOCAL_IDX = 3;

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
};

// ── State ──────────────────────────────────────────────────────────────────

let session = null;  // ONNX InferenceSession

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

function hideProgress() {
  el.progress.classList.add('hidden');
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

// ── Model loading ──────────────────────────────────────────────────────────

async function loadModel(url) {
  showProgress('Checking model cache...', 0);

  let modelBytes = await getCachedModel(url);

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
    for (const chunk of chunks) {
      modelBytes.set(chunk, offset);
      offset += chunk.length;
    }

    await setCachedModel(url, modelBytes);
  }

  showProgress('Loading model into ONNX Runtime...', 0.95);
  session = await ort.InferenceSession.create(modelBytes.buffer, {
    executionProviders: ['wasm'],
  });
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
 * Process a single chunk through the ONNX model.
 * @param {Float32Array} left - Left channel padded to CHUNK_SAMPLES
 * @param {Float32Array} right - Right channel padded to CHUNK_SAMPLES
 * @param {number} originalLen - True length before padding (for iSTFT trimming)
 * @returns {{ vocalL, vocalR, instrL, instrR: Float32Array }}
 */
async function processChunk(left, right, originalLen) {
  const chunkLen = originalLen;
  const { data, nFrames } = stft(left, right);

  // Create ONNX tensor: shape [1, 4, F=2049, T=nFrames]
  const inputTensor = new ort.Tensor('float32', data, [1, 4, N_FREQ, nFrames]);
  const results = await session.run({ spectrogram: inputTensor });
  const output = results.sources;

  // Output shape: [1, 4, 4, F, T] = [B, S=4, C=4, F=2049, T]
  const S = 4;          // drums, bass, other, vocals
  const sourceStride = 4 * N_FREQ * nFrames;

  // Extract vocals
  const vocalData = output.data.slice(VOCAL_IDX * sourceStride, (VOCAL_IDX + 1) * sourceStride);
  const vocal = istft(new Float32Array(vocalData), nFrames, chunkLen);

  // Sum drums + bass + other for instrumental
  const instrData = new Float32Array(sourceStride);
  for (let s = 0; s < S; s++) {
    if (s === VOCAL_IDX) continue;
    const srcOffset = s * sourceStride;
    for (let i = 0; i < sourceStride; i++) {
      instrData[i] += output.data[srcOffset + i];
    }
  }
  const instr = istft(instrData, nFrames, chunkLen);

  return {
    vocalL: vocal.left, vocalR: vocal.right,
    instrL: instr.left, instrR: instr.right,
  };
}

/**
 * Split audio into chunks with overlap, process each, and crossfade.
 * @param {Float32Array} left - Full left channel
 * @param {Float32Array} right - Full right channel
 */
async function processAudio(left, right) {
  const totalSamples = left.length;
  const step = CHUNK_SAMPLES - OVERLAP_SAMPLES;
  const nChunks = Math.ceil((totalSamples - OVERLAP_SAMPLES) / step);

  // Output buffers
  const vocalL = new Float32Array(totalSamples);
  const vocalR = new Float32Array(totalSamples);
  const instrL = new Float32Array(totalSamples);
  const instrR = new Float32Array(totalSamples);

  const startTime = Date.now();

  for (let i = 0; i < nChunks; i++) {
    const start = i * step;
    const end = Math.min(start + CHUNK_SAMPLES, totalSamples);
    const chunkL = left.slice(start, end);
    const chunkR = right.slice(start, end);

    // Build progress label: show ETA once first chunk completes
    let label = `Processing chunk ${i + 1} / ${nChunks}`;
    if (i > 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const eta = (elapsed / i) * (nChunks - i);
      label += ` — ${fmt(elapsed)} elapsed, ~${fmt(eta)} remaining`;
    }
    showProgress(label, i / nChunks);
    await tick();

    const result = await processChunk(
      padToChunkSize(chunkL),
      padToChunkSize(chunkR),
      end - start,
    );

    // Crossfade in the overlap region
    const writeLen = end - start;
    for (let j = 0; j < writeLen; j++) {
      const pos = start + j;
      if (pos >= totalSamples) break;

      // Crossfade weight: ramp down previous chunk, ramp up new chunk in overlap
      let weight = 1;
      if (i > 0 && j < OVERLAP_SAMPLES) {
        weight = j / OVERLAP_SAMPLES;
      }

      if (i > 0 && j < OVERLAP_SAMPLES) {
        // Blend with previous chunk's tail
        vocalL[pos] = vocalL[pos] * (1 - weight) + result.vocalL[j] * weight;
        vocalR[pos] = vocalR[pos] * (1 - weight) + result.vocalR[j] * weight;
        instrL[pos] = instrL[pos] * (1 - weight) + result.instrL[j] * weight;
        instrR[pos] = instrR[pos] * (1 - weight) + result.instrR[j] * weight;
      } else {
        vocalL[pos] = result.vocalL[j];
        vocalR[pos] = result.vocalR[j];
        instrL[pos] = result.instrL[j];
        instrR[pos] = result.instrR[j];
      }
    }
  }

  return { vocalL, vocalR, instrL, instrR };
}

// ── File handling ──────────────────────────────────────────────────────────

async function handleFile(file) {
  if (!file || !file.type.startsWith('audio/')) {
    console.error('Invalid file type:', file?.type);
    return;
  }

  el.fileName.textContent = file.name;
  el.results.classList.add('hidden');

  try {
    // Load model if not already loaded
    if (!session) {
      const url = localStorage.getItem('scnet_model_url') || MODEL_URL;
      await loadModel(url);
    }

    // Decode audio
    showProgress('Decoding audio...', 0);
    await tick();
    const buffer = await file.arrayBuffer();
    const { left, right } = await decodeAudio(buffer);
    showProgress('Decoding audio...', 1);

    // Process
    const { vocalL, vocalR, instrL, instrR } = await processAudio(left, right);
    showProgress('Encoding output...', 0.95);
    await tick();

    // Encode to WAV
    const vocalBlob = encodeWav(vocalL, vocalR);
    const instrBlob = encodeWav(instrL, instrR);

    // Display results
    const vocalUrl = URL.createObjectURL(vocalBlob);
    const instrUrl = URL.createObjectURL(instrBlob);

    el.vocalPlayer.src = vocalUrl;
    el.instrPlayer.src = instrUrl;
    el.vocalDl.href = vocalUrl;
    el.instrDl.href = instrUrl;

    const baseName = file.name.replace(/\.[^.]+$/, '');
    el.vocalDl.download = `${baseName}_vocals.wav`;
    el.instrDl.download = `${baseName}_instrumental.wav`;

    hideProgress();
    el.results.classList.remove('hidden');
  } catch (err) {
    console.error('Processing failed:', err);
    showProgress(`Error: ${err.message}`, 0);
    el.progressBar.style.background = '#f44336';
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

el.dropZone.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

el.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropZone.classList.add('dragover');
});

el.dropZone.addEventListener('dragleave', () => {
  el.dropZone.classList.remove('dragover');
});

el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// Model URL configuration
el.modelUrlSave.addEventListener('click', () => {
  const url = el.modelUrl.value.trim();
  if (url) {
    localStorage.setItem('scnet_model_url', url);
    session = null; // Force reload
    el.modelUrl.value = '';
    el.modelUrl.placeholder = url;
  }
});

// Init: show saved model URL if any
const savedUrl = localStorage.getItem('scnet_model_url');
if (savedUrl) {
  el.modelUrl.placeholder = savedUrl;
}
