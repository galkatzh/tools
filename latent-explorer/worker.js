/**
 * Web Worker: ONNX inference for the Stable Audio latent explorer.
 *
 * Two selectable autoencoders (audio ⇄ latent, both stereo 44.1 kHz, 256-dim
 * latents at 44100/4096 ≈ 10.77 Hz):
 *
 *  - medium: SAME-L from stabilityai/stable-audio-3-medium, converted to ONNX
 *    (int4 MatMulNBits) in this repo. Dynamic length: audio (1,2,4096·L) ⇄
 *    latent (1,256,L). Served as <100 MB chunks beside this file.
 *  - morph: shoegazerstella/stable-audio-morph-onnx (SAME-S fp16, from
 *    stable-audio-3-small-music). Fixed shapes: 441000 samples ⇄ 108 frames.
 *
 * Messages in:  {type:'load', model, ep}
 *               {type:'encode', id, left, right}
 *               {type:'decode', id, latents, frames}   latents: Float32Array(256·frames)
 * Messages out: {type:'progress', frac, text}
 *               {type:'loaded', model, backend, fixedFrames}
 *               {type:'encoded', id, latents, frames}
 *               {type:'decoded', id, left, right, ms}
 *               {type:'error', id?, message}
 */

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.all.bundle.min.mjs';

// Surface anything that escapes a try/catch (fail loudly).
self.addEventListener('error', (e) =>
  self.postMessage({ type: 'error', message: e.message || 'Worker failed to load (check your network connection).' }));
self.addEventListener('unhandledrejection', (e) =>
  self.postMessage({ type: 'error', message: `Unhandled rejection: ${e.reason?.message || e.reason}` }));

const HOP = 4096;              // audio samples per latent frame
const C = 256;                 // latent channels

// The medium model ships beside this file in 24 MiB chunks (Cloudflare Pages
// rejects files over 25 MiB); they're reassembled before session creation.
const mediumChunks = (part) =>
  Array.from({ length: 11 }, (_, i) => `models/same_l_${part}_q4.onnx.${String(i).padStart(2, '0')}`);

const MODELS = {
  medium: {
    label: 'SAME-L (stable-audio-3-medium, int4)',
    encoder: mediumChunks('encoder'),
    decoder: mediumChunks('decoder'),
    totalBytes: 537_321_180,
    fixedFrames: 0,            // dynamic length
  },
  morph: {
    label: 'SAME-S (stable-audio-morph-onnx, fp16)',
    encoder: ['https://huggingface.co/shoegazerstella/stable-audio-morph-onnx/resolve/main/encoder_fp16.onnx'],
    decoder: ['https://huggingface.co/shoegazerstella/stable-audio-morph-onnx/resolve/main/decoder_fp16.onnx'],
    totalBytes: 219_594_401,
    fixedFrames: 108,          // both graphs are fixed 10 s windows
    encSamples: 441000,
  },
};

const CACHE_NAME = 'latent-explorer-models-v1';

let sessions = null;           // { encoder, decoder }
let current = null;            // MODELS[...] of the loaded model

/** Fetch `url` as bytes, via Cache Storage, streaming progress through onChunk. */
async function fetchCached(url, onChunk) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    onChunk(buf.byteLength);
    return new Uint8Array(buf);
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed for ${url}: ${resp.status} ${resp.statusText}`);
  const reader = resp.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onChunk(value.length);
  }
  const bytes = new Uint8Array(received);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  return bytes;
}

/** Download (possibly chunked) model bytes and reassemble. */
async function fetchModel(paths, onChunk) {
  const chunks = [];
  for (const p of paths) chunks.push(await fetchCached(new URL(p, self.location.href).href, onChunk));
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return bytes;
}

async function createSession(bytes, ep) {
  if (ep !== 'wasm') {
    try {
      const s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu', 'wasm'] });
      return { session: s, backend: 'webgpu' };
    } catch (err) {
      if (ep === 'webgpu') throw err;
      console.error('WebGPU session failed, falling back to WASM:', err);
    }
  }
  return { session: await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }), backend: 'wasm' };
}

async function load({ model, ep }) {
  const cfg = MODELS[model];
  if (!cfg) throw new Error(`Unknown model "${model}"`);
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.simd = true;

  let done = 0;
  const onChunk = (n) => {
    done += n;
    self.postMessage({ type: 'progress', frac: Math.min(done / cfg.totalBytes, 0.98),
      text: `Downloading ${cfg.label}… ${(done / 1e6).toFixed(0)} / ${(cfg.totalBytes / 1e6).toFixed(0)} MB` });
  };

  sessions = null;
  current = null;
  let backend = 'wasm';
  const next = {};
  for (const part of ['encoder', 'decoder']) {
    const bytes = await fetchModel(cfg[part], onChunk);
    self.postMessage({ type: 'progress', frac: 0.99, text: `Initializing ${part}…` });
    const r = await createSession(bytes, ep);
    next[part] = r.session;
    backend = r.backend;
  }
  sessions = next;
  current = cfg;
  self.postMessage({ type: 'progress', frac: 1, text: `Model ready (${backend})` });
  self.postMessage({ type: 'loaded', model, backend, fixedFrames: cfg.fixedFrames });
}

/** Encode stereo PCM → latents. Pads to the model's required length. */
async function encode({ id, left, right }) {
  if (!sessions) throw new Error('Model not loaded yet');
  const nReal = left.length;
  const nPad = current.fixedFrames
    ? current.encSamples
    : Math.ceil(nReal / HOP) * HOP;
  // Fixed-shape models take exactly encSamples; anything beyond is trimmed
  // (the UI already caps clips to the model's window, modulo ~31 ms rounding).
  const buf = new Float32Array(2 * nPad);
  buf.set(left.subarray(0, Math.min(nReal, nPad)), 0);
  buf.set(right.subarray(0, Math.min(nReal, nPad)), nPad);
  const t0 = performance.now();
  const { latent } = await sessions.encoder.run({ audio: new ort.Tensor('float32', buf, [1, 2, nPad]) });
  // Keep only frames that cover real audio.
  const framesAll = latent.dims[2];
  const frames = Math.min(framesAll, Math.max(1, Math.round(nReal / HOP)));
  // (1, 256, F_all) → (256, frames), channel-major
  const out = new Float32Array(C * frames);
  const data = latent.data;
  for (let c = 0; c < C; c++) out.set(data.subarray(c * framesAll, c * framesAll + frames), c * frames);
  self.postMessage({ type: 'encoded', id, latents: out, frames, ms: performance.now() - t0 }, [out.buffer]);
}

/** Decode latents (256·frames, channel-major) → stereo PCM. */
async function decode({ id, latents, frames }) {
  if (!sessions) throw new Error('Model not loaded yet');
  const fixed = current.fixedFrames;
  let input = latents, F = frames;
  if (fixed) {
    // Fixed-shape decoder: zero-pad the tail (≈ silence in softnorm space), trim after.
    if (frames > fixed) throw new Error(`Too many frames for this model (max ${fixed})`);
    F = fixed;
    input = new Float32Array(C * fixed);
    for (let c = 0; c < C; c++) input.set(latents.subarray(c * frames, (c + 1) * frames), c * fixed);
  }
  const t0 = performance.now();
  const { audio } = await sessions.decoder.run({ latent: new ort.Tensor('float32', input, [1, C, F]) });
  const ms = performance.now() - t0;
  const chan = audio.dims[2];
  const wanted = Math.min(frames * HOP, chan);
  const left = new Float32Array(wanted);
  const right = new Float32Array(wanted);
  for (let i = 0; i < wanted; i++) {
    left[i] = Math.max(-1, Math.min(1, audio.data[i]));
    right[i] = Math.max(-1, Math.min(1, audio.data[chan + i]));
  }
  self.postMessage({ type: 'decoded', id, left, right, ms }, [left.buffer, right.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data);
    else if (data.type === 'encode') await encode(data);
    else if (data.type === 'decode') await decode(data);
  } catch (err) {
    console.error('[worker]', err);
    self.postMessage({ type: 'error', id: data.id, message: err.message });
  }
};
