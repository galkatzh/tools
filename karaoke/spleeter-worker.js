/**
 * Web Worker: Spleeter 2-stems source separation via ONNX Runtime.
 *
 * Pipeline per chunk:
 *   STFT (center=false, no normalization) → magnitude (first 1024 of 2049 bins)
 *   → ONNX vocals model + accompaniment model → Wiener soft masking
 *   → apply masks to original complex STFT → iSTFT
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

import { N_FFT, HOP_LENGTH, N_FREQ, fft } from '../audio-splitter/audio-processor.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.mjs';

/** Spleeter uses only the first 1024 of 2049 frequency bins. */
const F_BINS = 1024;

/** Spleeter processes 512-frame blocks (batch dimension). */
const T_BLOCK = 512;

// Periodic Hann window — matches torch.hann_window(4096, periodic=True)
const HANN = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N_FFT));

let vocalsSession = null;
let accompSession = null;

// ── STFT (center=false, no normalization) ─────────────────────────────────

/** Compute STFT for one channel. No center padding, no normalization. */
function stftChannel(signal) {
  const nFrames = Math.floor((signal.length - N_FFT) / HOP_LENGTH) + 1;
  const realFlat = new Float32Array(nFrames * N_FREQ);
  const imagFlat = new Float32Array(nFrames * N_FREQ);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    const offset = t * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) { re[i] = signal[offset + i] * HANN[i]; im[i] = 0; }
    fft(re, im, false);
    const base = t * N_FREQ;
    for (let f = 0; f < N_FREQ; f++) {
      realFlat[base + f] = re[f];
      imagFlat[base + f] = im[f];
    }
  }
  return { realFlat, imagFlat, nFrames };
}

// ── iSTFT (center=false) ──────────────────────────────────────────────────

/** Inverse STFT for one channel. Overlap-add with COLA normalization. */
function istftChannel(realFlat, imagFlat, nFrames, length) {
  const outLen = (nFrames - 1) * HOP_LENGTH + N_FFT;
  const output = new Float32Array(outLen);
  const windowSum = new Float32Array(outLen);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    const base = t * N_FREQ;
    for (let f = 0; f < N_FREQ; f++) { re[f] = realFlat[base + f]; im[f] = imagFlat[base + f]; }
    for (let f = 1; f < N_FREQ - 1; f++) { re[N_FFT - f] = re[f]; im[N_FFT - f] = -im[f]; }
    fft(re, im, true);
    const offset = t * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) {
      output[offset + i] += re[i] * HANN[i];
      windowSum[offset + i] += HANN[i] * HANN[i];
    }
  }
  for (let i = 0; i < outLen; i++) {
    if (windowSum[i] > 1e-8) output[i] /= windowSum[i];
  }
  return output.subarray(0, length);
}

// ── Worker message handler ────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      vocalsSession = await ort.InferenceSession.create(
        data.vocalsBytes, { executionProviders: ['wasm'] },
      );
      accompSession = await ort.InferenceSession.create(
        data.accompBytes, { executionProviders: ['wasm'] },
      );
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
      const left = new Float32Array(data.leftData);
      const right = new Float32Array(data.rightData);

      const stftL = stftChannel(left);
      const stftR = stftChannel(right);
      const nFrames = stftL.nFrames;

      // Pad frame count to multiple of T_BLOCK (should already be 512 for padded chunks)
      const paddedFrames = Math.ceil(nFrames / T_BLOCK) * T_BLOCK;
      const numSplits = paddedFrames / T_BLOCK;

      // Build magnitude tensor [2, numSplits, T_BLOCK, F_BINS]
      const tensorSize = 2 * paddedFrames * F_BINS;
      const mag = new Float32Array(tensorSize);

      for (let t = 0; t < nFrames; t++) {
        const sBase = t * N_FREQ;
        const mBase = t * F_BINS;
        for (let f = 0; f < F_BINS; f++) {
          const re = stftL.realFlat[sBase + f];
          const im = stftL.imagFlat[sBase + f];
          mag[mBase + f] = Math.sqrt(re * re + im * im);
        }
      }

      const ch1Off = paddedFrames * F_BINS;
      for (let t = 0; t < nFrames; t++) {
        const sBase = t * N_FREQ;
        const mBase = ch1Off + t * F_BINS;
        for (let f = 0; f < F_BINS; f++) {
          const re = stftR.realFlat[sBase + f];
          const im = stftR.imagFlat[sBase + f];
          mag[mBase + f] = Math.sqrt(re * re + im * im);
        }
      }

      // Run both Spleeter models on the same input
      const shape = [2, numSplits, T_BLOCK, F_BINS];
      const inputTensor = new ort.Tensor('float32', mag, shape);
      const vocalsOut = (await vocalsSession.run({ x: inputTensor })).y;
      const accompOut = (await accompSession.run({ x: inputTensor })).y;

      // Wiener soft masking: stem² / (vocals² + accomp² + eps)
      const vData = vocalsOut.data;
      const aData = accompOut.data;
      const vMask = new Float32Array(tensorSize);
      const aMask = new Float32Array(tensorSize);
      for (let i = 0; i < tensorSize; i++) {
        const v2 = vData[i] * vData[i];
        const a2 = aData[i] * aData[i];
        const sum = v2 + a2 + 1e-10;
        vMask[i] = (v2 + 5e-11) / sum;
        aMask[i] = (a2 + 5e-11) / sum;
      }

      // Apply masks to original complex STFT per channel, then iSTFT.
      // Only the first F_BINS (1024) bins get the mask; bins 1024–2048 stay zero.
      const vocalLRe = new Float32Array(nFrames * N_FREQ);
      const vocalLIm = new Float32Array(nFrames * N_FREQ);
      const vocalRRe = new Float32Array(nFrames * N_FREQ);
      const vocalRIm = new Float32Array(nFrames * N_FREQ);
      const instrLRe = new Float32Array(nFrames * N_FREQ);
      const instrLIm = new Float32Array(nFrames * N_FREQ);
      const instrRRe = new Float32Array(nFrames * N_FREQ);
      const instrRIm = new Float32Array(nFrames * N_FREQ);

      for (let t = 0; t < nFrames; t++) {
        const sIdx = t * N_FREQ;
        const mL = t * F_BINS;
        const mR = ch1Off + t * F_BINS;
        for (let f = 0; f < F_BINS; f++) {
          const vm = vMask[mL + f], am = aMask[mL + f];
          vocalLRe[sIdx + f] = vm * stftL.realFlat[sIdx + f];
          vocalLIm[sIdx + f] = vm * stftL.imagFlat[sIdx + f];
          instrLRe[sIdx + f] = am * stftL.realFlat[sIdx + f];
          instrLIm[sIdx + f] = am * stftL.imagFlat[sIdx + f];

          const vmR = vMask[mR + f], amR = aMask[mR + f];
          vocalRRe[sIdx + f] = vmR * stftR.realFlat[sIdx + f];
          vocalRIm[sIdx + f] = vmR * stftR.imagFlat[sIdx + f];
          instrRRe[sIdx + f] = amR * stftR.realFlat[sIdx + f];
          instrRIm[sIdx + f] = amR * stftR.imagFlat[sIdx + f];
        }
      }

      const vocalL = istftChannel(vocalLRe, vocalLIm, nFrames, originalLen);
      const vocalR = istftChannel(vocalRRe, vocalRIm, nFrames, originalLen);
      const instrL = istftChannel(instrLRe, instrLIm, nFrames, originalLen);
      const instrR = istftChannel(instrRRe, instrRIm, nFrames, originalLen);

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
