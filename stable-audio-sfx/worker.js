/**
 * Web Worker (module): text-to-sound-effect pipeline for stable-audio-3-small-sfx.
 *
 *   tokenizer → text_encoder → number_conditioner → pingpong diffusion (DiT) → decoder → PCM
 *
 * The SFX model shares its T5Gemma text encoder and autoencoder/decoder with the music model,
 * so those graphs are reused from lsb/stable-audio-3-small-music-onnx (and share the browser
 * cache with the stable-audio-small app). Only the SFX-specific DiT + number conditioner come
 * from bgkb/encoder-onnx/sfx. The heavy DiT + decoder run on the WebGPU execution provider
 * when available (falling back to WASM); the one-shot text encoding stays on WASM.
 *
 * Messages in:   { type:'load' }   { type:'generate', prompt, seconds, steps, seed }
 * Messages out:  { type:'progress', stage, frac, text }  { type:'loaded', backend }
 *                { type:'result', left, right, seconds }  { type:'error', message }
 */

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.all.bundle.min.mjs';
import { PreTrainedTokenizer } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

self.addEventListener('error', (e) =>
  self.postMessage({ type: 'error', message: e.message || 'Worker failed to load (check your network connection).' }));
self.addEventListener('unhandledrejection', (e) =>
  self.postMessage({ type: 'error', message: `Unhandled rejection: ${e.reason?.message || e.reason}` }));

// ── Sources ──────────────────────────────────────────────────────────────────

const LSB = 'https://huggingface.co/lsb/stable-audio-3-small-music-onnx/resolve/main';
const SFX = 'https://huggingface.co/bgkb/encoder-onnx/resolve/main/sfx';
const CACHE_NAME = 'stable-audio-onnx-v1';   // shared with stable-audio-small (reused weights)

const SAMPLE_RATE = 44100, AUDIO_ALIGN = 8192, IO_CHANNELS = 256;
const COND_LEN = 257, TEXT_MAX = 256, HEADROOM_SEC = 6, H = 768;
const LOGSNR_START = -6.2, LOGSNR_END = 2.0;

/** path = ONNX external-data location baked in the graph; url = where to fetch it. */
const ext = (base, name) => ({ path: name, url: `${base}/${name}` });
const GRAPHS = {
  text_encoder: { graph: `${LSB}/onnx/text_encoder_q4.onnx`, gpu: false,
    ext: ['text_encoder_q4_chunk_0.data', 'text_encoder_q4_chunk_1.data', 'text_encoder_q4_chunk_2.data'].map((n) => ext(`${LSB}/onnx`, n)) },
  number_conditioner: { graph: `${SFX}/number_conditioner.onnx`, gpu: false, ext: [] },
  dit: { graph: `${SFX}/dit_q4.onnx`, gpu: true, ext: [ext(SFX, 'dit_q4.data')] },
  decoder: { graph: `${LSB}/onnx/decoder_q4.onnx`, gpu: true, ext: [ext(`${LSB}/onnx`, 'decoder_q4_chunk_0.data')] },
};
const TOTAL_BYTES = 617_000_000;

// ── State ────────────────────────────────────────────────────────────────────

let tokenizer = null;
let paddingEmbedding = null;     // Float32Array(768): SFX learned pad vector
const sessions = {};
let backend = 'wasm';
let useGpu = false;     // set in load() after confirming a real WebGPU adapter exists

// ── Cached download ──────────────────────────────────────────────────────────

async function fetchCached(url, onChunk) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) { const b = await hit.arrayBuffer(); onChunk(b.byteLength); return new Uint8Array(b); }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed for ${url}: ${resp.status} ${resp.statusText}`);
  const reader = resp.body.getReader();
  const parts = []; let received = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); received += value.length; onChunk(value.length); }
  const bytes = new Uint8Array(received);
  let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; }
  // Caching is an optimization — a quota/write failure must not abort generation.
  try {
    await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  } catch (e) {
    console.error('Cache write failed (continuing without caching this file):', url, e);
  }
  return bytes;
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** Create a session, trying WebGPU for the heavy graphs and falling back to WASM. */
async function makeSession(bytes, externalData, gpu) {
  if (gpu && useGpu) {
    try {
      const s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu', 'wasm'], externalData });
      backend = 'webgpu';
      return s;
    } catch (e) {
      console.warn('WebGPU session failed, falling back to WASM:', e);
    }
  }
  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], externalData });
}

async function load() {
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.simd = true;

  // Use WebGPU for the heavy graphs only if a real adapter is available.
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try { useGpu = !!(await navigator.gpu.requestAdapter()); } catch (e) { console.warn('WebGPU adapter check failed:', e); }
  }

  let done = 0;
  const onChunk = (n) => {
    done += n;
    self.postMessage({ type: 'progress', stage: 'load', frac: Math.min(done / TOTAL_BYTES, 0.99),
      text: `Downloading model… ${(done / 1e6).toFixed(0)} / ${(TOTAL_BYTES / 1e6).toFixed(0)} MB` });
  };
  const asJson = (b) => JSON.parse(new TextDecoder().decode(b));

  self.postMessage({ type: 'progress', stage: 'load', frac: 0, text: 'Loading tokenizer…' });
  const [tjson, tcfg, pad] = await Promise.all([
    fetchCached(`${LSB}/tokenizer/tokenizer.json`, onChunk).then(asJson),
    fetchCached(`${LSB}/tokenizer/tokenizer_config.json`, onChunk).then(asJson),
    fetchCached(`${SFX}/padding_embedding.json`, onChunk).then(asJson),
  ]);
  tokenizer = new PreTrainedTokenizer(tjson, tcfg);
  paddingEmbedding = Float32Array.from(pad);

  for (const [key, g] of Object.entries(GRAPHS)) {
    const modelBytes = await fetchCached(g.graph, onChunk);
    const externalData = [];
    for (const e of g.ext) externalData.push({ path: e.path, data: await fetchCached(e.url, onChunk) });
    self.postMessage({ type: 'progress', stage: 'load', frac: Math.min(done / TOTAL_BYTES, 0.99), text: `Initializing ${key}…` });
    sessions[key] = await makeSession(modelBytes, externalData, g.gpu);
  }

  self.postMessage({ type: 'progress', stage: 'load', frac: 1, text: `Model ready (${backend})` });
  self.postMessage({ type: 'loaded', backend });
}

// ── Seeded RNG + schedule (identical to the music model's sampler) ───────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function fillGaussian(arr, rand) {
  for (let i = 0; i < arr.length; i += 2) {
    const u1 = Math.max(rand(), 1e-12), u2 = rand(), r = Math.sqrt(-2 * Math.log(u1));
    arr[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < arr.length) arr[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
}
function buildSchedule(steps) {
  const sig = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const tau = 1 - i / steps;
    sig[i] = 1 / (1 + Math.exp(LOGSNR_END - tau * (LOGSNR_END - LOGSNR_START)));
  }
  sig[0] = 1.0; sig[steps] = 0.0;
  return sig;
}

// ── Generation ───────────────────────────────────────────────────────────────

async function generate({ prompt, seconds, steps, seed }) {
  const tLat = Math.ceil((seconds + HEADROOM_SEC) * SAMPLE_RATE / AUDIO_ALIGN) * 2;
  const latLen = IO_CHANNELS * tLat;
  const t0 = performance.now();

  // 1. Tokenize.
  self.postMessage({ type: 'progress', stage: 'gen', frac: 0, text: 'Encoding prompt…' });
  const enc = tokenizer(prompt, { padding: 'max_length', max_length: TEXT_MAX, truncation: true, return_tensor: false });
  const flat = (a) => (Array.isArray(a[0]) ? a[0] : a);
  const idsArr = flat(enc.input_ids), maskArr = flat(enc.attention_mask);
  const nReal = maskArr.reduce((s, m) => s + Number(m), 0);
  const inputIds = BigInt64Array.from(idsArr, (x) => BigInt(x));
  const attnMask = BigInt64Array.from(maskArr, (x) => BigInt(x));

  // 2. Text encoder (shared T5Gemma), then overwrite padded rows with the SFX learned
  //    padding vector — the conditioner replaces pad positions with this, and it is the one
  //    SFX-specific piece of the (otherwise shared) text path.
  const { last_hidden_state } = await sessions.text_encoder.run({
    input_ids: new ort.Tensor('int64', inputIds, [1, TEXT_MAX]),
    attention_mask: new ort.Tensor('int64', attnMask, [1, TEXT_MAX]),
  });
  const text = Float32Array.from(last_hidden_state.data);
  for (let i = nReal; i < TEXT_MAX; i++) text.set(paddingEmbedding, i * H);

  // 3. Duration embedding.
  const { embedding } = await sessions.number_conditioner.run({
    seconds: new ort.Tensor('float32', Float32Array.from([seconds]), [1]),
  });

  // 4. Assemble conditioning: cross = [text(256); duration(1)], global = duration.
  const cross = new Float32Array(COND_LEN * H);
  cross.set(text, 0);
  cross.set(embedding.data, TEXT_MAX * H);
  const crossT = new ort.Tensor('float32', cross, [1, COND_LEN, H]);
  const globalT = new ort.Tensor('float32', embedding.data.slice(0, H), [1, H]);
  const localT = new ort.Tensor('float32', new Float32Array(COND_LEN * tLat), [1, COND_LEN, tLat]);
  const maskT = new ort.Tensor('bool', new Uint8Array(tLat).fill(1), [1, tLat]);

  // 5. Pingpong sampler.
  const rand = mulberry32(seed);
  const x = new Float32Array(latLen);
  fillGaussian(x, rand);
  const noise = new Float32Array(latLen);
  const sig = buildSchedule(steps);
  for (let s = 0; s < steps; s++) {
    const tc = sig[s], tn = sig[s + 1];
    const { out } = await sessions.dit.run({
      x: new ort.Tensor('float32', x, [1, IO_CHANNELS, tLat]),
      t: new ort.Tensor('float32', Float32Array.from([tc]), [1]),
      cross_attn_cond: crossT, global_embed: globalT, local_add_cond: localT, padding_mask: maskT,
    });
    const v = out.data;
    fillGaussian(noise, rand);
    for (let i = 0; i < latLen; i++) { const d = x[i] - tc * v[i]; x[i] = (1 - tn) * d + tn * noise[i]; }
    self.postMessage({ type: 'progress', stage: 'gen', frac: (s + 1) / (steps + 1),
      text: `Diffusion step ${s + 1} / ${steps} — ${((performance.now() - t0) / 1000).toFixed(0)}s` });
  }

  // 6. Decode → stereo PCM, trim headroom.
  self.postMessage({ type: 'progress', stage: 'gen', frac: steps / (steps + 1), text: 'Decoding to audio…' });
  const { audio } = await sessions.decoder.run({ latents: new ort.Tensor('float32', x, [1, IO_CHANNELS, tLat]) });
  const chan = audio.dims[2];
  const wanted = Math.min(seconds * SAMPLE_RATE, chan);
  const left = new Float32Array(wanted), right = new Float32Array(wanted);
  for (let i = 0; i < wanted; i++) {
    left[i] = Math.max(-1, Math.min(1, audio.data[i]));
    right[i] = Math.max(-1, Math.min(1, audio.data[chan + i]));
  }
  self.postMessage({ type: 'progress', stage: 'gen', frac: 1, text: `Done in ${((performance.now() - t0) / 1000).toFixed(0)}s` });
  self.postMessage({ type: 'result', left, right, seconds: wanted / SAMPLE_RATE }, [left.buffer, right.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load();
    else if (data.type === 'generate') await generate(data);
  } catch (err) {
    console.error('[worker]', err);
    self.postMessage({ type: 'error', message: err.message });
  }
};
