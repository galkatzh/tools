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

// ── Cooley-Tukey radix-2 FFT ───────────────────────────────────────────────

/**
 * In-place radix-2 FFT. Arrays `re` and `im` are modified in place.
 * @param {Float32Array} re - Real part (length must be power of 2)
 * @param {Float32Array} im - Imaginary part
 * @param {boolean} inverse - If true, compute inverse FFT
 */
function fft(re, im, inverse = false) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
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
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const a = i + j;
        const b = a + halfLen;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// ── STFT ───────────────────────────────────────────────────────────────────

/**
 * Compute Short-Time Fourier Transform for a single channel.
 * Applies center padding (reflect) to match PyTorch's center=True default.
 * Results are normalized by 1/sqrt(n_fft) to match PyTorch's normalized=True.
 * @param {Float32Array} signal - Mono audio signal
 * @returns {{ real: Float32Array[], imag: Float32Array[] }}
 *   Arrays of length nFrames, each containing N_FREQ frequency bins.
 */
function stftChannel(signal) {
  const padLen = N_FFT / 2;
  const padded = new Float32Array(signal.length + 2 * padLen);
  // Reflect padding
  for (let i = 0; i < padLen; i++) {
    padded[i] = signal[padLen - i] || 0;
  }
  padded.set(signal, padLen);
  for (let i = 0; i < padLen; i++) {
    padded[padLen + signal.length + i] = signal[signal.length - 2 - i] || 0;
  }

  const nFrames = Math.floor((padded.length - N_FFT) / HOP_LENGTH) + 1;
  const real = [];
  const imag = [];

  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    const offset = t * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = padded[offset + i] * HANN[i];
      im[i] = 0;
    }
    fft(re, im, false);

    const frameRe = new Float32Array(N_FREQ);
    const frameIm = new Float32Array(N_FREQ);
    for (let f = 0; f < N_FREQ; f++) {
      frameRe[f] = re[f] * NORM_FACTOR;
      frameIm[f] = im[f] * NORM_FACTOR;
    }
    real.push(frameRe);
    imag.push(frameIm);
  }

  return { real, imag };
}

/**
 * Compute STFT for stereo audio and pack into SCNet model input format.
 * Output layout: flat array of shape [1, C=4, F=2049, T] in row-major order.
 * C order: [left_real, left_imag, right_real, right_imag]
 *
 * This matches the official SCNet code's STFT → reshape step:
 *   view_as_real → permute(0,3,1,2) → reshape(B, 4, Fr, T)
 *
 * @param {Float32Array} left - Left channel
 * @param {Float32Array} right - Right channel
 * @returns {{ data: Float32Array, nFrames: number }}
 */
function stft(left, right) {
  const stftL = stftChannel(left);
  const stftR = stftChannel(right);
  const T = stftL.real.length;

  // Pack into [C=4, F, T] row-major
  const data = new Float32Array(4 * N_FREQ * T);
  for (let f = 0; f < N_FREQ; f++) {
    for (let t = 0; t < T; t++) {
      const idx = f * T + t;
      data[0 * N_FREQ * T + idx] = stftL.real[t][f]; // left real
      data[1 * N_FREQ * T + idx] = stftL.imag[t][f]; // left imag
      data[2 * N_FREQ * T + idx] = stftR.real[t][f]; // right real
      data[3 * N_FREQ * T + idx] = stftR.imag[t][f]; // right imag
    }
  }

  return { data, nFrames: T };
}

// ── iSTFT ──────────────────────────────────────────────────────────────────

/**
 * Inverse STFT for a single channel.
 * Undoes the normalization and reconstructs via overlap-add.
 * @param {Float32Array[]} real - Array of nFrames, each N_FREQ bins (normalized)
 * @param {Float32Array[]} imag - Array of nFrames, each N_FREQ bins (normalized)
 * @param {number} length - Expected output signal length
 * @returns {Float32Array} Reconstructed time-domain signal
 */
function istftChannel(real, imag, length) {
  const nFrames = real.length;
  const padLen = N_FFT / 2;
  const outLen = (nFrames - 1) * HOP_LENGTH + N_FFT;
  const output = new Float32Array(outLen);
  const windowSum = new Float32Array(outLen);

  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    // Undo normalization and reconstruct full spectrum (Hermitian symmetry)
    for (let f = 0; f < N_FREQ; f++) {
      re[f] = real[t][f] / NORM_FACTOR;
      im[f] = imag[t][f] / NORM_FACTOR;
    }
    for (let f = 1; f < N_FREQ - 1; f++) {
      re[N_FFT - f] = re[f];
      im[N_FFT - f] = -im[f];
    }

    fft(re, im, true);

    const offset = t * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) {
      output[offset + i] += re[i] * HANN[i];
      windowSum[offset + i] += HANN[i] * HANN[i];
    }
  }

  // Normalize by window sum (COLA condition)
  for (let i = 0; i < outLen; i++) {
    if (windowSum[i] > 1e-8) {
      output[i] /= windowSum[i];
    }
  }

  return output.subarray(padLen, padLen + length);
}

/**
 * Inverse STFT from model output for a single source.
 * Input layout: flat array of shape [C=4, F, T] row-major.
 * C order: [left_real, left_imag, right_real, right_imag]
 *
 * @param {Float32Array} data - Flat array for one source, shape [4, F, T]
 * @param {number} nFrames - Number of time frames (T)
 * @param {number} length - Expected output signal length per channel
 * @returns {{ left: Float32Array, right: Float32Array }}
 */
function istft(data, nFrames, length) {
  const stride = N_FREQ * nFrames;
  const lReal = [], lImag = [], rReal = [], rImag = [];

  for (let t = 0; t < nFrames; t++) {
    const lr = new Float32Array(N_FREQ);
    const li = new Float32Array(N_FREQ);
    const rr = new Float32Array(N_FREQ);
    const ri = new Float32Array(N_FREQ);
    for (let f = 0; f < N_FREQ; f++) {
      const idx = f * nFrames + t;
      lr[f] = data[0 * stride + idx];
      li[f] = data[1 * stride + idx];
      rr[f] = data[2 * stride + idx];
      ri[f] = data[3 * stride + idx];
    }
    lReal.push(lr);
    lImag.push(li);
    rReal.push(rr);
    rImag.push(ri);
  }

  return {
    left: istftChannel(lReal, lImag, length),
    right: istftChannel(rReal, rImag, length),
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
