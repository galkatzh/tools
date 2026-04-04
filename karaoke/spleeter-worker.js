/**
 * Web Worker: Spleeter 2-stem ONNX separation (vocals + accompaniment).
 *
 * Uses two separate models with Wiener soft-masking:
 *   - vocals.onnx      → vocal spectrogram predictions
 *   - accompaniment.onnx → accompaniment spectrogram predictions
 *
 * Both models accept magnitude spectrograms shaped [2, numSplits, 512, 1024]
 * (stereo, splits of 512 frames, first 1024 of 2049 frequency bins) and output
 * the predicted magnitude for that stem in the same shape.
 *
 * Messages in:
 *   { type: 'init', vocalsBytes: ArrayBuffer, accompBytes: ArrayBuffer }
 *   { type: 'process', chunkIdx, leftData: ArrayBuffer, rightData: ArrayBuffer, originalLen }
 *
 * Messages out:
 *   { type: 'ready' }
 *   { type: 'result', chunkIdx, vocalL, vocalR, instrL, instrR: Float32Array }
 *   { type: 'error', chunkIdx?, message }
 */

import { N_FREQ, stftChannel, istftChannel } from '../audio-splitter/audio-processor.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.mjs';

/** Spleeter model uses only the first 1024 of N_FREQ=2049 frequency bins. */
const SPLEETER_BINS = 1024;
/** Frames per split — fixed by the Spleeter ONNX model architecture. */
const SPLIT_FRAMES = 512;

let vocalsSession = null;
let accompSession = null;

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
      // SharedArrayBuffer unavailable without COEP headers; parallelism via multiple workers.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      [vocalsSession, accompSession] = await Promise.all([
        ort.InferenceSession.create(data.vocalsBytes, { executionProviders: ['wasm'] }),
        ort.InferenceSession.create(data.accompBytes, { executionProviders: ['wasm'] }),
      ]);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      console.error('[spleeter-worker] init failed:', err);
      self.postMessage({ type: 'error', message: err.message });
    }
    return;
  }

  if (data.type === 'process') {
    try {
      const { chunkIdx, originalLen } = data;
      const left  = new Float32Array(data.leftData);
      const right = new Float32Array(data.rightData);

      // Complex STFT for both channels
      const stftL = stftChannel(left);
      const stftR = stftChannel(right);
      const nFrames = stftL.nFrames;

      // Pad frame count to next multiple of SPLIT_FRAMES for model input
      const numSplits = Math.ceil(nFrames / SPLIT_FRAMES);
      const paddedFrames = numSplits * SPLIT_FRAMES;

      // Build magnitude input tensor [2, numSplits, SPLIT_FRAMES, SPLEETER_BINS]
      // Layout: channel → split → frame-within-split → frequency bin
      const inputData = new Float32Array(2 * paddedFrames * SPLEETER_BINS);
      for (let ch = 0; ch < 2; ch++) {
        const { realFlat, imagFlat } = ch === 0 ? stftL : stftR;
        const chOff = ch * paddedFrames * SPLEETER_BINS;
        for (let t = 0; t < nFrames; t++) {
          const tOff = t * N_FREQ;
          const splitFrame = Math.floor(t / SPLIT_FRAMES) * SPLIT_FRAMES * SPLEETER_BINS
                           + (t % SPLIT_FRAMES) * SPLEETER_BINS;
          for (let f = 0; f < SPLEETER_BINS; f++) {
            const re = realFlat[tOff + f], im = imagFlat[tOff + f];
            inputData[chOff + splitFrame + f] = Math.sqrt(re * re + im * im);
          }
        }
      }

      const inputTensor = new ort.Tensor('float32', inputData, [2, numSplits, SPLIT_FRAMES, SPLEETER_BINS]);

      // Run both models in parallel — same input tensor (read-only, safe to share)
      const [vocalsOut, accompOut] = await Promise.all([
        vocalsSession.run({ x: inputTensor }),
        accompSession.run({ x: inputTensor }),
      ]);
      const vPred = vocalsOut['y'].data;   // [2, numSplits, SPLIT_FRAMES, SPLEETER_BINS]
      const aPred = accompOut['y'].data;

      // Allocate complex STFT buffers for each stem (row-major: frame × freq)
      const vLRe = new Float32Array(nFrames * N_FREQ);
      const vLIm = new Float32Array(nFrames * N_FREQ);
      const vRRe = new Float32Array(nFrames * N_FREQ);
      const vRIm = new Float32Array(nFrames * N_FREQ);
      const iLRe = new Float32Array(nFrames * N_FREQ);
      const iLIm = new Float32Array(nFrames * N_FREQ);
      const iRRe = new Float32Array(nFrames * N_FREQ);
      const iRIm = new Float32Array(nFrames * N_FREQ);

      // Wiener soft masking: mask = pred² / (vPred² + aPred² + ε)
      // Applied to all N_FREQ bins; bins above SPLEETER_BINS get an equal 0.5/0.5 split.
      const EPS = 1e-10;
      for (let ch = 0; ch < 2; ch++) {
        const { realFlat, imagFlat } = ch === 0 ? stftL : stftR;
        const chOff = ch * paddedFrames * SPLEETER_BINS;
        const vRe = ch === 0 ? vLRe : vRRe, vIm = ch === 0 ? vLIm : vRIm;
        const iRe = ch === 0 ? iLRe : iRRe, iIm = ch === 0 ? iLIm : iRIm;

        for (let t = 0; t < nFrames; t++) {
          const maskOff = chOff
            + Math.floor(t / SPLIT_FRAMES) * SPLIT_FRAMES * SPLEETER_BINS
            + (t % SPLIT_FRAMES) * SPLEETER_BINS;
          const tOff = t * N_FREQ;

          for (let f = 0; f < N_FREQ; f++) {
            const re = realFlat[tOff + f], im = imagFlat[tOff + f];
            let vMask, aMask;
            if (f < SPLEETER_BINS) {
              const v2 = vPred[maskOff + f] ** 2, a2 = aPred[maskOff + f] ** 2;
              const denom = v2 + a2 + EPS;
              vMask = (v2 + EPS / 2) / denom;
              aMask = (a2 + EPS / 2) / denom;
            } else {
              // No model prediction above 1024 bins — split equally
              vMask = 0.5; aMask = 0.5;
            }
            vRe[tOff + f] = re * vMask; vIm[tOff + f] = im * vMask;
            iRe[tOff + f] = re * aMask; iIm[tOff + f] = im * aMask;
          }
        }
      }

      const vocalL = istftChannel(vLRe, vLIm, nFrames, originalLen);
      const vocalR = istftChannel(vRRe, vRIm, nFrames, originalLen);
      const instrL = istftChannel(iLRe, iLIm, nFrames, originalLen);
      const instrR = istftChannel(iRRe, iRIm, nFrames, originalLen);

      self.postMessage(
        { type: 'result', chunkIdx, vocalL, vocalR, instrL, instrR },
        [vocalL.buffer, vocalR.buffer, instrL.buffer, instrR.buffer],
      );
    } catch (err) {
      console.error('[spleeter-worker] process failed:', err);
      self.postMessage({ type: 'error', chunkIdx: data.chunkIdx, message: err.message });
    }
  }
};
