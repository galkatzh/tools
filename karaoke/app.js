/**
 * Karaoke App — upload a song, split stems, transcribe lyrics, sing along.
 *
 * Pipeline: Upload → Decode (44.1 kHz stereo)
 *         → Stem Split (Spleeter 2-stems ONNX: vocal + instrumental)
 *         → Resample vocals (16 kHz mono) → Transcribe (word timestamps)
 *         → Play instrumental + synced lyrics display
 *
 * Workers:
 *   ./spleeter-worker.js                  — Spleeter ONNX stem separation
 *   ../local-transcribe/transcribe-worker.js — Whisper ASR via Transformers.js
 */

import { SAMPLE_RATE, decodeAudio } from '../audio-splitter/audio-processor.js';

// ── Configuration ──────────────────────────────────────────────────────────

const MODEL_VOCALS_URL = 'https://huggingface.co/bgkb/spleeteronnx/resolve/main/vocals.fp16.onnx';
const MODEL_ACCOMP_URL = 'https://huggingface.co/bgkb/spleeteronnx/resolve/main/accompaniment.fp16.onnx';
const WHISPER_MODEL = {
  repo: 'onnx-community/whisper-base',
  apiType: 'pipeline',
  dtype: 'fp32',
  device: 'webgpu',
};

/** 512 STFT frames (Spleeter block size) × hop 1024 + fft 4096 ≈ 12s */
const CHUNK_SAMPLES = 511 * 1024 + 4096; // 527360
const OVERLAP_SAMPLES = 1 * SAMPLE_RATE;
const WHISPER_CHUNK_SECONDS = 30;
const WHISPER_SAMPLE_RATE = 16000;

// ── DOM ────────────────────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);
const el = {
  dropZone: $('#drop-zone'),
  fileInput: $('#file-input'),
  fileName: $('#file-name'),
  progress: $('#progress'),
  progressBar: $('#progress-bar'),
  progressText: $('#progress-text'),
  player: $('#player'),
  lyrics: $('#lyrics'),
  playBtn: $('#play-btn'),
  iconPlay: $('#icon-play'),
  iconPause: $('#icon-pause'),
  seek: $('#seek'),
  timeCurrent: $('#time-current'),
  timeTotal: $('#time-total'),
  vocalVolume: $('#vocal-volume'),
  recordBtn: $('#record-btn'),
  iconRecord: $('#icon-record'),
  iconRecordStop: $('#icon-record-stop'),
  mixVocal: $('#mix-vocal'),
  fxReverb: $('#fx-reverb'),
  fxReverbDecay: $('#fx-reverb-decay'),
  fxDelay: $('#fx-delay'),
  fxDelayTime: $('#fx-delay-time'),
  fxDelayFb: $('#fx-delay-fb'),
  fxChorus: $('#fx-chorus'),
  fxPanel: $('#fx-panel'),
  previewBtn: $('#preview-btn'),
  iconPreviewPlay: $('#icon-preview-play'),
  iconPreviewStop: $('#icon-preview-stop'),
  exportRecording: $('#export-recording'),
  exportLrc: $('#export-lrc'),
  exportAss: $('#export-ass'),
  settingsToggle: $('#settings-toggle'),
  settings: $('#settings'),
  splitWorkers: $('#split-workers'),
  transcribeWorkers: $('#transcribe-workers'),
  language: $('#language'),
  fontSize: $('#font-size'),
  fontSizeVal: $('#font-size-val'),
  highlightColor: $('#highlight-color'),
};

// ── State ──────────────────────────────────────────────────────────────────

let audioCtx = null;
let instrSource = null;
let vocalSource = null;
let instrGain = null;          // GainNode for instrumental
let vocalGain = null;          // GainNode for vocals
let instrumentalBuffer = null; // AudioBuffer for playback
let vocalBuffer = null;        // AudioBuffer for vocal mix
let words = [];                // [{ text, start, end }]
let playing = false;
let startedAt = 0;             // audioCtx.currentTime when playback started
let pausedAt = 0;              // offset in seconds when paused
let animFrameId = null;
let songBaseName = 'karaoke';       // filename stem for exports

// Recording state
let recording = false;
let micStream = null;              // MediaStream from getUserMedia
let micWorklet = null;             // AudioWorkletNode for raw PCM capture
let micSource = null;              // MediaStreamAudioSourceNode
let micSamples = [];               // captured Float32Array chunks
let recordingStartOffset = 0;      // playback offset when recording began
let recordingMic = null;           // finished recording: { mono, sampleRate, offset, duration }
let workletReady = false;          // AudioWorklet module registered

// Preview state
let previewing = false;
let previewCtx = null;             // separate AudioContext for preview
let previewInstrSource = null;
let previewMicSource = null;
let previewFx = null;
let previewMicGain = null;
let previewStartedAt = 0;
let previewAnimId = null;

// ── Progress helpers ───────────────────────────────────────────────────────

function showProgress(text, fraction) {
  el.progress.classList.remove('hidden');
  el.player.classList.add('hidden');
  el.progressText.textContent = text;
  el.progressBar.style.width = `${Math.round(fraction * 100)}%`;
  el.progressBar.style.background = '';
}

function showError(msg) {
  el.progressText.textContent = msg;
  el.progressBar.style.width = '100%';
  el.progressBar.style.background = '#f44336';
}

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function tick() { return new Promise((r) => setTimeout(r, 0)); }

// ── IndexedDB model cache (same pattern as audio-splitter) ─────────────────

const DB_NAME = 'karaoke-cache';
const STORE_NAME = 'models';

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

// ── Splitter worker pool (Spleeter 2-stems) ──────────────────────────────

class ChunkWorker {
  constructor(vocalsBytes, accompBytes) {
    this._pending = new Map();
    this.worker = new Worker(new URL('./spleeter-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        this._pending.get('init')?.resolve();
        this._pending.delete('init');
      } else if (data.type === 'result') {
        this._pending.get(data.chunkIdx)?.resolve(data);
        this._pending.delete(data.chunkIdx);
      } else if (data.type === 'error') {
        const key = data.chunkIdx ?? 'init';
        this._pending.get(key)?.reject(new Error(data.message));
        this._pending.delete(key);
      }
    };
    this.worker.onerror = (e) => {
      console.error('[ChunkWorker]', e);
      for (const { reject } of this._pending.values()) reject(new Error(e.message));
      this._pending.clear();
    };
    this.ready = new Promise((resolve, reject) => this._pending.set('init', { resolve, reject }));
    const vCopy = new ArrayBuffer(vocalsBytes.byteLength);
    new Uint8Array(vCopy).set(vocalsBytes);
    const aCopy = new ArrayBuffer(accompBytes.byteLength);
    new Uint8Array(aCopy).set(accompBytes);
    this.worker.postMessage({ type: 'init', vocalsBytes: vCopy, accompBytes: aCopy }, [vCopy, aCopy]);
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

// ── Stem separation ────────────────────────────────────────────────────────

/** Download a single model file with streaming progress, caching in IndexedDB. */
async function fetchModel(url, label) {
  let bytes = await getCachedModel(url);
  if (bytes) return bytes;

  showProgress(`Downloading ${label}...`, 0);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Model download failed: ${resp.status}`);
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
        `Downloading ${label}... ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`,
        received / total,
      );
    }
  }
  bytes = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  await setCachedModel(url, bytes);
  return bytes;
}

/** Load both Spleeter ONNX models, using IndexedDB cache when available. */
async function loadSplitterModel() {
  const vocalsBytes = await fetchModel(MODEL_VOCALS_URL, 'vocals model');
  const accompBytes = await fetchModel(MODEL_ACCOMP_URL, 'accompaniment model');
  return { vocalsBytes, accompBytes };
}

function padToChunkSize(signal) {
  if (signal.length === CHUNK_SAMPLES) return signal;
  const out = new Float32Array(CHUNK_SAMPLES);
  out.set(signal);
  return out;
}

/**
 * Split stereo audio into vocals + instrumental using Spleeter workers.
 * Returns Float32Arrays for each channel of each stem.
 */
async function splitStems(left, right) {
  const { vocalsBytes, accompBytes } = await loadSplitterModel();

  const numWorkers = parseInt(el.splitWorkers.value, 10) || 2;
  showProgress(`Initializing ${numWorkers} stem-split workers...`, 0);
  const workers = Array.from({ length: numWorkers }, () => new ChunkWorker(vocalsBytes, accompBytes));
  await Promise.all(workers.map(w => w.ready));

  const totalSamples = left.length;
  const step = CHUNK_SAMPLES - OVERLAP_SAMPLES;
  const nChunks = Math.ceil((totalSamples - OVERLAP_SAMPLES) / step);

  const vocalL = new Float32Array(totalSamples);
  const vocalR = new Float32Array(totalSamples);
  const instrL = new Float32Array(totalSamples);
  const instrR = new Float32Array(totalSamples);

  const results = new Array(nChunks);
  const queue = Array.from({ length: nChunks }, (_, i) => i);
  let completed = 0;

  await Promise.all(workers.map(async (worker) => {
    while (queue.length > 0) {
      const i = queue.shift();
      const start = i * step;
      const end = Math.min(start + CHUNK_SAMPLES, totalSamples);
      results[i] = await worker.process(
        padToChunkSize(left.slice(start, end)),
        padToChunkSize(right.slice(start, end)),
        end - start, i,
      );
      completed++;
      showProgress(`Splitting stems... chunk ${completed}/${nChunks}`, completed / nChunks);
      await tick();
    }
  }));

  // Crossfade merge
  for (let i = 0; i < nChunks; i++) {
    const start = i * step;
    const end = Math.min(start + CHUNK_SAMPLES, totalSamples);
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

  workers.forEach(w => w.terminate());
  return { vocalL, vocalR, instrL, instrR };
}

// ── Resample vocals to 16 kHz mono for Whisper ─────────────────────────────

async function resampleToMono16k(left, right) {
  const numSamples = left.length;
  const duration = numSamples / SAMPLE_RATE;
  const outSamples = Math.round(duration * WHISPER_SAMPLE_RATE);

  const offCtx = new OfflineAudioContext(1, outSamples, WHISPER_SAMPLE_RATE);
  const buf = offCtx.createBuffer(2, numSamples, SAMPLE_RATE);
  buf.getChannelData(0).set(left);
  buf.getChannelData(1).set(right);

  const src = offCtx.createBufferSource();
  src.buffer = buf;
  src.connect(offCtx.destination);
  src.start();

  const rendered = await offCtx.startRendering();
  return rendered.getChannelData(0);
}

// ── Transcription (parallel worker pool) ────────────────────────────────────

/**
 * Wrapper for a transcribe worker — handles init, ready, and one-chunk-at-a-time
 * processing via a queue so each worker stays busy.
 */
class TranscribeWorker {
  constructor() {
    this.worker = new Worker(
      new URL('../local-transcribe/transcribe-worker.js', import.meta.url),
      { type: 'module' },
    );
    this._resolve = null;
    this._reject = null;
    this.ready = new Promise((resolve, reject) => {
      this._initResolve = resolve;
      this._initReject = reject;
    });
    this.worker.onmessage = ({ data }) => this._onMessage(data);
    this.worker.onerror = (e) => {
      console.error('[TranscribeWorker]', e);
      (this._reject || this._initReject)?.(new Error(e.message));
    };
    this.worker.postMessage({ type: 'init', model: WHISPER_MODEL });
  }

  _onMessage(data) {
    if (data.type === 'load-progress') {
      // Only report model-loading progress from the first worker
      const pct = data.progress != null ? data.progress : 0;
      showProgress(`Loading transcription model... ${Math.round(pct)}%`, pct / 100);
    } else if (data.type === 'ready') {
      this._initResolve();
    } else if (data.type === 'result') {
      this._resolve?.(data);
    } else if (data.type === 'error') {
      console.error('[TranscribeWorker]', data.message);
      this._reject?.(new Error(data.message));
    }
  }

  /**
   * Send one chunk and wait for its result.
   * Uses segment-level timestamps (no cross-attention outputs needed),
   * then splits phrases into words with character-proportional timing.
   */
  transcribe(chunkIdx, audioChunk, language) {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      const buf = audioChunk.buffer.slice(
        audioChunk.byteOffset,
        audioChunk.byteOffset + audioChunk.byteLength,
      );
      const msg = { type: 'transcribe', chunkIdx, audio: buf, returnTimestamps: true };
      if (language) msg.language = language;
      this.worker.postMessage(msg, [buf]);
    });
  }

  terminate() { this.worker.terminate(); }
}

/**
 * Split a transcribed segment into individual words with
 * character-proportional timestamp interpolation.
 * Longer words get proportionally more time than shorter ones.
 */
function splitSegmentToWords(text, segStart, segEnd) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const totalChars = tokens.reduce((sum, t) => sum + t.length, 0);
  const duration = segEnd - segStart;
  const words = [];
  let cursor = segStart;

  for (let i = 0; i < tokens.length; i++) {
    const frac = tokens[i].length / totalChars;
    const wordDur = i < tokens.length - 1 ? frac * duration : segEnd - cursor;
    words.push({ text: tokens[i], start: cursor, end: cursor + wordDur });
    cursor += wordDur;
  }
  return words;
}

/**
 * Transcribe audio using a pool of parallel Whisper workers.
 * Each worker loads its own model copy (browser caches the download).
 * Chunks are distributed via a shared queue, results sorted by time.
 */
async function transcribeVocals(mono16k) {
  const numWorkers = parseInt(el.transcribeWorkers.value, 10) || 2;
  const language = el.language.value || null;
  showProgress('Loading transcription model...', 0);

  const workers = Array.from({ length: numWorkers }, () => new TranscribeWorker());
  await Promise.all(workers.map((w) => w.ready));

  const chunkSize = WHISPER_CHUNK_SECONDS * WHISPER_SAMPLE_RATE;
  const nChunks = Math.ceil(mono16k.length / chunkSize);
  const results = new Array(nChunks);
  const queue = Array.from({ length: nChunks }, (_, i) => i);
  let completed = 0;

  showProgress('Transcribing lyrics...', 0);

  // Each worker pulls from the shared queue until empty
  await Promise.all(workers.map(async (worker) => {
    while (queue.length > 0) {
      const i = queue.shift();
      const start = i * chunkSize;
      const chunk = mono16k.slice(start, start + chunkSize);
      results[i] = await worker.transcribe(i, chunk, language);
      completed++;
      showProgress(`Transcribing lyrics... ${completed}/${nChunks}`, completed / nChunks);
      await tick();
    }
  }));

  workers.forEach((w) => w.terminate());

  // Merge results: split segment-level timestamps into word-level
  const allWords = [];
  for (let i = 0; i < nChunks; i++) {
    const chunkOffset = i * WHISPER_CHUNK_SECONDS;
    for (const seg of results[i].result?.chunks || []) {
      const segStart = (seg.timestamp?.[0] ?? 0) + chunkOffset;
      const segEnd = (seg.timestamp?.[1] ?? segStart) + chunkOffset;
      const segWords = splitSegmentToWords(seg.text, segStart, segEnd);
      allWords.push(...segWords);
    }
  }

  return allWords;
}

// ── Lyrics rendering ───────────────────────────────────────────────────────

/**
 * Group words into lines based on pauses (> 1s gap) or ~8 words per line.
 */
function buildLyricLines(wordList) {
  const lines = [];
  let currentLine = [];

  for (let i = 0; i < wordList.length; i++) {
    currentLine.push(wordList[i]);
    const gap = i < wordList.length - 1 ? wordList[i + 1].start - wordList[i].end : Infinity;
    if (currentLine.length >= 8 || gap > 1.0) {
      lines.push(currentLine);
      currentLine = [];
    }
  }
  if (currentLine.length) lines.push(currentLine);
  return lines;
}

/** Render lyrics into the DOM — one div per line, no per-word spans. */
function renderLyrics(lines) {
  el.lyrics.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'lyric-line future';
    div.dataset.start = line[0].start;
    div.dataset.end = line[line.length - 1].end;
    div.textContent = line.map((w) => w.text).join(' ');
    el.lyrics.appendChild(div);
  }
}

// ── Playback ───────────────────────────────────────────────────────────────

function initAudioContext() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
  instrGain = audioCtx.createGain();
  instrGain.connect(audioCtx.destination);
  vocalGain = audioCtx.createGain();
  vocalGain.gain.value = 0;
  vocalGain.connect(audioCtx.destination);
}

function play(offset = 0) {
  if (previewing) stopPreview();
  initAudioContext();
  if (instrSource) { instrSource.stop(); instrSource.disconnect(); }
  if (vocalSource) { vocalSource.stop(); vocalSource.disconnect(); }

  instrSource = audioCtx.createBufferSource();
  instrSource.buffer = instrumentalBuffer;
  instrSource.connect(instrGain);
  instrSource.start(0, offset);
  instrSource.onended = () => { if (playing) stop(); };

  if (vocalBuffer) {
    vocalSource = audioCtx.createBufferSource();
    vocalSource.buffer = vocalBuffer;
    vocalSource.connect(vocalGain);
    vocalSource.start(0, offset);
  }

  startedAt = audioCtx.currentTime - offset;
  playing = true;
  el.iconPlay.classList.add('hidden');
  el.iconPause.classList.remove('hidden');
  animFrameId = requestAnimationFrame(updateLoop);
}

function pause() {
  if (!playing) return;
  pausedAt = audioCtx.currentTime - startedAt;
  if (instrSource) { instrSource.stop(); instrSource.disconnect(); instrSource = null; }
  if (vocalSource) { vocalSource.stop(); vocalSource.disconnect(); vocalSource = null; }
  playing = false;
  el.iconPlay.classList.remove('hidden');
  el.iconPause.classList.add('hidden');
  cancelAnimationFrame(animFrameId);
}

function stop() {
  if (recording) stopRecording();
  else pause();
  pausedAt = 0;
  updateUI(0);
}

function seekTo(time) {
  const wasPlaying = playing;
  if (playing) {
    if (instrSource) { instrSource.stop(); instrSource.disconnect(); instrSource = null; }
    if (vocalSource) { vocalSource.stop(); vocalSource.disconnect(); vocalSource = null; }
    playing = false;
  }
  pausedAt = time;
  if (wasPlaying) play(time);
  else updateUI(time);
}

function getCurrentTime() {
  if (playing) return audioCtx.currentTime - startedAt;
  return pausedAt;
}

// ── Vocal effects ────────────────────────────────────────────────────────────

/**
 * Generate a synthetic reverb impulse response.
 * @param {BaseAudioContext} ctx
 * @param {number} decay - reverb decay time in seconds (controls IR length + envelope)
 */
function createReverbIR(ctx, decay = 2.5) {
  const len = Math.round(ctx.sampleRate * decay);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
  }
  return buf;
}

/**
 * Build an effects chain on a given AudioContext.
 * Returns { input, output } plus exposed nodes for live parameter updates.
 *
 * Graph:  input → dry ──────────────────────────────→ merger → output
 *           ├──→ convolver → reverbGain ────────────→ merger
 *           ├──→ delayNode → feedback → delayWet ──→ merger
 *           └──→ chorusDelays + LFO → chorusWet ───→ merger
 */
function buildEffectsChain(ctx, {
  reverb = 0, reverbDecay = 2.5,
  delay = 0, delayTime = 0.3, delayFb = 0.4,
  chorus = 0,
} = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // Dry path
  input.connect(output);

  // ── Reverb ──
  const convolver = ctx.createConvolver();
  convolver.buffer = createReverbIR(ctx, reverbDecay);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = reverb;
  input.connect(convolver);
  convolver.connect(reverbGain);
  reverbGain.connect(output);

  // ── Delay (feedback echo) ──
  const delayNode = ctx.createDelay(1.0);
  delayNode.delayTime.value = delayTime;
  const feedbackGain = ctx.createGain();
  feedbackGain.gain.value = delayFb;
  const delayWet = ctx.createGain();
  delayWet.gain.value = delay;
  input.connect(delayNode);
  delayNode.connect(feedbackGain);
  feedbackGain.connect(delayNode);
  delayNode.connect(delayWet);
  delayWet.connect(output);

  // ── Chorus ──
  const chorusWet = ctx.createGain();
  chorusWet.gain.value = chorus * 0.5;

  const chorusDelay1 = ctx.createDelay(0.05);
  chorusDelay1.delayTime.value = 0.025;
  const chorusDelay2 = ctx.createDelay(0.05);
  chorusDelay2.delayTime.value = 0.035;

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 1.5;
  const lfoGain1 = ctx.createGain();
  lfoGain1.gain.value = 0.005;
  const lfoGain2 = ctx.createGain();
  lfoGain2.gain.value = 0.005;
  lfo.connect(lfoGain1);
  lfo.connect(lfoGain2);
  lfoGain1.connect(chorusDelay1.delayTime);
  lfoGain2.connect(chorusDelay2.delayTime);
  lfo.start(0);

  input.connect(chorusDelay1);
  input.connect(chorusDelay2);
  chorusDelay1.connect(chorusWet);
  chorusDelay2.connect(chorusWet);
  chorusWet.connect(output);

  return {
    input, output,
    reverbGain, delayWet, feedbackGain, delayNode, chorusWet,
    convolver, // exposed so we can rebuild IR on decay change
  };
}

/** Read all effect parameters from the UI sliders. */
function getEffectParams() {
  return {
    reverb: parseFloat(el.fxReverb.value),
    reverbDecay: parseFloat(el.fxReverbDecay.value),
    delay: parseFloat(el.fxDelay.value),
    delayTime: parseFloat(el.fxDelayTime.value),
    delayFb: parseFloat(el.fxDelayFb.value),
    chorus: parseFloat(el.fxChorus.value),
  };
}

// ── Recording: raw PCM mic capture via AudioWorklet + WAV mixdown ────────────

/** Inline AudioWorklet processor: copies input samples to the main thread. */
const PCM_WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

/** Register the worklet module once (uses a Blob URL, no extra file). */
async function ensureWorklet() {
  if (workletReady) return;
  const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await audioCtx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  workletReady = true;
}

/**
 * Start recording: captures raw PCM mic samples via AudioWorkletNode.
 * Mic is NOT routed to speakers (avoids feedback). On stop, an offline
 * render mixes instrumental + mic into a lossless WAV.
 */
async function startRecording() {
  if (previewing) stopPreview();
  initAudioContext();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error('Microphone access denied:', err);
    return;
  }

  await ensureWorklet();

  micSamples = [];
  recordingMic = null;
  el.exportRecording.classList.add('hidden');
  el.previewBtn.classList.add('hidden');
  el.fxPanel.classList.add('hidden');

  micSource = audioCtx.createMediaStreamSource(micStream);
  micWorklet = new AudioWorkletNode(audioCtx, 'pcm-capture');
  micWorklet.port.onmessage = (e) => micSamples.push(e.data);

  // Dry capture: mic → worklet → nowhere (effects applied post-recording)
  micSource.connect(micWorklet);

  recordingStartOffset = pausedAt;
  recording = true;
  el.iconRecord.classList.add('hidden');
  el.iconRecordStop.classList.remove('hidden');
  el.recordBtn.classList.add('recording');

  play(pausedAt);
}

async function stopRecording() {
  if (!recording) return;

  const recEnd = getCurrentTime();

  // Tear down mic capture
  micWorklet.port.onmessage = null;
  micWorklet.disconnect();
  micWorklet = null;
  micSource.disconnect();
  micSource = null;
  micStream.getTracks().forEach((t) => t.stop());
  micStream = null;

  recording = false;
  el.iconRecord.classList.remove('hidden');
  el.iconRecordStop.classList.add('hidden');
  el.recordBtn.classList.remove('recording');

  pause();

  // Concatenate captured mic chunks into a single buffer
  const totalLen = micSamples.reduce((n, c) => n + c.length, 0);
  const micMono = new Float32Array(totalLen);
  let off = 0;
  for (const chunk of micSamples) { micMono.set(chunk, off); off += chunk.length; }
  micSamples = [];

  const duration = recEnd - recordingStartOffset;
  if (duration <= 0) return;

  // Store raw mic data — effects + mix are applied on preview/export
  recordingMic = {
    mono: micMono,
    sampleRate: audioCtx.sampleRate,
    offset: recordingStartOffset,
    duration,
  };
  el.fxPanel.classList.remove('hidden');
  el.previewBtn.classList.remove('hidden');
  el.exportRecording.classList.remove('hidden');
}

// ── Preview: replay recording with effects + mix through speakers ────────

function startPreview() {
  if (!recordingMic) return;
  if (playing) pause();

  const params = getEffectParams();
  const vocalLevel = parseFloat(el.mixVocal.value);
  const { mono, sampleRate: micRate, offset, duration } = recordingMic;

  // Use main audioCtx for realtime preview
  initAudioContext();

  // Instrumental from recording offset
  previewInstrSource = audioCtx.createBufferSource();
  previewInstrSource.buffer = instrumentalBuffer;
  previewInstrSource.connect(audioCtx.destination);

  // Mic through effects chain → gain → destination
  const micBuf = audioCtx.createBuffer(1, mono.length, micRate);
  micBuf.getChannelData(0).set(mono);
  previewMicSource = audioCtx.createBufferSource();
  previewMicSource.buffer = micBuf;

  previewFx = buildEffectsChain(audioCtx, params);
  previewMicGain = audioCtx.createGain();
  previewMicGain.gain.value = vocalLevel;

  previewMicSource.connect(previewFx.input);
  previewFx.output.connect(previewMicGain);
  previewMicGain.connect(audioCtx.destination);

  previewInstrSource.start(0, offset, duration);
  previewMicSource.start(0);
  previewStartedAt = audioCtx.currentTime;
  previewing = true;

  el.iconPreviewPlay.classList.add('hidden');
  el.iconPreviewStop.classList.remove('hidden');

  previewInstrSource.onended = () => { if (previewing) stopPreview(); };
  previewAnimId = requestAnimationFrame(previewLoop);
}

function stopPreview() {
  if (!previewing) return;
  previewing = false;

  try { previewInstrSource?.stop(); } catch (_) { /* already stopped */ }
  try { previewMicSource?.stop(); } catch (_) { /* already stopped */ }
  previewInstrSource?.disconnect();
  previewMicSource?.disconnect();
  previewFx?.input.disconnect();
  previewFx?.output.disconnect();
  previewMicGain?.disconnect();

  previewInstrSource = null;
  previewMicSource = null;
  previewFx = null;
  previewMicGain = null;

  cancelAnimationFrame(previewAnimId);
  el.iconPreviewPlay.classList.remove('hidden');
  el.iconPreviewStop.classList.add('hidden');
}

/** Animation loop during preview: updates seek bar and lyrics. */
function previewLoop() {
  if (!previewing) return;
  const elapsed = audioCtx.currentTime - previewStartedAt;
  const songTime = recordingMic.offset + elapsed;
  updateUI(songTime);
  previewAnimId = requestAnimationFrame(previewLoop);
}

/**
 * Render instrumental + recorded vocals with effects into a WAV blob.
 * Uses OfflineAudioContext for lossless offline rendering.
 */
async function renderRecordingWAV() {
  const params = getEffectParams();
  const vocalLevel = parseFloat(el.mixVocal.value);
  const { mono, sampleRate: micRate, offset, duration } = recordingMic;
  const sampleRate = instrumentalBuffer.sampleRate;

  // Add tail for reverb/delay decay
  const tailSeconds = Math.max(params.reverbDecay, params.delayTime * 4);
  const renderLen = Math.round((duration + tailSeconds) * sampleRate);

  const offCtx = new OfflineAudioContext(2, renderLen, sampleRate);

  // Instrumental
  const instrSrc = offCtx.createBufferSource();
  instrSrc.buffer = instrumentalBuffer;
  instrSrc.connect(offCtx.destination);
  instrSrc.start(0, offset, duration);

  // Mic → effects → gain → destination
  const micBuf = offCtx.createBuffer(1, mono.length, micRate);
  micBuf.getChannelData(0).set(mono);
  const micSrc = offCtx.createBufferSource();
  micSrc.buffer = micBuf;

  const fx = buildEffectsChain(offCtx, params);
  const micGain = offCtx.createGain();
  micGain.gain.value = vocalLevel;

  micSrc.connect(fx.input);
  fx.output.connect(micGain);
  micGain.connect(offCtx.destination);
  micSrc.start(0);

  const rendered = await offCtx.startRendering();
  return encodeWAV(rendered);
}

/** Encode an AudioBuffer as a 16-bit PCM WAV Blob. */
function encodeWAV(buffer) {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numCh * bytesPerSample;
  const numFrames = buffer.length;
  const dataSize = numFrames * blockAlign;

  const headerSize = 44;
  const out = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(out);

  // Helper to write ASCII
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);           // fmt chunk size
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels and convert float → int16
  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));

  let offset = headerSize;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

// ── Animation loop: sync lyrics + seek bar ─────────────────────────────────

function updateLoop() {
  if (!playing) return;
  updateUI(getCurrentTime());
  animFrameId = requestAnimationFrame(updateLoop);
}

function updateUI(time) {
  const duration = instrumentalBuffer.duration;
  el.timeCurrent.textContent = fmt(time);
  el.seek.value = Math.round((time / duration) * 1000);

  // Update line highlights (whole-line, no per-word tracking)
  const lineEls = el.lyrics.querySelectorAll('.lyric-line');
  let activeLineEl = null;

  for (const lineEl of lineEls) {
    const ls = parseFloat(lineEl.dataset.start);
    const le = parseFloat(lineEl.dataset.end);

    if (time >= le) {
      lineEl.className = 'lyric-line past';
    } else if (time < ls) {
      lineEl.className = 'lyric-line future';
    } else {
      lineEl.className = 'lyric-line active';
      activeLineEl = lineEl;
    }
  }

  if (activeLineEl) {
    activeLineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ── Export: LRC & ASS serializers ────────────────────────────────────────

/** Format seconds as mm:ss.xx for Enhanced LRC. */
function lrcTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}

/** Format seconds as h:mm:ss.cc for ASS. */
function assTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}

/**
 * Serialize word timestamps to Enhanced LRC format.
 * Each line uses inline <mm:ss.xx> tags for word-level timing.
 */
function buildLRC(wordList) {
  const lines = buildLyricLines(wordList);
  return lines.map((line) => {
    const lineTag = `[${lrcTime(line[0].start)}]`;
    const wordTags = line
      .map((w) => `<${lrcTime(w.start)}>${w.text.trim()}`)
      .join(' ');
    return `${lineTag}${wordTags}`;
  }).join('\n');
}

/**
 * Serialize word timestamps to ASS (Advanced SubStation Alpha) with \k karaoke tags.
 * Each line becomes a Dialogue event; word durations are expressed in centiseconds.
 */
function buildASS(wordList) {
  const header =
`[Script Info]
Title: Karaoke Export
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000045E9,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,1,2,30,30,40,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;

  const lines = buildLyricLines(wordList);
  const dialogues = lines.map((line) => {
    const start = assTime(line[0].start);
    const end = assTime(line[line.length - 1].end);
    const text = line.map((w) => {
      const dur = Math.round((w.end - w.start) * 100); // centiseconds
      return `{\\kf${dur}}${w.text.trim()}`;
    }).join(' ');
    return `Dialogue: 0,${start},${end},Default,,0,0,0,karaoke,${text}`;
  });

  return header + '\n' + dialogues.join('\n') + '\n';
}

/** Trigger a file download from a string. */
function downloadText(content, filename, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main pipeline ──────────────────────────────────────────────────────────

async function handleFile(file) {
  const validType = file && (file.type.startsWith('audio/') || file.type === 'video/mp4' || file.type === 'video/webm');
  if (!validType) {
    console.error('Invalid file type:', file?.type);
    return;
  }

  el.fileName.textContent = file.name;
  songBaseName = file.name.replace(/\.[^.]+$/, '');
  el.player.classList.add('hidden');
  playing = false;
  pausedAt = 0;
  cancelAnimationFrame(animFrameId);

  try {
    // 1. Decode
    showProgress('Decoding audio...', 0);
    await tick();
    const { left, right } = await decodeAudio(await file.arrayBuffer());
    showProgress('Decoding audio...', 1);

    // 2. Stem separation
    const { vocalL, vocalR, instrL, instrR } = await splitStems(left, right);

    // 3. Build AudioBuffers for playback (instrumental + optional vocal mix)
    initAudioContext();
    instrumentalBuffer = audioCtx.createBuffer(2, instrL.length, SAMPLE_RATE);
    instrumentalBuffer.getChannelData(0).set(instrL);
    instrumentalBuffer.getChannelData(1).set(instrR);

    vocalBuffer = audioCtx.createBuffer(2, vocalL.length, SAMPLE_RATE);
    vocalBuffer.getChannelData(0).set(vocalL);
    vocalBuffer.getChannelData(1).set(vocalR);

    // 4. Resample vocals to 16 kHz mono
    showProgress('Preparing vocals for transcription...', 0);
    const mono16k = await resampleToMono16k(vocalL, vocalR);

    // 5. Transcribe with word timestamps
    words = await transcribeVocals(mono16k);

    if (words.length === 0) {
      showProgress('No lyrics detected in this song.', 1);
      // Still show player for instrumental playback
    }

    // 6. Render lyrics and show player
    const lines = buildLyricLines(words);
    renderLyrics(lines);

    el.progress.classList.add('hidden');
    el.player.classList.remove('hidden');
    el.dropZone.classList.remove('hidden');
    el.timeTotal.textContent = fmt(instrumentalBuffer.duration);
    el.seek.value = 0;
    el.timeCurrent.textContent = '0:00';

  } catch (err) {
    console.error('Karaoke pipeline failed:', err);
    showError(`Error: ${err.message}`);
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

el.settingsToggle.addEventListener('click', () => {
  const open = el.settings.classList.toggle('hidden');
  el.settingsToggle.setAttribute('aria-expanded', !open);
});

/** Apply lyrics appearance settings to CSS custom properties. */
function applyAppearance() {
  el.lyrics.style.setProperty('--lyrics-size', el.fontSize.value + 'rem');
  el.lyrics.style.setProperty('--highlight', el.highlightColor.value);
  el.fontSizeVal.textContent = el.fontSize.value;
}

el.fontSize.addEventListener('input', applyAppearance);
el.highlightColor.addEventListener('input', applyAppearance);

el.dropZone.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
el.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropZone.classList.add('dragover'); });
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

el.playBtn.addEventListener('click', () => {
  if (!instrumentalBuffer) return;
  if (playing) pause();
  else play(pausedAt);
});

el.seek.addEventListener('input', () => {
  if (!instrumentalBuffer) return;
  const time = (parseInt(el.seek.value, 10) / 1000) * instrumentalBuffer.duration;
  seekTo(time);
});

el.vocalVolume.addEventListener('input', () => {
  if (vocalGain) vocalGain.gain.value = parseFloat(el.vocalVolume.value);
});

// Live-update effects during preview
el.fxReverb.addEventListener('input', () => {
  if (previewFx) previewFx.reverbGain.gain.value = parseFloat(el.fxReverb.value);
});
el.fxReverbDecay.addEventListener('input', () => {
  // Rebuild IR on decay change (can't update convolver buffer params live)
  if (previewFx) previewFx.convolver.buffer = createReverbIR(audioCtx, parseFloat(el.fxReverbDecay.value));
});
el.fxDelay.addEventListener('input', () => {
  if (previewFx) previewFx.delayWet.gain.value = parseFloat(el.fxDelay.value);
});
el.fxDelayTime.addEventListener('input', () => {
  if (previewFx) previewFx.delayNode.delayTime.value = parseFloat(el.fxDelayTime.value);
});
el.fxDelayFb.addEventListener('input', () => {
  if (previewFx) previewFx.feedbackGain.gain.value = parseFloat(el.fxDelayFb.value);
});
el.fxChorus.addEventListener('input', () => {
  if (previewFx) previewFx.chorusWet.gain.value = parseFloat(el.fxChorus.value) * 0.5;
});
el.mixVocal.addEventListener('input', () => {
  if (previewMicGain) previewMicGain.gain.value = parseFloat(el.mixVocal.value);
});

el.recordBtn.addEventListener('click', () => {
  if (!instrumentalBuffer) return;
  if (recording) stopRecording();
  else startRecording();
});

el.previewBtn.addEventListener('click', () => {
  if (previewing) stopPreview();
  else startPreview();
});

el.exportRecording.addEventListener('click', async () => {
  if (!recordingMic) return;
  const blob = await renderRecordingWAV();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${songBaseName}-recording.wav`;
  a.click();
  URL.revokeObjectURL(url);
});

el.exportLrc.addEventListener('click', () => {
  if (!words.length) return;
  downloadText(buildLRC(words), `${songBaseName}.lrc`);
});

el.exportAss.addEventListener('click', () => {
  if (!words.length) return;
  downloadText(buildASS(words), `${songBaseName}.ass`);
});
