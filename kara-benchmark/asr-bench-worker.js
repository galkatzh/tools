/**
 * Benchmark variant of the ASR worker. Two modes:
 *
 *  1. 'pipeline' — Transformers.js automatic-speech-recognition pipeline.
 *      Times model load and each pipeline call on real audio chunks.
 *
 *  2. 'onnx' — Direct onnxruntime-web inference of a single ONNX file.
 *      Synthetic random input (shape supplied by caller) is run N times.
 *      Reports per-call wall time and (optionally) ORT op-level profile.
 *
 * Messages in:
 *   { type: 'init', mode: 'pipeline', config: { repo, dtype, device } }
 *   { type: 'init', mode: 'onnx', modelBytes, profile?: boolean }
 *   { type: 'transcribe', chunkIdx, audio: ArrayBuffer, language? }   // pipeline mode
 *   { type: 'runOnnx', chunkIdx, inputs: { name: { data, shape } } }   // onnx mode
 *   { type: 'inspectOnnx' }                                            // onnx mode
 *   { type: 'endProfiling' }
 *
 * Messages out:
 *   { type: 'load-progress', ...progressInfo }
 *   { type: 'ready', timings: { loadMs } }
 *   { type: 'result', chunkIdx, durationMs, text? }
 *   { type: 'inputs', names: [...], shapes: {...} }
 *   { type: 'profile', filename }
 *   { type: 'error', message }
 */

const TFJS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.mjs';

let mode = null;
let transcriber = null;     // pipeline instance
let onnxSession = null;     // raw ONNX session
let ortLib = null;          // imported ort module (cached)

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      mode = msg.mode;
      const t0 = performance.now();

      if (mode === 'pipeline') {
        const cb = (p) => self.postMessage({ type: 'load-progress', ...p });
        const hasWebGPU = !!navigator.gpu;
        const device = msg.config.device === 'webgpu' && hasWebGPU ? 'webgpu' : 'wasm';
        if (msg.config.device === 'webgpu' && !hasWebGPU) {
          console.warn('[asr-bench-worker] WebGPU unavailable, falling back to WASM');
        }
        const tfjs = await import(TFJS_CDN);
        transcriber = await tfjs.pipeline(
          'automatic-speech-recognition',
          msg.config.repo,
          { dtype: msg.config.dtype, device, progress_callback: cb },
        );
      } else if (mode === 'onnx') {
        ortLib = await import(ORT_CDN);
        ortLib.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
        ortLib.env.wasm.numThreads = 1;
        ortLib.env.wasm.proxy = false;

        const opts = { executionProviders: ['wasm'] };
        if (msg.profile) opts.enableProfiling = true;
        onnxSession = await ortLib.InferenceSession.create(msg.modelBytes, opts);
      } else {
        throw new Error(`Unknown init mode: ${mode}`);
      }

      const loadMs = performance.now() - t0;
      self.postMessage({ type: 'ready', timings: { loadMs } });
      return;
    }

    if (msg.type === 'inspectOnnx') {
      // Surface input names and (possibly partial) shapes so the UI can
      // ask the user to fill in any dynamic dimensions.
      const names = onnxSession.inputNames;
      const meta = onnxSession.inputMetadata || {};
      const shapes = {};
      for (const n of names) shapes[n] = meta[n]?.dimensions || meta[n]?.shape || null;
      self.postMessage({ type: 'inputs', names, shapes });
      return;
    }

    if (msg.type === 'transcribe') {
      const audio = new Float32Array(msg.audio);
      const t = performance.now();
      const opts = { return_timestamps: false };
      if (msg.language) opts.language = msg.language;
      const result = await transcriber(audio, opts);
      const durationMs = performance.now() - t;
      self.postMessage({
        type: 'result',
        chunkIdx: msg.chunkIdx,
        durationMs,
        text: result?.text || '',
      });
      return;
    }

    if (msg.type === 'runOnnx') {
      // Build feed object from caller-supplied {name: {data, shape}} pairs.
      const feed = {};
      for (const [name, spec] of Object.entries(msg.inputs)) {
        feed[name] = new ortLib.Tensor('float32', new Float32Array(spec.data), spec.shape);
      }
      const t = performance.now();
      await onnxSession.run(feed);
      const durationMs = performance.now() - t;
      self.postMessage({ type: 'result', chunkIdx: msg.chunkIdx, durationMs });
      return;
    }

    if (msg.type === 'endProfiling') {
      const filename = onnxSession ? await onnxSession.endProfiling() : null;
      self.postMessage({ type: 'profile', filename });
      return;
    }
  } catch (err) {
    console.error('[asr-bench-worker]', err);
    self.postMessage({ type: 'error', chunkIdx: msg.chunkIdx, message: err.message });
  }
};
