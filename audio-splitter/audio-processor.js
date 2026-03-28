/**
 * Audio processing utilities: FFT, STFT, iSTFT for SCNet source separation.
 *
 * STFT params match SCNet training config:
 *   n_fft=4096, hop_length=1024, win_length=4096, sample_rate=44100, normalized=True
 *
 * The model operates on spectrograms of shape (B, C=4, F=2049, T) where
 * C=4 is [left_real, left_imag, right_real, right_imag].
 */

const SAMPLE_RATE = 44100;
const N_FFT = 4096;
const HOP_LENGTH = 1024;
const WIN_LENGTH = N_FFT;
const N_FREQ = N_FFT / 2 + 1; // 2049

/** Normalization factor matching PyTorch's normalized=True STFT (1/sqrt(n_fft)). */
const NORM_FACTOR = 1 / Math.sqrt(N_FFT);

// ── Hann window (precomputed) ──────────────────────────────────────────────
const HANN = new Float32Array(WIN_LENGTH);
for (let i = 0; i < WIN_LENGTH; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / WIN_LENGTH));
}

// ── Pre-computed twiddle factors for radix-2 FFT ────────────────────────────

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

/**
 * In-place radix-2 FFT with pre-computed twiddle factors.
 * @param {Float32Array} re - Real part (length must be N_FFT)
 * @param {Float32Array} im - Imaginary part
 * @param {boolean} inverse - If true, compute inverse FFT
 */
function fft(re, im, inverse = false) {
  const n = re.length;
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
 * Compute STFT for a single channel. Returns flat Float32Array buffers
 * [nFrames × N_FREQ] to reduce allocation overhead.
 * Applies center padding (reflect) to match PyTorch's center=True default.
 * Results are normalized by 1/sqrt(n_fft) to match PyTorch's normalized=True.
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

/**
 * Compute STFT for stereo audio and pack into SCNet model input format.
 * Output layout: flat array of shape [1, C=4, F=2049, T] in row-major order.
 * C order: [left_real, left_imag, right_real, right_imag]
 */
function stft(left, right) {
  const stftL = stftChannel(left);
  const stftR = stftChannel(right);
  const T = stftL.nFrames;
  const data = new Float32Array(4 * N_FREQ * T);
  const s0 = 0, s1 = N_FREQ * T, s2 = 2 * N_FREQ * T, s3 = 3 * N_FREQ * T;
  for (let f = 0; f < N_FREQ; f++) {
    const fT = f * T;
    for (let t = 0; t < T; t++) {
      const tF = t * N_FREQ + f;
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
 * Inverse STFT for a single channel.
 * @param {Float32Array} realFlat - Flat [nFrames × N_FREQ] real part
 * @param {Float32Array} imagFlat - Flat [nFrames × N_FREQ] imaginary part
 * @param {number} nFrames - Number of time frames
 * @param {number} length - Expected output signal length
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
 * Inverse STFT from model output for a single source.
 * Unpacks [C=4, F, T] layout to flat [nFrames × N_FREQ] per channel.
 */
function istft(data, nFrames, length) {
  const stride = N_FREQ * nFrames;
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

// ── Audio decoding & resampling ────────────────────────────────────────────

/**
 * Decode an audio file to stereo Float32Arrays at 44100Hz.
 * @param {ArrayBuffer} buffer - Raw file bytes
 * @returns {Promise<{ left: Float32Array, right: Float32Array, duration: number }>}
 */
async function decodeAudio(buffer) {
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(buffer);

  const numSamples = Math.round(decoded.duration * SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(2, numSamples, SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();

  const rendered = await offlineCtx.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.numberOfChannels > 1
    ? rendered.getChannelData(1)
    : new Float32Array(left);

  return { left, right, duration: rendered.duration };
}

/**
 * Encode stereo Float32Arrays to a WAV blob.
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @returns {Blob}
 */
function encodeWav(left, right) {
  const numSamples = left.length;
  const numChannels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;
  const buf = new ArrayBuffer(bufferSize);
  const view = new DataView(buf);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const lSample = Math.max(-1, Math.min(1, left[i]));
    const rSample = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, lSample * 0x7FFF, true);
    view.setInt16(offset + 2, rSample * 0x7FFF, true);
    offset += 4;
  }

  return new Blob([buf], { type: 'audio/wav' });
}

export {
  SAMPLE_RATE, N_FFT, HOP_LENGTH, N_FREQ,
  fft, stft, istft, stftChannel, istftChannel,
  decodeAudio, encodeWav,
};
