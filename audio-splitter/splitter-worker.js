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

// ── Pre-computed twiddle factors for radix-2 FFT ────────────────────────────

// Twiddle tables indexed by stage size. twiddleRe[len][j] = cos(2π·j/len), etc.
const twiddleRe = new Map();
const twiddleIm = new Map();
for (let len = 2; len <= N_FFT; len <<= 1) {
  const half = len >> 1;
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  const angle = (-2 * Math.PI) / len;
  for (let j = 0; j < half; j++) {
    re[j] = Math.cos(angle * j);
    im[j] = Math.sin(angle * j);
  }
  twiddleRe.set(len, re);
  twiddleIm.set(len, im);
}
// Inverse twiddles (conjugate sign)
const twiddleReInv = new Map();
const twiddleImInv = new Map();
for (let len = 2; len <= N_FFT; len <<= 1) {
  const half = len >> 1;
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  const angle = (2 * Math.PI) / len;
  for (let j = 0; j < half; j++) {
    re[j] = Math.cos(angle * j);
    im[j] = Math.sin(angle * j);
  }
  twiddleReInv.set(len, re);
  twiddleImInv.set(len, im);
}

// Pre-computed bit-reversal permutation for N_FFT
const bitRev = new Uint32Array(N_FFT);
for (let i = 1, j = 0; i < N_FFT; i++) {
  let bit = N_FFT >> 1;
  while (j & bit) { j ^= bit; bit >>= 1; }
  j ^= bit;
  bitRev[i] = j;
}

// ── Optimized Cooley-Tukey radix-2 FFT ──────────────────────────────────────

function fft(re, im, inverse = false) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1; i < n; i++) {
    const j = bitRev[i];
    if (i < j) {
      const tmpR = re[i]; re[i] = re[j]; re[j] = tmpR;
      const tmpI = im[i]; im[i] = im[j]; im[j] = tmpI;
    }
  }
  const tRe = inverse ? twiddleReInv : twiddleRe;
  const tIm = inverse ? twiddleImInv : twiddleIm;
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const wRe = tRe.get(len);
    const wIm = tIm.get(len);
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < halfLen; j++) {
        const a = i + j, b = a + halfLen;
        const tpRe = wRe[j] * re[b] - wIm[j] * im[b];
        const tpIm = wRe[j] * im[b] + wIm[j] * re[b];
        re[b] = re[a] - tpRe; im[b] = im[a] - tpIm;
        re[a] += tpRe; im[a] += tpIm;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// ── STFT ───────────────────────────────────────────────────────────────────

/**
 * STFT for one channel. Returns flat Float32Array buffers [nFrames × N_FREQ]
 * instead of per-frame arrays to reduce allocation overhead.
 */
function stftChannel(signal) {
  const padLen = N_FFT / 2;
  const padded = new Float32Array(signal.length + 2 * padLen);
  for (let i = 0; i < padLen; i++) padded[i] = signal[padLen - i] || 0;
  padded.set(signal, padLen);
  for (let i = 0; i < padLen; i++) {
    padded[padLen + signal.length + i] = signal[signal.length - 2 - i] || 0;
  }

  const nFrames = Math.floor((padded.length - N_FFT) / HOP_LENGTH) + 1;
  // Flat layout: realFlat[t * N_FREQ + f]
  const realFlat = new Float32Array(nFrames * N_FREQ);
  const imagFlat = new Float32Array(nFrames * N_FREQ);
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    const offset = t * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) { re[i] = padded[offset + i] * HANN[i]; im[i] = 0; }
    fft(re, im, false);
    const base = t * N_FREQ;
    for (let f = 0; f < N_FREQ; f++) {
      realFlat[base + f] = re[f] * NORM_FACTOR;
      imagFlat[base + f] = im[f] * NORM_FACTOR;
    }
  }
  return { realFlat, imagFlat, nFrames };
}

/** Pack stereo STFT into model input shape [1, C=4, F, T]. */
function stft(left, right) {
  const stftL = stftChannel(left);
  const stftR = stftChannel(right);
  const T = stftL.nFrames;
  const data = new Float32Array(4 * N_FREQ * T);
  const s0 = 0, s1 = N_FREQ * T, s2 = 2 * N_FREQ * T, s3 = 3 * N_FREQ * T;
  for (let f = 0; f < N_FREQ; f++) {
    const fT = f * T;
    for (let t = 0; t < T; t++) {
      const tF = t * N_FREQ + f;  // index into flat stft arrays
      data[s0 + fT + t] = stftL.realFlat[tF];
      data[s1 + fT + t] = stftL.imagFlat[tF];
      data[s2 + fT + t] = stftR.realFlat[tF];
      data[s3 + fT + t] = stftR.imagFlat[tF];
    }
  }
  return { data, nFrames: T };
}

// ── iSTFT ──────────────────────────────────────────────────────────────────

/**
 * Inverse STFT for one channel.
 * @param {Float32Array} realFlat - flat [nFrames × N_FREQ] real part
 * @param {Float32Array} imagFlat - flat [nFrames × N_FREQ] imaginary part
 */
function istftChannel(realFlat, imagFlat, nFrames, length) {
  const padLen = N_FFT / 2;
  const outLen = (nFrames - 1) * HOP_LENGTH + N_FFT;
  const output = new Float32Array(outLen);
  const windowSum = new Float32Array(outLen);
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    const base = t * N_FREQ;
    for (let f = 0; f < N_FREQ; f++) {
      re[f] = realFlat[base + f] / NORM_FACTOR;
      im[f] = imagFlat[base + f] / NORM_FACTOR;
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

/**
 * Inverse STFT from model output for a single source (shape [4, F, T]).
 * Unpacks [C=4, F, T] layout to flat [nFrames × N_FREQ] per channel.
 */
function istft(data, nFrames, length) {
  const stride = N_FREQ * nFrames;
  // Unpack from [C, F, T] to flat [T, F] layout for each channel
  const lRe = new Float32Array(nFrames * N_FREQ);
  const lIm = new Float32Array(nFrames * N_FREQ);
  const rRe = new Float32Array(nFrames * N_FREQ);
  const rIm = new Float32Array(nFrames * N_FREQ);
  for (let t = 0; t < nFrames; t++) {
    const tBase = t * N_FREQ;
    for (let f = 0; f < N_FREQ; f++) {
      const idx = f * nFrames + t;
      lRe[tBase + f] = data[idx];
      lIm[tBase + f] = data[stride + idx];
      rRe[tBase + f] = data[2 * stride + idx];
      rIm[tBase + f] = data[3 * stride + idx];
    }
  }
  return {
    left: istftChannel(lRe, lIm, nFrames, length),
    right: istftChannel(rRe, rIm, nFrames, length),
  };
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
