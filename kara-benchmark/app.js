/**
 * Kara-Benchmark orchestrator.
 *
 *  1. Download both Spleeter ONNX models (vocals + accompaniment) and the
 *     ASR model (HF repo OR a single ONNX file).
 *  2. Decode the user-supplied audio at 44.1 kHz stereo.
 *  3. Splitter benchmark: chunk the audio (Spleeter's 12s blocks, no overlap
 *     to keep the report clean), send each chunk to the bench worker, and
 *     collect per-phase wall-time data (STFT, magnitude tensor, vocals
 *     inference, accomp inference, Wiener mask, mask application, iSTFT).
 *  4. ASR benchmark:
 *       - 'pipeline' mode: chunk vocals at 30s × 16 kHz, time each pipeline call.
 *         (We use the original audio directly — vocal isolation isn't needed
 *         to measure inference cost.)
 *       - 'onnx' mode: run synthetic random input N times against the supplied
 *         ONNX file with user-specified input shapes.
 *  5. Render a phase-breakdown table per stage and overall realtime factor.
 */

import { SAMPLE_RATE, decodeAudio } from '../audio-splitter/audio-processor.js';

const CHUNK_SAMPLES = 511 * 1024 + 4096;  // matches karaoke spleeter chunk
const WHISPER_CHUNK_S = 30;
const WHISPER_RATE = 16000;

const $ = (s) => document.querySelector(s);
const el = {
  form: $('#config-form'),
  vocalsUrl: $('#vocals-url'),
  accompUrl: $('#accomp-url'),
  splitterProfile: $('#splitter-profile'),
  asrRepo: $('#asr-repo'),
  asrDtype: $('#asr-dtype'),
  asrDevice: $('#asr-device'),
  asrLang: $('#asr-language'),
  asrOnnxUrl: $('#asr-onnx-url'),
  asrOnnxShapes: $('#asr-onnx-shapes'),
  asrOnnxIters: $('#asr-onnx-iters'),
  asrProfile: $('#asr-profile'),
  pipelinePanel: $('#pipeline-config'),
  onnxPanel: $('#onnx-config'),
  audioFile: $('#audio-file'),
  runBtn: $('#run-btn'),
  status: $('#status'),
  statusText: $('#status-text'),
  barFill: $('#bar-fill'),
  report: $('#report'),
  reportSummary: $('#report-summary'),
  reportTables: $('#report-tables'),
  copyReport: $('#copy-report'),
  downloadJson: $('#download-json'),
};

// ── ASR mode toggle ────────────────────────────────────────────────────────

function asrMode() {
  return document.querySelector('input[name="asr-mode"]:checked').value;
}

document.querySelectorAll('input[name="asr-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    const m = asrMode();
    el.pipelinePanel.classList.toggle('hidden', m !== 'pipeline');
    el.onnxPanel.classList.toggle('hidden', m !== 'onnx');
  });
});

// ── Status / progress helpers ──────────────────────────────────────────────

function setStatus(text, frac = null) {
  el.status.classList.remove('hidden');
  el.statusText.textContent = text;
  if (frac !== null) el.barFill.style.width = `${Math.round(frac * 100)}%`;
}

function fail(msg) {
  setStatus(`Error: ${msg}`);
  el.barFill.style.background = '#f44336';
  el.runBtn.disabled = false;
}

// ── Model fetch with streamed progress ─────────────────────────────────────

async function fetchModelBytes(url, label) {
  setStatus(`Downloading ${label}...`, 0);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${label} download failed: ${resp.status}`);
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) setStatus(
      `Downloading ${label}... ${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`,
      received / total,
    );
  }
  const bytes = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return bytes;
}

// ── Splitter benchmark ─────────────────────────────────────────────────────

function buildSplitterChunks(left, right) {
  const total = left.length;
  const nChunks = Math.max(1, Math.floor(total / CHUNK_SAMPLES));
  const chunks = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * CHUNK_SAMPLES;
    const end = Math.min(start + CHUNK_SAMPLES, total);
    const l = new Float32Array(CHUNK_SAMPLES);
    const r = new Float32Array(CHUNK_SAMPLES);
    l.set(left.subarray(start, end));
    r.set(right.subarray(start, end));
    chunks.push({ l, r, originalLen: end - start });
  }
  return chunks;
}

async function runSplitterBenchmark(left, right) {
  const vocalsBytes = await fetchModelBytes(el.vocalsUrl.value, 'vocals model');
  const accompBytes = await fetchModelBytes(el.accompUrl.value, 'accompaniment model');

  setStatus('Initializing splitter worker...', 0);
  const worker = new Worker(new URL('./spleeter-bench-worker.js', import.meta.url), { type: 'module' });

  const profile = el.splitterProfile.checked;

  const ready = waitFor(worker, 'ready');
  // Transfer copies so original ArrayBuffer references stay usable for ASR onnx mode if needed.
  const vCopy = vocalsBytes.buffer.slice(0);
  const aCopy = accompBytes.buffer.slice(0);
  worker.postMessage({ type: 'init', vocalsBytes: vCopy, accompBytes: aCopy, profile }, [vCopy, aCopy]);
  const initMsg = await ready;

  const chunks = buildSplitterChunks(left, right);
  const phases = [];   // per-chunk records
  for (let i = 0; i < chunks.length; i++) {
    const { l, r, originalLen } = chunks[i];
    const result = waitFor(worker, 'result');
    const lBuf = l.buffer.slice(0);
    const rBuf = r.buffer.slice(0);
    worker.postMessage(
      { type: 'process', chunkIdx: i, leftData: lBuf, rightData: rBuf, originalLen },
      [lBuf, rBuf],
    );
    const msg = await result;
    phases.push(msg.phases);
    setStatus(`Splitter: chunk ${i + 1}/${chunks.length}`, (i + 1) / chunks.length);
  }

  let profileFile = null;
  if (profile) {
    const p = waitFor(worker, 'profile');
    worker.postMessage({ type: 'endProfiling' });
    const pmsg = await p;
    profileFile = { vocals: pmsg.vocalsProfile, accomp: pmsg.accompProfile };
  }

  worker.terminate();

  return {
    modelLoad: initMsg.timings,
    phases,
    nChunks: chunks.length,
    chunkDurationS: CHUNK_SAMPLES / SAMPLE_RATE,
    audioDurationS: left.length / SAMPLE_RATE,
    profileFile,
  };
}

// ── ASR pipeline benchmark ─────────────────────────────────────────────────

/** Resample stereo 44.1 kHz to mono 16 kHz via OfflineAudioContext. */
async function resampleToMono16k(left, right) {
  const numSamples = left.length;
  const duration = numSamples / SAMPLE_RATE;
  const outSamples = Math.round(duration * WHISPER_RATE);
  const off = new OfflineAudioContext(1, outSamples, WHISPER_RATE);
  const buf = off.createBuffer(2, numSamples, SAMPLE_RATE);
  buf.getChannelData(0).set(left);
  buf.getChannelData(1).set(right);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

async function runAsrPipelineBenchmark(left, right) {
  setStatus('Resampling audio to 16 kHz mono...', 0);
  const tResample = performance.now();
  const mono = await resampleToMono16k(left, right);
  const resampleMs = performance.now() - tResample;

  setStatus('Loading ASR pipeline...', 0);
  const worker = new Worker(new URL('./asr-bench-worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', ({ data }) => {
    if (data.type === 'load-progress' && data.progress != null) {
      setStatus(`Loading ASR pipeline... ${Math.round(data.progress)}%`, data.progress / 100);
    }
  });

  const ready = waitFor(worker, 'ready');
  worker.postMessage({
    type: 'init',
    mode: 'pipeline',
    config: {
      repo: el.asrRepo.value.trim(),
      dtype: el.asrDtype.value,
      device: el.asrDevice.value,
    },
  });
  const initMsg = await ready;

  const chunkSize = WHISPER_CHUNK_S * WHISPER_RATE;
  const nChunks = Math.max(1, Math.ceil(mono.length / chunkSize));
  const calls = [];
  const language = el.asrLang.value.trim() || null;

  for (let i = 0; i < nChunks; i++) {
    const start = i * chunkSize;
    const slice = mono.slice(start, start + chunkSize);
    const buf = slice.buffer;
    const result = waitFor(worker, 'result');
    worker.postMessage({ type: 'transcribe', chunkIdx: i, audio: buf, language }, [buf]);
    const msg = await result;
    calls.push({ durationMs: msg.durationMs, text: msg.text });
    setStatus(`ASR: chunk ${i + 1}/${nChunks}`, (i + 1) / nChunks);
  }

  worker.terminate();
  return {
    mode: 'pipeline',
    modelLoadMs: initMsg.timings.loadMs,
    resampleMs,
    calls,
    nChunks,
    audioDurationS: left.length / SAMPLE_RATE,
  };
}

// ── ASR raw ONNX benchmark ─────────────────────────────────────────────────

async function runAsrOnnxBenchmark() {
  const url = el.asrOnnxUrl.value.trim();
  if (!url) throw new Error('ASR ONNX URL is required');

  let shapes;
  try {
    shapes = JSON.parse(el.asrOnnxShapes.value.trim() || '{}');
  } catch (e) {
    throw new Error(`Invalid input shapes JSON: ${e.message}`);
  }
  if (!Object.keys(shapes).length) {
    throw new Error('Provide at least one input in the shapes JSON.');
  }
  const iters = parseInt(el.asrOnnxIters.value, 10) || 10;

  const modelBytes = await fetchModelBytes(url, 'ASR ONNX');

  setStatus('Initializing ASR ONNX worker...', 0);
  const worker = new Worker(new URL('./asr-bench-worker.js', import.meta.url), { type: 'module' });

  const profile = el.asrProfile.checked;
  const ready = waitFor(worker, 'ready');
  const mCopy = modelBytes.buffer.slice(0);
  worker.postMessage({ type: 'init', mode: 'onnx', modelBytes: mCopy, profile }, [mCopy]);
  const initMsg = await ready;

  // Build feeds: random data sized to the shape
  const inputs = {};
  let totalIn = 0;
  for (const [name, shape] of Object.entries(shapes)) {
    const n = shape.reduce((a, b) => a * b, 1);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    inputs[name] = { data, shape };
    totalIn += n * 4;
  }

  const calls = [];
  for (let i = 0; i < iters; i++) {
    // Need fresh ArrayBuffers per call since the worker transfers ownership.
    const cloned = {};
    const transfers = [];
    for (const [name, spec] of Object.entries(inputs)) {
      const buf = spec.data.slice().buffer;
      cloned[name] = { data: buf, shape: spec.shape };
      transfers.push(buf);
    }
    const result = waitFor(worker, 'result');
    worker.postMessage({ type: 'runOnnx', chunkIdx: i, inputs: cloned }, transfers);
    const msg = await result;
    calls.push({ durationMs: msg.durationMs });
    setStatus(`ASR ONNX: iter ${i + 1}/${iters}`, (i + 1) / iters);
  }

  let profileFile = null;
  if (profile) {
    const p = waitFor(worker, 'profile');
    worker.postMessage({ type: 'endProfiling' });
    profileFile = (await p).filename;
  }

  worker.terminate();
  return {
    mode: 'onnx',
    modelLoadMs: initMsg.timings.loadMs,
    calls,
    iters,
    inputBytesPerCall: totalIn,
    profileFile,
  };
}

// ── Worker message helper ──────────────────────────────────────────────────

/** Resolve on the next message of `type`, reject on 'error'. */
function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const handler = ({ data }) => {
      if (data.type === type) {
        worker.removeEventListener('message', handler);
        resolve(data);
      } else if (data.type === 'error') {
        worker.removeEventListener('message', handler);
        reject(new Error(data.message));
      }
    };
    worker.addEventListener('message', handler);
  });
}

// ── Report rendering ───────────────────────────────────────────────────────

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function mean(arr) { return arr.length ? sum(arr) / arr.length : 0; }
function fmtMs(ms) { return `${ms.toFixed(1)}`; }
function pct(n, total) { return total > 0 ? `${(100 * n / total).toFixed(1)}%` : '—'; }

/** Build aggregated phase rows: [{phase, calls, totalMs, meanMs}]. */
function aggregatePhases(records, phaseOrder) {
  const rows = [];
  for (const phase of phaseOrder) {
    const values = records.map((r) => r[phase]).filter((v) => v != null);
    rows.push({
      phase,
      calls: values.length,
      totalMs: sum(values),
      meanMs: mean(values),
    });
  }
  return rows;
}

function tableHTML(title, rows, totalMs) {
  const body = rows.map((r) => `
    <tr>
      <td>${r.phase}</td>
      <td>${r.calls}</td>
      <td class="num">${fmtMs(r.totalMs)}</td>
      <td class="num">${fmtMs(r.meanMs)}</td>
      <td class="num">${pct(r.totalMs, totalMs)}</td>
    </tr>`).join('');
  return `
    <h3>${title}</h3>
    <table class="report-table">
      <thead><tr><th>Phase</th><th>Calls</th><th>Total ms</th><th>Mean ms</th><th>% stage</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="2"><strong>Total</strong></td>
        <td class="num"><strong>${fmtMs(totalMs)}</strong></td>
        <td></td><td class="num"><strong>100.0%</strong></td></tr></tfoot>
    </table>`;
}

function renderReport({ splitter, asr, audioDurationS, totalMs }) {
  el.report.classList.remove('hidden');

  // ── Splitter table ──
  const splitterPhaseOrder = ['stft', 'magnitude', 'vocalsRun', 'accompRun', 'wiener', 'applyMask', 'istft'];
  const splitRows = aggregatePhases(splitter.phases, splitterPhaseOrder);
  splitRows.unshift(
    { phase: 'Model load (vocals)', calls: 1, totalMs: splitter.modelLoad.vocalsLoadMs, meanMs: splitter.modelLoad.vocalsLoadMs },
    { phase: 'Model load (accomp)', calls: 1, totalMs: splitter.modelLoad.accompLoadMs, meanMs: splitter.modelLoad.accompLoadMs },
  );
  const splitterTotal = sum(splitRows.map((r) => r.totalMs));
  const splitterRTF = splitterTotal / 1000 / audioDurationS;

  let html = '';
  html += tableHTML(
    `Audio splitter (${splitter.nChunks} chunks × ${splitter.chunkDurationS.toFixed(1)}s)`,
    splitRows,
    splitterTotal,
  );
  html += `<p class="rtf">Realtime factor: <strong>${splitterRTF.toFixed(3)}×</strong>
    (${splitterRTF < 1 ? 'faster' : 'slower'} than realtime)</p>`;
  if (splitter.profileFile) {
    html += `<p class="hint">ORT op profile written: vocals=<code>${splitter.profileFile.vocals}</code>,
      accomp=<code>${splitter.profileFile.accomp}</code> — see DevTools console for the JSON path
      and use ORT-web's filesystem APIs to read it.</p>`;
  }

  // ── ASR table ──
  if (asr) {
    if (asr.mode === 'pipeline') {
      const callDurs = asr.calls.map((c) => c.durationMs);
      const rows = [
        { phase: 'Model load', calls: 1, totalMs: asr.modelLoadMs, meanMs: asr.modelLoadMs },
        { phase: 'Resample → 16 kHz mono', calls: 1, totalMs: asr.resampleMs, meanMs: asr.resampleMs },
        { phase: `Pipeline call (${WHISPER_CHUNK_S}s chunk)`, calls: callDurs.length, totalMs: sum(callDurs), meanMs: mean(callDurs) },
      ];
      const total = sum(rows.map((r) => r.totalMs));
      const rtf = total / 1000 / audioDurationS;
      html += tableHTML(`ASR — pipeline mode (${asr.nChunks} chunks)`, rows, total);
      html += `<p class="rtf">Realtime factor: <strong>${rtf.toFixed(3)}×</strong></p>`;
    } else if (asr.mode === 'onnx') {
      const callDurs = asr.calls.map((c) => c.durationMs);
      const rows = [
        { phase: 'Model load', calls: 1, totalMs: asr.modelLoadMs, meanMs: asr.modelLoadMs },
        { phase: 'session.run (synthetic)', calls: callDurs.length, totalMs: sum(callDurs), meanMs: mean(callDurs) },
      ];
      const total = sum(rows.map((r) => r.totalMs));
      html += tableHTML(`ASR — direct ONNX (${asr.iters} iterations, ${(asr.inputBytesPerCall / 1024).toFixed(1)} KB input)`, rows, total);
      const minD = Math.min(...callDurs);
      const maxD = Math.max(...callDurs);
      html += `<p class="rtf">session.run min/mean/max: <strong>${fmtMs(minD)} / ${fmtMs(mean(callDurs))} / ${fmtMs(maxD)}</strong> ms</p>`;
      if (asr.profileFile) {
        html += `<p class="hint">ORT op profile written: <code>${asr.profileFile}</code></p>`;
      }
    }
  }

  // Summary
  el.reportSummary.innerHTML =
    `<p>Audio: <strong>${audioDurationS.toFixed(1)}s</strong> · Wall time: <strong>${(totalMs / 1000).toFixed(2)}s</strong></p>`;
  el.reportTables.innerHTML = html;
}

/** Plain-text report for clipboard / download. */
function buildTextReport(data) {
  const lines = [];
  const { splitter, asr, audioDurationS, totalMs } = data;
  lines.push('=== Kara-Benchmark Report ===');
  lines.push(`Audio duration: ${audioDurationS.toFixed(1)}s`);
  lines.push(`Wall time: ${(totalMs / 1000).toFixed(2)}s`);
  lines.push('');
  lines.push('-- Audio splitter --');
  lines.push(`Vocals model load: ${fmtMs(splitter.modelLoad.vocalsLoadMs)} ms`);
  lines.push(`Accomp model load: ${fmtMs(splitter.modelLoad.accompLoadMs)} ms`);
  for (const phase of ['stft', 'magnitude', 'vocalsRun', 'accompRun', 'wiener', 'applyMask', 'istft']) {
    const vals = splitter.phases.map((p) => p[phase]);
    lines.push(`${phase.padEnd(14)} total=${fmtMs(sum(vals))} mean=${fmtMs(mean(vals))} (${vals.length} chunks)`);
  }
  lines.push('');
  if (asr) {
    lines.push(`-- ASR (${asr.mode}) --`);
    if (asr.mode === 'pipeline') {
      lines.push(`Model load: ${fmtMs(asr.modelLoadMs)} ms`);
      lines.push(`Resample: ${fmtMs(asr.resampleMs)} ms`);
      const d = asr.calls.map((c) => c.durationMs);
      lines.push(`Pipeline call: total=${fmtMs(sum(d))} mean=${fmtMs(mean(d))} (${d.length} chunks)`);
    } else {
      lines.push(`Model load: ${fmtMs(asr.modelLoadMs)} ms`);
      const d = asr.calls.map((c) => c.durationMs);
      lines.push(`session.run: min=${fmtMs(Math.min(...d))} mean=${fmtMs(mean(d))} max=${fmtMs(Math.max(...d))} (${d.length} iters)`);
    }
  }
  return lines.join('\n');
}

// ── Main flow ──────────────────────────────────────────────────────────────

async function run() {
  const file = el.audioFile.files[0];
  if (!file) { fail('Pick an audio file first.'); return; }

  el.runBtn.disabled = true;
  el.report.classList.add('hidden');
  el.barFill.style.background = '';

  const tStart = performance.now();
  let data = null;
  try {
    setStatus('Decoding audio...', 0);
    const { left, right } = await decodeAudio(await file.arrayBuffer());
    const audioDurationS = left.length / SAMPLE_RATE;

    const splitter = await runSplitterBenchmark(left, right);

    let asr = null;
    const m = asrMode();
    if (m === 'pipeline') asr = await runAsrPipelineBenchmark(left, right);
    else if (m === 'onnx') asr = await runAsrOnnxBenchmark();

    const totalMs = performance.now() - tStart;
    data = { splitter, asr, audioDurationS, totalMs };
    setStatus('Done.', 1);
    renderReport(data);
  } catch (err) {
    console.error('Benchmark failed:', err);
    fail(err.message);
    return;
  } finally {
    el.runBtn.disabled = false;
  }

  el.copyReport.onclick = async () => {
    try {
      await navigator.clipboard.writeText(buildTextReport(data));
      el.copyReport.textContent = 'Copied!';
      setTimeout(() => { el.copyReport.textContent = 'Copy report (text)'; }, 1500);
    } catch (e) {
      console.error('Clipboard write failed:', e);
    }
  };
  el.downloadJson.onclick = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'kara-benchmark-report.json'; a.click();
    URL.revokeObjectURL(url);
  };
}

el.form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
