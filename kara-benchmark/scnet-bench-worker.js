/**
 * Benchmark variant of the SCNet single-file splitter worker.
 *
 * SCNet runs as a single ONNX session on the complex stereo spectrogram.
 * Input  shape: [1, 4, F=2049, T]  channels = [Lreal, Limag, Rreal, Rimag]
 * Output shape: [4_sources, 4, F, T] flattened — sources[3] is vocals (by
 * convention used in audio-splitter/splitter-worker.js); the other three
 * are summed for the instrumental.
 *
 * Messages in / out match spleeter-bench-worker.js shape so app.js can
 * treat both formats identically.
 *
 * Messages in:
 *   { type: 'init', modelBytes, profile?: boolean }
 *   { type: 'process', chunkIdx, leftData, rightData, originalLen }
 *   { type: 'endProfiling' }
 */

import { N_FREQ, stft, istft } from '../audio-splitter/audio-processor.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.mjs';

const VOCAL_IDX = 3;
const N_SOURCES = 4;

let session = null;

/** Best-effort read of a file from ORT-web's emscripten virtual filesystem. */
function readWasmFile(filename) {
  const candidates = [
    () => self.OrtWasmModule,
    () => ort?.env?.wasm?.binding,
    () => ort?.env?.wasm?._OrtCreateSession?.module,
    () => self.Module,
  ];
  for (const get of candidates) {
    try {
      const mod = get();
      if (mod && typeof mod.FS?.readFile === 'function') {
        const bytes = mod.FS.readFile(filename, { encoding: 'utf8' });
        if (bytes) return typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
      }
    } catch (e) { /* try next */ }
  }
  console.warn('[scnet-bench-worker] could not read profile from WASM FS:', filename);
  return null;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;

      const opts = { executionProviders: ['wasm'] };
      if (data.profile) opts.enableProfiling = true;

      const t0 = performance.now();
      session = await ort.InferenceSession.create(data.modelBytes, opts);
      const loadMs = performance.now() - t0;

      // Surface input/output names in case they differ from canonical SCNet
      // ('spectrogram' / 'sources') so app.js can adapt if needed.
      self.postMessage({
        type: 'ready',
        timings: { loadMs },
        inputNames: session.inputNames,
        outputNames: session.outputNames,
      });
      return;
    }

    if (data.type === 'process') {
      const { chunkIdx, originalLen } = data;
      const left = new Float32Array(data.leftData);
      const right = new Float32Array(data.rightData);
      const phases = {};
      const tStart = performance.now();

      // ── STFT (center=True, normalized — produces SCNet-shaped tensor) ──
      let t = performance.now();
      const { data: stftData, nFrames } = stft(left, right);
      phases.stft = performance.now() - t;

      // ── Inference ───────────────────────────────────────────────
      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];
      const tensor = new ort.Tensor('float32', stftData, [1, 4, N_FREQ, nFrames]);
      t = performance.now();
      const output = (await session.run({ [inputName]: tensor }))[outputName];
      phases.run = performance.now() - t;

      // ── Sum non-vocal sources for instrumental ──────────────────
      t = performance.now();
      const stride = 4 * N_FREQ * nFrames;
      const instrSpec = new Float32Array(stride);
      for (let s = 0; s < N_SOURCES; s++) {
        if (s === VOCAL_IDX) continue;
        const src = output.data.subarray(s * stride, (s + 1) * stride);
        for (let i = 0; i < stride; i++) instrSpec[i] += src[i];
      }
      const vocalSpec = output.data.slice(VOCAL_IDX * stride, (VOCAL_IDX + 1) * stride);
      phases.buildInstr = performance.now() - t;

      // ── iSTFT for both stems ────────────────────────────────────
      t = performance.now();
      istft(vocalSpec, nFrames, originalLen);
      phases.istftVocal = performance.now() - t;

      t = performance.now();
      istft(instrSpec, nFrames, originalLen);
      phases.istftInstr = performance.now() - t;

      phases.total = performance.now() - tStart;
      self.postMessage({ type: 'result', chunkIdx, phases });
      return;
    }

    if (data.type === 'endProfiling') {
      const filename = session ? await session.endProfiling() : null;
      const json = filename ? readWasmFile(filename) : null;
      self.postMessage({ type: 'profile', filename, json });
      return;
    }
  } catch (err) {
    console.error('[scnet-bench-worker]', err);
    self.postMessage({ type: 'error', chunkIdx: data.chunkIdx, message: err.message });
  }
};
