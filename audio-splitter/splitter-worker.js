/**
 * Web Worker (classic, not module): runs STFT → ONNX inference → iSTFT for one audio chunk.
 * Uses importScripts for ORT so it works cross-browser without COEP headers.
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

/* globals ort */
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.webgpu.min.js');

// ── Audio processing constants (must match audio-processor.js) ──────────────

const N_FFT      = 4096;
const HOP_LENGTH = 1024;
const N_FREQ     = N_FFT / 2 + 1; // 2049
const NORM_FACTOR = 1 / Math.sqrt(N_FFT);

const HANN = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N_FFT));
}

// ── Cooley-Tukey radix-2 FFT ───────────────────────────────────────────────

function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const a = i + j, b = a + halfLen;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) { for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}

// ── STFT ───────────────────────────────────────────────────────────────────

function stftChannel(signal) {
  const padLen = N_FFT / 2;
  const padded = new Float32Array(signal.length + 2 * padLen);
  for (let i = 0; i < padLen; i++) padded[i] = signal[padLen - i] || 0;
  padded.set(signal, padLen);
  for (let i = 0; i < padLen; i++) {
    padded[padLen + signal.length + i] = signal[signal.length - 2 - i] || 0;
  }

  const nFrames = Math.floor((padded.length - N_FFT) / HOP_LENGTH) + 1;
  const real = [], imag = [];
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    const offset = t * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) { re[i] = padded[offset + i] * HANN[i]; im[i] = 0; }
    fft(re, im, false);
    const frameRe = new Float32Array(N_FREQ), frameIm = new Float32Array(N_FREQ);
    for (let f = 0; f < N_FREQ; f++) {
      frameRe[f] = re[f] * NORM_FACTOR;
      frameIm[f] = im[f] * NORM_FACTOR;
    }
    real.push(frameRe); imag.push(frameIm);
  }
  return { real, imag };
}

/** Pack stereo STFT into model input shape [1, C=4, F, T]. */
function stft(left, right) {
  const stftL = stftChannel(left);
  const stftR = stftChannel(right);
  const T = stftL.real.length;
  const data = new Float32Array(4 * N_FREQ * T);
  for (let f = 0; f < N_FREQ; f++) {
    for (let t = 0; t < T; t++) {
      const idx = f * T + t;
      data[0 * N_FREQ * T + idx] = stftL.real[t][f];
      data[1 * N_FREQ * T + idx] = stftL.imag[t][f];
      data[2 * N_FREQ * T + idx] = stftR.real[t][f];
      data[3 * N_FREQ * T + idx] = stftR.imag[t][f];
    }
  }
  return { data, nFrames: T };
}

// ── iSTFT ──────────────────────────────────────────────────────────────────

function istftChannel(real, imag, length) {
  const nFrames = real.length;
  const padLen = N_FFT / 2;
  const outLen = (nFrames - 1) * HOP_LENGTH + N_FFT;
  const output = new Float32Array(outLen);
  const windowSum = new Float32Array(outLen);
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    for (let f = 0; f < N_FREQ; f++) {
      re[f] = real[t][f] / NORM_FACTOR;
      im[f] = imag[t][f] / NORM_FACTOR;
    }
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
  return output.subarray(padLen, padLen + length);
}

/** Inverse STFT from model output for a single source (shape [4, F, T]). */
function istft(data, nFrames, length) {
  const stride = N_FREQ * nFrames;
  const lReal = [], lImag = [], rReal = [], rImag = [];
  for (let t = 0; t < nFrames; t++) {
    const lr = new Float32Array(N_FREQ), li = new Float32Array(N_FREQ);
    const rr = new Float32Array(N_FREQ), ri = new Float32Array(N_FREQ);
    for (let f = 0; f < N_FREQ; f++) {
      const idx = f * nFrames + t;
      lr[f] = data[0 * stride + idx]; li[f] = data[1 * stride + idx];
      rr[f] = data[2 * stride + idx]; ri[f] = data[3 * stride + idx];
    }
    lReal.push(lr); lImag.push(li); rReal.push(rr); rImag.push(ri);
  }
  return { left: istftChannel(lReal, lImag, length), right: istftChannel(rReal, rImag, length) };
}

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
      const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
      session = await ort.InferenceSession.create(data.modelBytes, { executionProviders: providers });
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
