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

const SPLEETER_CHUNK_SAMPLES = 511 * 1024 + 4096;            // matches karaoke spleeter chunk (~12s)
const SCNET_CHUNK_SAMPLES = 11 * SAMPLE_RATE;                 // matches audio-splitter SCNet chunk (~11s)
const WHISPER_CHUNK_S = 30;
const WHISPER_RATE = 16000;

const $ = (s) => document.querySelector(s);
const el = {
  form: $('#config-form'),
  vocalsUrl: $('#vocals-url'),
  accompUrl: $('#accomp-url'),
  scnetUrl: $('#scnet-url'),
  spleeterPanel: $('#spleeter-config'),
  scnetPanel: $('#scnet-config'),
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
  downloadTrace: $('#download-trace'),
};

// ── Mode toggles ───────────────────────────────────────────────────────────

function asrMode() {
  return document.querySelector('input[name="asr-mode"]:checked').value;
}
function splitterFormat() {
  return document.querySelector('input[name="splitter-format"]:checked').value;
}

document.querySelectorAll('input[name="asr-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    const m = asrMode();
    el.pipelinePanel.classList.toggle('hidden', m !== 'pipeline');
    el.onnxPanel.classList.toggle('hidden', m !== 'onnx');
  });
});

document.querySelectorAll('input[name="splitter-format"]').forEach((r) => {
  r.addEventListener('change', () => {
    const f = splitterFormat();
    el.spleeterPanel.classList.toggle('hidden', f !== 'spleeter');
    el.scnetPanel.classList.toggle('hidden', f !== 'scnet');
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

// ── Splitter benchmarks ────────────────────────────────────────────────────

/** Slice stereo audio into fixed-size chunks zero-padded to chunkSamples. */
function buildSplitterChunks(left, right, chunkSamples) {
  const total = left.length;
  const nChunks = Math.max(1, Math.floor(total / chunkSamples));
  const chunks = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * chunkSamples;
    const end = Math.min(start + chunkSamples, total);
    const l = new Float32Array(chunkSamples);
    const r = new Float32Array(chunkSamples);
    l.set(left.subarray(start, end));
    r.set(right.subarray(start, end));
    chunks.push({ l, r, originalLen: end - start });
  }
  return chunks;
}

/** Process all chunks against a worker, collecting per-phase timings. */
async function runChunkedBenchmark(worker, chunks) {
  const phases = [];
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
  return phases;
}

async function runSpleeterBenchmark(left, right) {
  const vocalsBytes = await fetchModelBytes(el.vocalsUrl.value, 'vocals model');
  const accompBytes = await fetchModelBytes(el.accompUrl.value, 'accompaniment model');

  setStatus('Initializing Spleeter worker...', 0);
  const worker = new Worker(new URL('./spleeter-bench-worker.js', import.meta.url), { type: 'module' });
  const profile = el.splitterProfile.checked;

  const ready = waitFor(worker, 'ready');
  const vCopy = vocalsBytes.buffer.slice(0);
  const aCopy = accompBytes.buffer.slice(0);
  worker.postMessage({ type: 'init', vocalsBytes: vCopy, accompBytes: aCopy, profile }, [vCopy, aCopy]);
  const initMsg = await ready;

  const chunks = buildSplitterChunks(left, right, SPLEETER_CHUNK_SAMPLES);
  const phases = await runChunkedBenchmark(worker, chunks);

  let ortProfile = null;
  if (profile) {
    const p = waitFor(worker, 'profile');
    worker.postMessage({ type: 'endProfiling' });
    const pmsg = await p;
    ortProfile = { vocals: pmsg.vocals, accomp: pmsg.accomp };
  }

  worker.terminate();

  return {
    format: 'spleeter',
    phaseOrder: ['stft', 'magnitude', 'vocalsRun', 'accompRun', 'wiener', 'applyMask', 'istft'],
    modelLoad: [
      { label: 'Model load (vocals)', ms: initMsg.timings.vocalsLoadMs },
      { label: 'Model load (accomp)', ms: initMsg.timings.accompLoadMs },
    ],
    phases,
    nChunks: chunks.length,
    chunkDurationS: SPLEETER_CHUNK_SAMPLES / SAMPLE_RATE,
    audioDurationS: left.length / SAMPLE_RATE,
    ortProfile,
  };
}

async function runScnetBenchmark(left, right) {
  const modelBytes = await fetchModelBytes(el.scnetUrl.value, 'SCNet model');

  setStatus('Initializing SCNet worker...', 0);
  const worker = new Worker(new URL('./scnet-bench-worker.js', import.meta.url), { type: 'module' });
  const profile = el.splitterProfile.checked;

  const ready = waitFor(worker, 'ready');
  const mCopy = modelBytes.buffer.slice(0);
  worker.postMessage({ type: 'init', modelBytes: mCopy, profile }, [mCopy]);
  const initMsg = await ready;

  const chunks = buildSplitterChunks(left, right, SCNET_CHUNK_SAMPLES);
  const phases = await runChunkedBenchmark(worker, chunks);

  let ortProfile = null;
  if (profile) {
    const p = waitFor(worker, 'profile');
    worker.postMessage({ type: 'endProfiling' });
    const pmsg = await p;
    // Fit the existing renderer (which expects {vocals, accomp}) by aliasing
    // SCNet's single profile into the 'vocals' slot.
    ortProfile = { vocals: { filename: pmsg.filename, json: pmsg.json } };
  }

  worker.terminate();

  return {
    format: 'scnet',
    phaseOrder: ['stft', 'run', 'buildInstr', 'istftVocal', 'istftInstr'],
    modelLoad: [{ label: 'Model load', ms: initMsg.timings.loadMs }],
    phases,
    nChunks: chunks.length,
    chunkDurationS: SCNET_CHUNK_SAMPLES / SAMPLE_RATE,
    audioDurationS: left.length / SAMPLE_RATE,
    ortProfile,
    inputNames: initMsg.inputNames,
    outputNames: initMsg.outputNames,
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

  let ortProfile = null;
  if (profile) {
    const p = waitFor(worker, 'profile');
    worker.postMessage({ type: 'endProfiling' });
    const pmsg = await p;
    ortProfile = { filename: pmsg.filename, json: pmsg.json };
  }

  worker.terminate();
  return {
    mode: 'onnx',
    modelLoadMs: initMsg.timings.loadMs,
    calls,
    iters,
    inputBytesPerCall: totalIn,
    ortProfile,
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

// ── Chrome trace JSON ──────────────────────────────────────────────────────

/** Color per phase, used both in timeline bars and trace JSON categories. */
const PHASE_COLORS = {
  // Spleeter
  stft: '#6a8df0',
  magnitude: '#4cc2c2',
  vocalsRun: '#e85d75',
  accompRun: '#f0a868',
  wiener: '#9b8df0',
  applyMask: '#5cb85c',
  istft: '#e0c068',
  // SCNet
  run: '#e85d75',
  buildInstr: '#9b8df0',
  istftVocal: '#e0c068',
  istftInstr: '#f0a868',
  // ASR / shared
  modelLoad: '#888',
  resample: '#4cc2c2',
  pipelineCall: '#e85d75',
  sessionRun: '#e85d75',
};

/** Fallback color so unknown phase names still render a segment. */
function colorFor(phase) { return PHASE_COLORS[phase] || '#888'; }

/**
 * Build a Chrome tracing JSON from collected timings.
 * Importable into Perfetto (https://ui.perfetto.dev) or chrome://tracing.
 * Each chunk's phases are placed end-to-end on a single thread per stage.
 */
function buildChromeTrace(data) {
  const events = [];
  const tidSplitter = 1;
  const tidAsr = 2;

  // Process metadata
  events.push({ name: 'process_name', ph: 'M', pid: 1, tid: 0, args: { name: 'kara-benchmark' } });
  events.push({ name: 'thread_name', ph: 'M', pid: 1, tid: tidSplitter, args: { name: 'splitter' } });
  events.push({ name: 'thread_name', ph: 'M', pid: 1, tid: tidAsr, args: { name: 'asr' } });

  // ── Splitter ──
  if (data.splitter) {
    let ts = 0;
    for (const m of data.splitter.modelLoad) {
      events.push({
        name: m.label, cat: 'splitter,modelLoad', ph: 'X',
        ts, dur: Math.round(m.ms * 1000), pid: 1, tid: tidSplitter,
      });
      ts += Math.round(m.ms * 1000);
    }

    for (let i = 0; i < data.splitter.phases.length; i++) {
      const phases = data.splitter.phases[i];
      const chunkStart = ts;
      events.push({
        name: `chunk ${i}`, cat: 'splitter,chunk', ph: 'X',
        ts: chunkStart, dur: Math.round(phases.total * 1000),
        pid: 1, tid: tidSplitter,
      });
      let inner = 0;
      for (const phase of data.splitter.phaseOrder) {
        const dur = Math.round((phases[phase] || 0) * 1000);
        events.push({
          name: phase, cat: `splitter,${phase}`, ph: 'X',
          ts: chunkStart + inner, dur,
          pid: 1, tid: tidSplitter + 100 + i,  // sub-thread per chunk
          args: { chunk: i },
        });
        inner += dur;
      }
      events.push({
        name: 'thread_name', ph: 'M', pid: 1, tid: tidSplitter + 100 + i,
        args: { name: `chunk ${i}` },
      });
      ts += Math.round(phases.total * 1000);
    }
  }

  // ── ASR ──
  if (data.asr) {
    let ts = 0;
    events.push({
      name: 'modelLoad', cat: 'asr,modelLoad', ph: 'X',
      ts, dur: Math.round(data.asr.modelLoadMs * 1000),
      pid: 1, tid: tidAsr,
    });
    ts += Math.round(data.asr.modelLoadMs * 1000);
    if (data.asr.mode === 'pipeline') {
      events.push({
        name: 'resample', cat: 'asr,resample', ph: 'X',
        ts, dur: Math.round(data.asr.resampleMs * 1000),
        pid: 1, tid: tidAsr,
      });
      ts += Math.round(data.asr.resampleMs * 1000);
      for (let i = 0; i < data.asr.calls.length; i++) {
        const dur = Math.round(data.asr.calls[i].durationMs * 1000);
        events.push({
          name: `pipeline ${i}`, cat: 'asr,pipelineCall', ph: 'X',
          ts, dur, pid: 1, tid: tidAsr,
        });
        ts += dur;
      }
    } else {
      for (let i = 0; i < data.asr.calls.length; i++) {
        const dur = Math.round(data.asr.calls[i].durationMs * 1000);
        events.push({
          name: `session.run ${i}`, cat: 'asr,sessionRun', ph: 'X',
          ts, dur, pid: 1, tid: tidAsr,
        });
        ts += dur;
      }
    }
  }

  return { traceEvents: events, displayTimeUnit: 'ms' };
}

/**
 * Render a per-chunk timeline as horizontal stacked bars. Each bar's width
 * is normalized to the slowest chunk's total time so chunks can be visually
 * compared. Hovering a segment shows phase + ms.
 */
function renderTimeline(records, phaseOrder) {
  if (!records.length) return '';
  const maxTotal = Math.max(...records.map((r) => r.total));
  const rows = records.map((r, i) => {
    const segments = phaseOrder.map((phase) => {
      const ms = r[phase] || 0;
      const widthPct = (ms / maxTotal) * 100;
      return `<span class="seg" style="width:${widthPct}%;background:${colorFor(phase)}"
        title="${phase}: ${ms.toFixed(1)} ms"></span>`;
    }).join('');
    return `
      <div class="tl-row">
        <span class="tl-label">#${i}</span>
        <span class="tl-bar">${segments}</span>
        <span class="tl-total">${r.total.toFixed(1)} ms</span>
      </div>`;
  }).join('');
  const legend = phaseOrder.map((p) =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${colorFor(p)}"></span>${p}</span>`,
  ).join('');
  return `
    <h3>Per-chunk timeline</h3>
    <div class="legend">${legend}</div>
    <div class="timeline">${rows}</div>`;
}

/**
 * Aggregate a parsed ORT op-profile JSON into a per-op-type breakdown.
 * The ORT profile format is an array of {cat, name, dur (µs), args:{op_name}, ...}
 * events. We keep only kernel events and group by op type.
 */
function renderOrtOpProfile(jsonText, label) {
  if (!jsonText) {
    return `<p class="hint"><strong>${label}</strong>: ORT op profile not readable from this build.
      The JSON was written to the WASM virtual FS but couldn't be extracted.
      Tip: enable Chrome DevTools → Performance recorder while running for a flame graph.</p>`;
  }
  let events;
  try {
    const parsed = JSON.parse(jsonText);
    events = Array.isArray(parsed) ? parsed : (parsed.traceEvents || []);
  } catch (e) {
    console.error('Could not parse ORT profile JSON:', e);
    return `<p class="hint"><strong>${label}</strong>: profile JSON unparseable (${e.message}).</p>`;
  }

  // Group by op type from event args.
  const byOp = new Map();
  for (const ev of events) {
    if (ev.cat !== 'Node' && ev.cat !== 'Op') continue;
    if (!ev.dur) continue;
    const op = ev.args?.op_name || ev.args?.opType || ev.name || 'unknown';
    const cur = byOp.get(op) || { op, count: 0, totalUs: 0 };
    cur.count++;
    cur.totalUs += ev.dur;
    byOp.set(op, cur);
  }
  if (!byOp.size) {
    return `<p class="hint"><strong>${label}</strong>: profile loaded but no op events recognized
      (event count=${events.length}). Download the JSON for raw inspection.</p>`;
  }
  const rows = [...byOp.values()].sort((a, b) => b.totalUs - a.totalUs);
  const total = rows.reduce((s, r) => s + r.totalUs, 0);
  const top = rows.slice(0, 15);
  const body = top.map((r) => `
    <tr>
      <td>${r.op}</td>
      <td class="num">${r.count}</td>
      <td class="num">${(r.totalUs / 1000).toFixed(1)}</td>
      <td class="num">${(r.totalUs / r.count / 1000).toFixed(2)}</td>
      <td class="num">${pct(r.totalUs, total)}</td>
    </tr>`).join('');
  return `
    <h3>ORT op profile — ${label}${rows.length > top.length ? ` (top ${top.length}/${rows.length})` : ''}</h3>
    <table class="report-table">
      <thead><tr><th>Op</th><th>Calls</th><th>Total ms</th><th>Mean ms</th><th>%</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/** Trigger a download of arbitrary text content. */
function downloadText(content, filename, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderReport({ splitter, asr, audioDurationS, totalMs }) {
  el.report.classList.remove('hidden');

  let html = '';

  // ── Splitter table ──
  if (splitter) {
    const splitRows = aggregatePhases(splitter.phases, splitter.phaseOrder);
    for (const m of [...splitter.modelLoad].reverse()) {
      splitRows.unshift({ phase: m.label, calls: 1, totalMs: m.ms, meanMs: m.ms });
    }
    const splitterTotal = sum(splitRows.map((r) => r.totalMs));
    const splitterRTF = splitterTotal / 1000 / audioDurationS;

    html += tableHTML(
      `Audio splitter — ${splitter.format} (${splitter.nChunks} chunks × ${splitter.chunkDurationS.toFixed(1)}s)`,
      splitRows,
      splitterTotal,
    );
    html += `<p class="rtf">Realtime factor: <strong>${splitterRTF.toFixed(3)}×</strong>
      (${splitterRTF < 1 ? 'faster' : 'slower'} than realtime)</p>`;

    html += renderTimeline(splitter.phases, splitter.phaseOrder);

    if (splitter.ortProfile) {
      if (splitter.format === 'spleeter') {
        html += renderOrtOpProfile(splitter.ortProfile.vocals?.json, 'vocals');
        html += renderOrtOpProfile(splitter.ortProfile.accomp?.json, 'accompaniment');
      } else {
        html += renderOrtOpProfile(splitter.ortProfile.vocals?.json, splitter.format);
      }
    }
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
      if (asr.ortProfile) {
        html += renderOrtOpProfile(asr.ortProfile.json, 'asr-onnx');
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
  if (splitter) {
    lines.push(`-- Audio splitter (${splitter.format}) --`);
    for (const m of splitter.modelLoad) lines.push(`${m.label}: ${fmtMs(m.ms)} ms`);
    for (const phase of splitter.phaseOrder) {
      const vals = splitter.phases.map((p) => p[phase]).filter((v) => v != null);
      lines.push(`${phase.padEnd(14)} total=${fmtMs(sum(vals))} mean=${fmtMs(mean(vals))} (${vals.length} chunks)`);
    }
    lines.push('');
  }
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

    let splitter = null;
    const sf = splitterFormat();
    if (sf === 'spleeter') splitter = await runSpleeterBenchmark(left, right);
    else if (sf === 'scnet') splitter = await runScnetBenchmark(left, right);

    let asr = null;
    const m = asrMode();
    if (m === 'pipeline') asr = await runAsrPipelineBenchmark(left, right);
    else if (m === 'onnx') asr = await runAsrOnnxBenchmark();

    if (!splitter && !asr) throw new Error('Nothing to benchmark — pick at least one of splitter or ASR.');

    const totalMs = performance.now() - tStart;
    data = { splitter, asr, audioDurationS, totalMs };
    setStatus('Done.', 1);
    renderReport(data);

    // Auto-download any ORT op-profile JSON we managed to extract.
    if (splitter?.ortProfile?.vocals?.json) {
      downloadText(splitter.ortProfile.vocals.json, `splitter-${splitter.format}-vocals-ort-profile.json`);
    }
    if (splitter?.ortProfile?.accomp?.json) {
      downloadText(splitter.ortProfile.accomp.json, `splitter-${splitter.format}-accomp-ort-profile.json`);
    }
    if (asr?.ortProfile?.json) {
      downloadText(asr.ortProfile.json, 'asr-ort-profile.json');
    }
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
    downloadText(JSON.stringify(data, null, 2), 'kara-benchmark-report.json');
  };
  el.downloadTrace.onclick = () => {
    const trace = buildChromeTrace(data);
    downloadText(JSON.stringify(trace), 'kara-benchmark-trace.json');
  };
}

el.form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
