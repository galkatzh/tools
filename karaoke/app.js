/**
 * Karaoke App — upload a song, split stems, transcribe lyrics, sing along.
 *
 * Pipeline: Upload → Decode (44.1 kHz stereo) → Stem Split (vocal + instrumental)
 *         → Resample vocals (16 kHz mono) → Transcribe (word timestamps)
 *         → Play instrumental + synced lyrics display
 *
 * Reuses workers from sibling apps:
 *   ../audio-splitter/splitter-worker.js  — SCNet ONNX stem separation
 *   ../local-transcribe/transcribe-worker.js — Whisper ASR via Transformers.js
 */

import { SAMPLE_RATE, decodeAudio } from '../audio-splitter/audio-processor.js';

// ── Configuration ──────────────────────────────────────────────────────────

const MODEL_URL = 'https://huggingface.co/bgkb/scnet_onnx/resolve/main/scnet.onnx';
const WHISPER_MODEL = {
  repo: 'onnx-community/whisper-base',
  apiType: 'pipeline',
  dtype: 'fp32',
  device: 'wasm',
};

const CHUNK_SECONDS = 11;
const CHUNK_SAMPLES = CHUNK_SECONDS * SAMPLE_RATE;
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
let sourceNode = null;
let instrumentalBuffer = null; // AudioBuffer for playback
let words = [];                // [{ text, start, end }]
let playing = false;
let startedAt = 0;             // audioCtx.currentTime when playback started
let pausedAt = 0;              // offset in seconds when paused
let animFrameId = null;
let songBaseName = 'karaoke';       // filename stem for exports

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

// ── Splitter worker pool (mirrors audio-splitter/app.js ChunkWorker) ───────

class ChunkWorker {
  constructor(bytes) {
    this._pending = new Map();
    this.worker = new Worker(new URL('../audio-splitter/splitter-worker.js', import.meta.url));
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
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    this.worker.postMessage({ type: 'init', modelBytes: copy }, [copy]);
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

async function loadSplitterModel() {
  let modelBytes = await getCachedModel(MODEL_URL);
  if (!modelBytes) {
    showProgress('Downloading stem-split model...', 0);
    const resp = await fetch(MODEL_URL);
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
          `Downloading stem-split model... ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`,
          received / total,
        );
      }
    }
    modelBytes = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { modelBytes.set(c, off); off += c.length; }
    await setCachedModel(MODEL_URL, modelBytes);
  }
  return modelBytes;
}

function padToChunkSize(signal) {
  if (signal.length === CHUNK_SAMPLES) return signal;
  const out = new Float32Array(CHUNK_SAMPLES);
  out.set(signal);
  return out;
}

/**
 * Split stereo audio into vocals + instrumental using SCNet workers.
 * Returns Float32Arrays for each channel of each stem.
 */
async function splitStems(left, right) {
  const modelBytes = await loadSplitterModel();

  const numWorkers = parseInt(el.splitWorkers.value, 10) || 2;
  showProgress(`Initializing ${numWorkers} stem-split workers...`, 0);
  const workers = Array.from({ length: numWorkers }, () => new ChunkWorker(modelBytes));
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

  /** Send one chunk and wait for its result. */
  transcribe(chunkIdx, audioChunk, language) {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      const buf = audioChunk.buffer.slice(
        audioChunk.byteOffset,
        audioChunk.byteOffset + audioChunk.byteLength,
      );
      const msg = { type: 'transcribe', chunkIdx, audio: buf, returnTimestamps: 'word' };
      if (language) msg.language = language;
      this.worker.postMessage(msg, [buf]);
    });
  }

  terminate() { this.worker.terminate(); }
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

  // Merge results in order
  const allWords = [];
  for (let i = 0; i < nChunks; i++) {
    const chunkOffset = i * WHISPER_CHUNK_SECONDS;
    for (const w of results[i].result?.chunks || []) {
      allWords.push({
        text: w.text,
        start: (w.timestamp?.[0] ?? 0) + chunkOffset,
        end: (w.timestamp?.[1] ?? 0) + chunkOffset,
      });
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

/** Render lyrics into the DOM. Each word gets a span with data attributes. */
function renderLyrics(lines) {
  el.lyrics.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'lyric-line future';
    div.dataset.start = line[0].start;
    div.dataset.end = line[line.length - 1].end;
    for (const w of line) {
      const span = document.createElement('span');
      span.className = 'lyric-word';
      span.textContent = w.text + ' ';
      span.dataset.start = w.start;
      span.dataset.end = w.end;
      div.appendChild(span);
    }
    el.lyrics.appendChild(div);
  }
}

// ── Playback ───────────────────────────────────────────────────────────────

function initAudioContext() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
}

function play(offset = 0) {
  initAudioContext();
  if (sourceNode) { sourceNode.stop(); sourceNode.disconnect(); }

  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = instrumentalBuffer;
  sourceNode.connect(audioCtx.destination);
  sourceNode.start(0, offset);
  sourceNode.onended = () => {
    if (playing) stop();
  };

  startedAt = audioCtx.currentTime - offset;
  playing = true;
  el.iconPlay.classList.add('hidden');
  el.iconPause.classList.remove('hidden');
  animFrameId = requestAnimationFrame(updateLoop);
}

function pause() {
  if (!playing) return;
  pausedAt = audioCtx.currentTime - startedAt;
  sourceNode.stop();
  sourceNode.disconnect();
  sourceNode = null;
  playing = false;
  el.iconPlay.classList.remove('hidden');
  el.iconPause.classList.add('hidden');
  cancelAnimationFrame(animFrameId);
}

function stop() {
  pause();
  pausedAt = 0;
  updateUI(0);
}

function seekTo(time) {
  const wasPlaying = playing;
  if (playing) { sourceNode.stop(); sourceNode.disconnect(); sourceNode = null; playing = false; }
  pausedAt = time;
  if (wasPlaying) play(time);
  else updateUI(time);
}

function getCurrentTime() {
  if (playing) return audioCtx.currentTime - startedAt;
  return pausedAt;
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

  // Update line and word highlights
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

    // Update word classes within this line
    for (const span of lineEl.querySelectorAll('.lyric-word')) {
      const ws = parseFloat(span.dataset.start);
      const we = parseFloat(span.dataset.end);
      if (time >= we) span.className = 'lyric-word sung';
      else if (time >= ws) span.className = 'lyric-word current';
      else span.className = 'lyric-word';
    }
  }

  // Auto-scroll active line into view
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
  if (!file || !file.type.startsWith('audio/')) {
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

    // 3. Build instrumental AudioBuffer for playback
    initAudioContext();
    instrumentalBuffer = audioCtx.createBuffer(2, instrL.length, SAMPLE_RATE);
    instrumentalBuffer.getChannelData(0).set(instrL);
    instrumentalBuffer.getChannelData(1).set(instrR);

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

el.exportLrc.addEventListener('click', () => {
  if (!words.length) return;
  downloadText(buildLRC(words), `${songBaseName}.lrc`);
});

el.exportAss.addEventListener('click', () => {
  if (!words.length) return;
  downloadText(buildASS(words), `${songBaseName}.ass`);
});
