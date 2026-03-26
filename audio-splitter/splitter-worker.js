/**
 * Web Worker (module): runs STFT → ONNX inference → iSTFT for one audio chunk.
 * Imports shared FFT/STFT code from audio-processor.js (single source of truth).
 *
 * Messages in:
 *   { type: 'init', modelBytes: ArrayBuffer }
 *   { type: 'process', chunkIdx, leftData: ArrayBuffer, rightData: ArrayBuffer, originalLen }
 *
 * Messages out:
 *   { type: 'ready' }
 *   { type: 'result', chunkIdx, vocalL, vocalR, instrL, instrR: Float32Array }
 *   { type: 'error', chunkIdx?, message }
 */

import { N_FREQ, stft, istft } from './audio-processor.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.mjs';

// ── ORT session ────────────────────────────────────────────────────────────

const VOCAL_IDX = 3;
const N_SOURCES = 4;

let session = null;

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
      // SharedArrayBuffer is unavailable without COEP headers, which break CDN
      // imports in workers. Parallelism is achieved via multiple chunk workers instead.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      session = await ort.InferenceSession.create(data.modelBytes, { executionProviders: ['wasm'] });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      console.error('[worker] init failed:', err);
      self.postMessage({ type: 'error', message: err.message });
    }
    return;
  }

  if (data.type === 'process') {
    try {
      const { chunkIdx, originalLen } = data;
      const left  = new Float32Array(data.leftData);
      const right = new Float32Array(data.rightData);

      const { data: stftData, nFrames } = stft(left, right);
      const tensor = new ort.Tensor('float32', stftData, [1, 4, N_FREQ, nFrames]);
      const output = (await session.run({ spectrogram: tensor })).sources;

      const stride = 4 * N_FREQ * nFrames;

      const vocal = istft(
        output.data.slice(VOCAL_IDX * stride, (VOCAL_IDX + 1) * stride),
        nFrames, originalLen,
      );

      const instrSpec = new Float32Array(stride);
      for (let s = 0; s < N_SOURCES; s++) {
        if (s === VOCAL_IDX) continue;
        const src = output.data.subarray(s * stride, (s + 1) * stride);
        for (let i = 0; i < stride; i++) instrSpec[i] += src[i];
      }
      const instr = istft(instrSpec, nFrames, originalLen);

      self.postMessage(
        { type: 'result', chunkIdx, vocalL: vocal.left, vocalR: vocal.right, instrL: instr.left, instrR: instr.right },
        [vocal.left.buffer, vocal.right.buffer, instr.left.buffer, instr.right.buffer],
      );
    } catch (err) {
      console.error('[worker] process failed:', err);
      self.postMessage({ type: 'error', chunkIdx: data.chunkIdx, message: err.message });
    }
  }
};
