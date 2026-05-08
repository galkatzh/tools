/**
 * Benchmark variant of the Spleeter worker.
 *
 * Runs the same STFT → ONNX → Wiener mask → iSTFT pipeline as the karaoke
 * app, but emits per-phase wall-time measurements per chunk and (optionally)
 * collects ORT's op-level profile by enabling `enableProfiling` on each
 * InferenceSession.
 *
 * Messages in:
 *   { type: 'init', vocalsBytes, accompBytes, profile?: boolean }
 *   { type: 'process', chunkIdx, leftData, rightData, originalLen }
 *   { type: 'endProfiling' }              // dump ORT profile filenames
 *
 * Messages out:
 *   { type: 'ready', timings: { vocalsLoadMs, accompLoadMs } }
 *   { type: 'result', chunkIdx, phases: { stft, magnitude, vocalsRun, accompRun, wiener, applyMask, istft, total } }
 *   { type: 'profile', vocalsProfile?, accompProfile?, message? }
 *   { type: 'error', chunkIdx?, message }
 */

import { N_FFT, HOP_LENGTH, N_FREQ, fft } from '../audio-splitter/audio-processor.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.mjs';

const F_BINS = 1024;
const T_BLOCK = 512;

const HANN = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N_FFT));

let vocalsSession = null;
let accompSession = null;

/** Same STFT (center=false, no normalization) as karaoke's spleeter-worker. */
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

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;

      const opts = { executionProviders: ['wasm'] };
      if (data.profile) opts.enableProfiling = true;

      const t0 = performance.now();
      vocalsSession = await ort.InferenceSession.create(data.vocalsBytes, opts);
      const vocalsLoadMs = performance.now() - t0;

      const t1 = performance.now();
      accompSession = await ort.InferenceSession.create(data.accompBytes, opts);
      const accompLoadMs = performance.now() - t1;

      self.postMessage({ type: 'ready', timings: { vocalsLoadMs, accompLoadMs } });
      return;
    }

    if (data.type === 'process') {
      const { chunkIdx, originalLen } = data;
      const left = new Float32Array(data.leftData);
      const right = new Float32Array(data.rightData);
      const phases = {};
      const tStart = performance.now();

      // ── STFT ────────────────────────────────────────────────────
      let t = performance.now();
      const stftL = stftChannel(left);
      const stftR = stftChannel(right);
      phases.stft = performance.now() - t;
      const nFrames = stftL.nFrames;

      const paddedFrames = Math.ceil(nFrames / T_BLOCK) * T_BLOCK;
      const numSplits = paddedFrames / T_BLOCK;

      // ── Magnitude tensor build ──────────────────────────────────
      t = performance.now();
      const tensorSize = 2 * paddedFrames * F_BINS;
      const mag = new Float32Array(tensorSize);
      for (let tf = 0; tf < nFrames; tf++) {
        const sBase = tf * N_FREQ;
        const mBase = tf * F_BINS;
        for (let f = 0; f < F_BINS; f++) {
          const re = stftL.realFlat[sBase + f];
          const im = stftL.imagFlat[sBase + f];
          mag[mBase + f] = Math.sqrt(re * re + im * im);
        }
      }
      const ch1Off = paddedFrames * F_BINS;
      for (let tf = 0; tf < nFrames; tf++) {
        const sBase = tf * N_FREQ;
        const mBase = ch1Off + tf * F_BINS;
        for (let f = 0; f < F_BINS; f++) {
          const re = stftR.realFlat[sBase + f];
          const im = stftR.imagFlat[sBase + f];
          mag[mBase + f] = Math.sqrt(re * re + im * im);
        }
      }
      phases.magnitude = performance.now() - t;

      // ── Inference ───────────────────────────────────────────────
      const shape = [2, numSplits, T_BLOCK, F_BINS];
      const inputTensor = new ort.Tensor('float32', mag, shape);

      t = performance.now();
      const vocalsOut = (await vocalsSession.run({ x: inputTensor })).y;
      phases.vocalsRun = performance.now() - t;

      t = performance.now();
      const accompOut = (await accompSession.run({ x: inputTensor })).y;
      phases.accompRun = performance.now() - t;

      // ── Wiener masking ──────────────────────────────────────────
      t = performance.now();
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
      phases.wiener = performance.now() - t;

      // ── Apply mask to complex STFT ──────────────────────────────
      t = performance.now();
      const vLRe = new Float32Array(nFrames * N_FREQ);
      const vLIm = new Float32Array(nFrames * N_FREQ);
      const vRRe = new Float32Array(nFrames * N_FREQ);
      const vRIm = new Float32Array(nFrames * N_FREQ);
      const iLRe = new Float32Array(nFrames * N_FREQ);
      const iLIm = new Float32Array(nFrames * N_FREQ);
      const iRRe = new Float32Array(nFrames * N_FREQ);
      const iRIm = new Float32Array(nFrames * N_FREQ);
      for (let tf = 0; tf < nFrames; tf++) {
        const sIdx = tf * N_FREQ;
        const mL = tf * F_BINS;
        const mR = ch1Off + tf * F_BINS;
        for (let f = 0; f < F_BINS; f++) {
          const vm = vMask[mL + f], am = aMask[mL + f];
          vLRe[sIdx + f] = vm * stftL.realFlat[sIdx + f];
          vLIm[sIdx + f] = vm * stftL.imagFlat[sIdx + f];
          iLRe[sIdx + f] = am * stftL.realFlat[sIdx + f];
          iLIm[sIdx + f] = am * stftL.imagFlat[sIdx + f];
          const vmR = vMask[mR + f], amR = aMask[mR + f];
          vRRe[sIdx + f] = vmR * stftR.realFlat[sIdx + f];
          vRIm[sIdx + f] = vmR * stftR.imagFlat[sIdx + f];
          iRRe[sIdx + f] = amR * stftR.realFlat[sIdx + f];
          iRIm[sIdx + f] = amR * stftR.imagFlat[sIdx + f];
        }
      }
      phases.applyMask = performance.now() - t;

      // ── iSTFT (4 channels) ──────────────────────────────────────
      t = performance.now();
      istftChannel(vLRe, vLIm, nFrames, originalLen);
      istftChannel(vRRe, vRIm, nFrames, originalLen);
      istftChannel(iLRe, iLIm, nFrames, originalLen);
      istftChannel(iRRe, iRIm, nFrames, originalLen);
      phases.istft = performance.now() - t;

      phases.total = performance.now() - tStart;
      self.postMessage({ type: 'result', chunkIdx, phases });
      return;
    }

    if (data.type === 'endProfiling') {
      // ORT-web writes profile data into a virtual file; endProfiling()
      // returns the filename. The actual JSON isn't trivially readable
      // back from the WASM FS, but the call ensures profiling data was
      // collected and the filename surfaced in console (visible in DevTools).
      const vocalsProfile = vocalsSession ? await vocalsSession.endProfiling() : null;
      const accompProfile = accompSession ? await accompSession.endProfiling() : null;
      self.postMessage({ type: 'profile', vocalsProfile, accompProfile });
      return;
    }
  } catch (err) {
    console.error('[spleeter-bench-worker]', err);
    self.postMessage({ type: 'error', chunkIdx: data.chunkIdx, message: err.message });
  }
};
