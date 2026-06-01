/**
 * Web Worker (module): runs the full stable-audio-3-small-music pipeline.
 *
 *   tokenizer → text_encoder → number_conditioner → pingpong diffusion (DiT) → decoder → PCM
 *
 * Everything runs locally via onnxruntime-web (int4 quantized graphs). The ~640 MB of
 * weights are downloaded once and cached in the Cache Storage API, so repeat visits and
 * repeat generations are instant / network-free.
 *
 * The exact tensor I/O, the LogSNR schedule and the pingpong sampler were reproduced from
 * the upstream stable-audio-tools reference and validated end-to-end against onnxruntime.
 *
 * With an input clip it does audio-to-audio variation instead: a separate ONNX encoder turns
 * the clip into latents that seed the diffusion (mixed with noise at the chosen strength).
 *
 * Messages in:   { type:'load' }
 *                { type:'generate', prompt, seconds, steps, seed, strength, audioLeft, audioRight }
 * Messages out:  { type:'progress', stage, frac, text }
 *                { type:'loaded' }
 *                { type:'result', left, right, seconds }
 *                { type:'error', message }
 */

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.wasm.bundle.min.mjs';
import { PreTrainedTokenizer } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

// Surface anything that escapes a try/catch (CLAUDE.md: fail loudly).
self.addEventListener('error', (e) =>
  self.postMessage({ type: 'error', message: e.message || 'Worker failed to load (check your network connection).' }));
self.addEventListener('unhandledrejection', (e) =>
  self.postMessage({ type: 'error', message: `Unhandled rejection: ${e.reason?.message || e.reason}` }));

// ── Model configuration (from the bundle's config.json) ──────────────────────

const REPO = 'lsb/stable-audio-3-small-music-onnx';
const BASE = `https://huggingface.co/${REPO}/resolve/main`;
const CACHE_NAME = 'stable-audio-onnx-v1';

// Audio encoder (audio → latents) for audio-to-audio variation. Lazily loaded only when
// the user supplies an input clip. Lives in a separate repo from the text-to-audio bundle.
const ENCODER_URL = 'https://huggingface.co/bgkb/encoder-onnx/resolve/main/encoder_q4.onnx';
const ENCODER_BYTES = 35_686_439;

const SAMPLE_RATE = 44100;
const AUDIO_ALIGN = 8192;      // input/latent length granularity (keeps t_lat even)
const DOWNSAMPLE = 4096;       // audio samples per latent frame
const IO_CHANNELS = 256;       // latent channels (decoder upsamples each by 4096 → audio)
const COND_LEN = 257;          // cross-attention sequence length (256 text + 1 duration)
const TEXT_MAX = 256;          // text token budget
const HEADROOM_SEC = 6;        // extra latent generated then trimmed away

// LogSNR schedule: t = sigmoid(-(logsnr_end - τ·(logsnr_end - logsnr_start))) with rate=0,
// so it is independent of sequence length (closed form, same for any duration).
const LOGSNR_START = -6.2;
const LOGSNR_END = 2.0;

/** Each graph and the weight chunks it loads as ONNX external data. */
const GRAPHS = {
  text_encoder: { model: 'text_encoder_q4.onnx', chunks: ['text_encoder_q4_chunk_0.data', 'text_encoder_q4_chunk_1.data', 'text_encoder_q4_chunk_2.data'] },
  number_conditioner: { model: 'number_conditioner.onnx', chunks: [] },
  dit: { model: 'dit_q4.onnx', chunks: ['dit_q4_chunk_0.data', 'dit_q4_chunk_1.data', 'dit_q4_chunk_2.data', 'dit_q4_chunk_3.data'] },
  decoder: { model: 'decoder_q4.onnx', chunks: ['decoder_q4_chunk_0.data'] },
};

// Total download size (bytes) for accurate progress: weight chunks + graph files +
// tokenizer.json, summed from the bundle's shard manifests. ≈ 651 MiB.
const TOTAL_BYTES = 682_554_572;

// ── State ────────────────────────────────────────────────────────────────────

let tokenizer = null;
const sessions = {};

// ── Cached, progress-reporting download ──────────────────────────────────────

/** Fetch one of the model's ONNX weight files (under `onnx/`). */
const fetchWeight = (name, onChunk) => fetchCached(`${BASE}/onnx/${name}`, onChunk);

/**
 * Fetch `url` as bytes, serving from Cache Storage when present.
 * Streams the network response so `onChunk(deltaBytes)` can drive a progress bar.
 */
async function fetchCached(url, onChunk) {
  const cache = await caches.open(CACHE_NAME);

  const hit = await cache.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    onChunk(buf.byteLength);              // count cached bytes toward progress too
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

  // Persist for next time (clone via a fresh Response so the buffer stays usable here).
  await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  return bytes;
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function load() {
  // onnxruntime-web: single-threaded by default; opt into threads only when the page is
  // cross-origin isolated (otherwise SharedArrayBuffer is unavailable). SIMD is always on.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.simd = true;

  let done = 0;
  const onChunk = (n) => {
    done += n;
    self.postMessage({ type: 'progress', stage: 'load', frac: Math.min(done / TOTAL_BYTES, 0.99),
      text: `Downloading model… ${(done / 1e6).toFixed(0)} / ${(TOTAL_BYTES / 1e6).toFixed(0)} MB` });
  };

  // Tokenizer files live under tokenizer/ in the repo, so build it from the JSON directly
  // (AutoTokenizer.from_pretrained resolves paths at the repo root and can't find them).
  self.postMessage({ type: 'progress', stage: 'load', frac: 0, text: 'Loading tokenizer…' });
  const asJson = (b) => JSON.parse(new TextDecoder().decode(b));
  const [tjson, tcfg] = await Promise.all([
    fetchCached(`${BASE}/tokenizer/tokenizer.json`, onChunk).then(asJson),
    fetchCached(`${BASE}/tokenizer/tokenizer_config.json`, onChunk).then(asJson),
  ]);
  tokenizer = new PreTrainedTokenizer(tjson, tcfg);

  // Build sessions one graph at a time so peak memory is one model, not all four at once.
  for (const [key, { model, chunks }] of Object.entries(GRAPHS)) {
    const modelBytes = await fetchWeight(model, onChunk);
    const externalData = [];
    for (const c of chunks) externalData.push({ path: c, data: await fetchWeight(c, onChunk) });
    self.postMessage({ type: 'progress', stage: 'load', frac: Math.min(done / TOTAL_BYTES, 0.99),
      text: `Initializing ${key}…` });
    sessions[key] = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], externalData });
  }

  self.postMessage({ type: 'progress', stage: 'load', frac: 1, text: 'Model ready' });
  self.postMessage({ type: 'loaded' });
}

/** Lazily download + initialize the audio encoder (only needed for variation). */
async function loadEncoder() {
  if (sessions.encoder) return;
  let done = 0;
  const bytes = await fetchCached(ENCODER_URL, (n) => {
    done += n;
    self.postMessage({ type: 'progress', stage: 'gen', frac: 0,
      text: `Downloading audio encoder… ${(done / 1e6).toFixed(0)} / ${(ENCODER_BYTES / 1e6).toFixed(0)} MB` });
  });
  self.postMessage({ type: 'progress', stage: 'gen', frac: 0, text: 'Initializing audio encoder…' });
  sessions.encoder = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}

// ── Seeded RNG (reproducible generations) ────────────────────────────────────

/** mulberry32 — small, fast, deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fill `arr` with standard-normal samples via Box–Muller. */
function fillGaussian(arr, rand) {
  for (let i = 0; i < arr.length; i += 2) {
    const u1 = Math.max(rand(), 1e-12), u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    arr[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < arr.length) arr[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
}

// ── Schedule ─────────────────────────────────────────────────────────────────

/**
 * sigmas[0..steps] from the LogSNR schedule. Starts at `sigmaMax` (1.0 for text-to-audio,
 * <1.0 for variation — the lower it is, the closer the result stays to the input clip).
 * Endpoints are pinned exactly: first = sigmaMax, last = 0.
 */
function buildSchedule(steps, sigmaMax = 1.0) {
  const sig = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const tau = sigmaMax * (1 - i / steps);                      // linspace(sigmaMax, 0, steps+1)
    const logsnr = LOGSNR_END - tau * (LOGSNR_END - LOGSNR_START);
    sig[i] = 1 / (1 + Math.exp(logsnr));                         // sigmoid(-logsnr)
  }
  sig[0] = sigmaMax;
  sig[steps] = 0.0;
  return sig;
}

// ── Generation ───────────────────────────────────────────────────────────────

async function generate({ prompt, seconds, steps, seed, strength, audioLeft, audioRight }) {
  const hasAudio = audioLeft && audioLeft.length > 0;
  const t0 = performance.now();

  // Audio-to-audio variation: the input clip dictates the latent length and duration, and
  // `strength` (σ) sets how far the result drifts from it. Plain text-to-audio uses the
  // requested duration, a 6 s latent headroom, and σ = 1 (pure noise start).
  let tLat, condSeconds, sigmaMax, trimSamples, initLatents = null;
  if (hasAudio) {
    await loadEncoder();
    const nReal = audioLeft.length;
    const nPad = Math.ceil(nReal / AUDIO_ALIGN) * AUDIO_ALIGN;   // encoder needs 8192-aligned input
    tLat = nPad / DOWNSAMPLE;
    condSeconds = nReal / SAMPLE_RATE;
    sigmaMax = strength;
    trimSamples = nReal;

    const ein = new Float32Array(2 * nPad);                      // (1, 2, nPad), channel-major, zero-padded
    ein.set(audioLeft, 0);
    ein.set(audioRight, nPad);
    self.postMessage({ type: 'progress', stage: 'gen', frac: 0, text: 'Encoding input audio…' });
    const { latents } = await sessions.encoder.run({ audio: new ort.Tensor('float32', ein, [1, 2, nPad]) });
    initLatents = latents.data;
  } else {
    tLat = Math.ceil((seconds + HEADROOM_SEC) * SAMPLE_RATE / AUDIO_ALIGN) * 2;
    condSeconds = seconds;
    sigmaMax = 1.0;
    trimSamples = seconds * SAMPLE_RATE;
  }
  const latLen = IO_CHANNELS * tLat;

  // 1. Tokenize → fixed-length input_ids / attention_mask (right-padded to 256).
  self.postMessage({ type: 'progress', stage: 'gen', frac: 0, text: 'Encoding prompt…' });
  const enc = tokenizer(prompt, { padding: 'max_length', max_length: TEXT_MAX, truncation: true, return_tensor: false });
  const flat = (a) => (Array.isArray(a[0]) ? a[0] : a);   // unwrap the batch dimension
  const inputIds = BigInt64Array.from(flat(enc.input_ids), (x) => BigInt(x));
  const attnMask = BigInt64Array.from(flat(enc.attention_mask), (x) => BigInt(x));

  // 2. Text encoder → contextual token embeddings (1, 256, 768).
  const { last_hidden_state } = await sessions.text_encoder.run({
    input_ids: new ort.Tensor('int64', inputIds, [1, TEXT_MAX]),
    attention_mask: new ort.Tensor('int64', attnMask, [1, TEXT_MAX]),
  });

  // 3. Number conditioner → duration embedding (1, 1, 768).
  const { embedding } = await sessions.number_conditioner.run({
    seconds: new ort.Tensor('float32', Float32Array.from([condSeconds]), [1]),
  });

  // 4. Assemble DiT conditioning. cross = [text tokens; duration token] (1, 257, 768);
  //    global = duration token (1, 768); local-add = zeros (text-to-audio, no inpainting);
  //    padding mask = all-true (generate the whole latent).
  const H = 768;
  const cross = new Float32Array(COND_LEN * H);
  cross.set(last_hidden_state.data, 0);
  cross.set(embedding.data, TEXT_MAX * H);
  const crossT = new ort.Tensor('float32', cross, [1, COND_LEN, H]);
  const globalT = new ort.Tensor('float32', embedding.data.slice(0, H), [1, H]);
  const localT = new ort.Tensor('float32', new Float32Array(COND_LEN * tLat), [1, COND_LEN, tLat]);
  const maskT = new ort.Tensor('bool', new Uint8Array(tLat).fill(1), [1, tLat]);

  // 5. Pingpong sampler. x starts as noise (text-to-audio) or as the input clip's latents
  //    mixed with noise at level σ (variation): x = init·(1−σ) + noise·σ. Each step denoises
  //    then re-noises to the next (lower) level; the final t_next is 0, so x ends clean.
  const rand = mulberry32(seed);
  const x = new Float32Array(latLen);
  fillGaussian(x, rand);
  if (initLatents) for (let i = 0; i < latLen; i++) x[i] = initLatents[i] * (1 - sigmaMax) + x[i] * sigmaMax;
  const noise = new Float32Array(latLen);
  const sig = buildSchedule(steps, sigmaMax);

  for (let s = 0; s < steps; s++) {
    const tc = sig[s], tn = sig[s + 1];
    const { out } = await sessions.dit.run({
      x: new ort.Tensor('float32', x, [1, IO_CHANNELS, tLat]),
      t: new ort.Tensor('float32', Float32Array.from([tc]), [1]),
      cross_attn_cond: crossT,
      global_embed: globalT,
      local_add_cond: localT,
      padding_mask: maskT,
    });
    const v = out.data;
    fillGaussian(noise, rand);
    for (let i = 0; i < latLen; i++) {
      const denoised = x[i] - tc * v[i];                          // rf_denoiser objective
      x[i] = (1 - tn) * denoised + tn * noise[i];                 // re-noise to t_next
    }
    self.postMessage({ type: 'progress', stage: 'gen', frac: (s + 1) / (steps + 1),
      text: `Diffusion step ${s + 1} / ${steps} — ${((performance.now() - t0) / 1000).toFixed(0)}s` });
  }

  // 6. Decode latents → stereo PCM (1, 2, tLat·4096), then trim headroom to the request.
  self.postMessage({ type: 'progress', stage: 'gen', frac: steps / (steps + 1), text: 'Decoding to audio…' });
  const { audio } = await sessions.decoder.run({ latents: new ort.Tensor('float32', x, [1, IO_CHANNELS, tLat]) });
  const chan = audio.dims[2];
  const wanted = Math.min(trimSamples, chan);
  const left = new Float32Array(wanted);
  const right = new Float32Array(wanted);
  for (let i = 0; i < wanted; i++) {
    left[i] = Math.max(-1, Math.min(1, audio.data[i]));           // decoder clamps to [-1, 1]
    right[i] = Math.max(-1, Math.min(1, audio.data[chan + i]));
  }

  self.postMessage({ type: 'progress', stage: 'gen', frac: 1,
    text: `Done in ${((performance.now() - t0) / 1000).toFixed(0)}s` });
  self.postMessage({ type: 'result', left, right, seconds: wanted / SAMPLE_RATE }, [left.buffer, right.buffer]);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load();
    else if (data.type === 'generate') await generate(data);
  } catch (err) {
    console.error('[worker]', err);
    self.postMessage({ type: 'error', message: err.message });
  }
};
