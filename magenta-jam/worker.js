/**
 * Magenta RealTime 2 runtime, off the main thread.
 *
 * Pipeline per 40 ms frame (all in LiteRT.js):
 *   cond[144], prev frame's code embedding, KV windows
 *     ─► temporal.tflite (encoder + 12-layer temporal transformer)
 *     ─► depth.tflite (12 depth levels + in-graph top-k/gumbel sampling) ─► 12 codes
 *   ...every DEC_FRAMES frames: decoder.tflite (SpectroStream, streaming state)
 *   ─► inverse-STFT windows ─► overlap-add here ─► stereo PCM to the page.
 *
 * The style prompt's 12 MusicCoCa tokens arrive from musiccoca-worker.js and sit
 * in the conditioning vector next to the 128 note states and the guidance tokens.
 */
// Classic worker (not a module): LiteRT.js's WASM loader calls importScripts(),
// which module workers forbid. Everything is pulled in with dynamic import().
const LITERT_ESM = 'https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/+esm';
const LITERT_WASM = 'https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/wasm/';
let loadLiteRt, loadAndCompile, Tensor, supportsFeature, isWebGPUSupported;
const CACHE = 'magenta-jam-models-v1';   // shared with musiccoca-worker.js

const SR = 48000, FRAME_SAMPLES = 1920, HOP = 480, WIN = 960, ROWS_PER_FRAME = 4;
const NUM_CB = 12, CB = 1024, RESERVED = 6, COND_OFFSET = 7, MASKED = -1;
const LOOKAHEAD_ROWS = 4;      // decoder lookahead: first 4 STFT rows are warm-up, dropped
const OUT_GAIN = 0.5;          // reference output gain (system.py _float_to_int16)

self.addEventListener('error', (e) => post({ type: 'error', error: `worker: ${e.message}` }));
self.addEventListener('unhandledrejection', (e) => post({ type: 'error', error: `worker: ${e.reason?.stack || e.reason}` }));

const post = (m, transfer) => self.postMessage(m, transfer);
const log = (msg) => { console.log('[mrt2]', msg); post({ type: 'log', msg }); };

// ---------------------------------------------------------------- downloads
/** Fetch (and Cache-API cache) a URL, reporting progress. */
async function fetchBytes(url, onProgress) {
  const cache = await caches.open(CACHE);
  let resp = await cache.match(url);
  const hit = !!resp;
  if (!resp) {
    resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  }
  const total = Number(resp.headers.get('content-length')) || 0;
  const reader = resp.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; onProgress(got, Math.max(total, got));
  }
  const bytes = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  if (!hit) {
    try {
      await cache.put(url, new Response(bytes, { headers: { 'Content-Length': String(got) } }));
    } catch (err) {   // storage quota etc.: the download still succeeded, it just won't be cached
      console.error(err);
      log(`could not cache ${url.split('/').pop()} (${err.message}); it will be downloaded again next time`);
    }
  }
  return bytes;
}

/** Download a list of URLs (chunks of one model) in parallel and concatenate. */
async function fetchModel(urls, onProgress) {
  const got = new Array(urls.length).fill(0), tot = new Array(urls.length).fill(0);
  const parts = await Promise.all(urls.map((u, i) => fetchBytes(u, (g, t) => {
    got[i] = g; tot[i] = t; onProgress(got.reduce((a, b) => a + b, 0), tot.reduce((a, b) => a + b, 0));
  })));
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------------------------------------------------------------- state
let temporal, depth, decoder, sosX;
let backend = 'wasm';
let running = false;
let styleTokens = null;                 // 12 ints or null (masked)
let params = { temperature: 1.3, topK: 40, cfgStyle: 3.0, cfgNotes: 4.0, cfgDrums: 1.0 };
let samplesSent = 0, samplesConsumed = 0;
let stopRequested = false;

// Note tracker (mirrors the official MidiNoteTracker): a note-on latches an
// ONSET so a tap shorter than one frame still conditions exactly one frame.
const IDLE = 0, ONSET = 1, SUSTAIN = 2, ONSET_RELEASED = 3;
const notes = new Uint8Array(128);
function noteOn(p) { notes[p] = ONSET; }
function noteOff(p) { if (notes[p] === ONSET) notes[p] = ONSET_RELEASED; else if (notes[p] === SUSTAIN) notes[p] = IDLE; }
/** Read every pitch's state for this frame, advancing ONSET→SUSTAIN, ONSET_RELEASED→IDLE. */
function noteTokens() {
  const out = new Int32Array(128).fill(MASKED);
  for (let p = 0; p < 128; p++) {
    const s = notes[p];
    if (s === IDLE) continue;
    out[p] = 3;                                    // "sustain or onset, model decides"
    if (s === ONSET) notes[p] = SUSTAIN; else if (s === ONSET_RELEASED) notes[p] = IDLE;
  }
  return out;
}

/** magenta_rt discretize_cfg: guidance scale -> conditioning bin. */
const discretize = (v, step, maxBin) => Math.max(0, Math.min(maxBin, Math.round((Math.max(-1, Math.min(7, v)) + 1) / step)));

/** The 144-int conditioning vector: style[12] + notes[128] + drums[1] + cfg[3], each + 7. */
function buildCond() {
  const c = new Int32Array(144);
  for (let i = 0; i < NUM_CB; i++) c[i] = (styleTokens ? styleTokens[i] : MASKED) + COND_OFFSET;
  const n = noteTokens();
  for (let i = 0; i < 128; i++) c[NUM_CB + i] = n[i] + COND_OFFSET;
  c[140] = MASKED + COND_OFFSET;
  c[141] = discretize(params.cfgStyle, 0.2, 40) + COND_OFFSET;
  c[142] = discretize(params.cfgNotes, 0.2, 40) + COND_OFFSET;
  c[143] = discretize(params.cfgDrums, 1.0, 8) + COND_OFFSET;
  return c;
}

/** Gumbel(0,1) noise for the in-graph gumbel-max sampler. */
function gumbel(n) {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.min(1 - 1e-7, Math.max(1e-10, Math.random()));
    g[i] = -Math.log(-Math.log(u));
  }
  return g;
}

// ---------------------------------------------------------------- init
async function init(opts) {
  const t0 = performance.now();
  ({ loadLiteRt, loadAndCompile, Tensor, supportsFeature, isWebGPUSupported } = await import(LITERT_ESM));
  // Emscripten resolves the .wasm relative to this worker's URL; point it at the
  // CDN directory instead (LiteRT.js hands `self.Module` to the module factory).
  self.Module = { locateFile: (f) => LITERT_WASM + f };
  // The multithreaded build cannot spawn its pthread workers from a CDN URL inside
  // a worker (cross-origin Worker scripts are blocked), so stay single-threaded;
  // JSPI (Chromium) lets the GPU backend fall back per-op to the CPU when needed.
  const jspi = await supportsFeature('jspi');
  await loadLiteRt(LITERT_WASM, { jspi });
  const threads = false;
  const wantGpu = opts.backend !== 'wasm' && isWebGPUSupported();
  backend = wantGpu ? 'webgpu' : 'wasm';
  log(`LiteRT.js loaded (${(performance.now() - t0) | 0} ms): backend=${backend} jspi=${jspi} threads=${threads} cores=${navigator.hardwareConcurrency}`);

  const base = new URL('models/', self.location.href).href;
  const manifest = await (await fetch(base + 'manifest.json')).json();
  const chunkUrls = (name) => manifest[name].chunks.map((c) => base + c);
  const files = {
    temporal: chunkUrls('temporal'), depth: chunkUrls('depth'), decoder: chunkUrls('decoder'), sos: [base + 'sos.json'],
  };
  const got = {}, tot = {};
  const report = () => {
    const g = Object.values(got).reduce((a, b) => a + b, 0), t = Object.values(tot).reduce((a, b) => a + b, 0);
    post({ type: 'progress', pct: t ? g / t : 0, note: `downloading models — ${(g / 1e6) | 0} / ${(t / 1e6) | 0} MB` });
  };
  const bytes = {};
  await Promise.all(Object.entries(files).map(async ([k, urls]) => {
    bytes[k] = await fetchModel(urls, (g, t) => { got[k] = g; tot[k] = t; report(); });
  }));
  log(`models downloaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  post({ type: 'progress', pct: 1, note: `compiling for ${backend}…` });
  const t1 = performance.now();
  // The LLM runs in fp16 on the GPU (fp32 does not fit next to the decoder), which
  // needs shader-f16; without it the LLM stays on the CPU. The decoder's
  // activations reach ~4e6, far beyond fp16, so it always runs in fp32.
  const f16 = backend === 'webgpu' && (await navigator.gpu.requestAdapter())?.features.has('shader-f16');
  const llmOpts = f16 ? { accelerator: 'webgpu', gpuOptions: { precision: 'fp16' } } : { accelerator: 'wasm' };
  const gpuOpts = { accelerator: backend, gpuOptions: { precision: 'fp32' } };
  if (backend === 'webgpu') log(`llm on ${llmOpts.accelerator}${f16 ? ' (fp16)' : ' — this GPU lacks shader-f16'}, decoder on webgpu (fp32)`);
  temporal = await loadAndCompile(bytes.temporal, llmOpts);
  depth = await loadAndCompile(bytes.depth, llmOpts);
  sosX = Float32Array.from(JSON.parse(new TextDecoder().decode(bytes.sos)));
  log(`llm compiled (${((performance.now() - t1) / 1000).toFixed(1)} s) fullyAccelerated=${temporal.isFullyAccelerated && depth.isFullyAccelerated}`);
  const t2 = performance.now();
  decoder = await loadAndCompile(bytes.decoder, gpuOpts);
  log(`decoder compiled (${((performance.now() - t2) / 1000).toFixed(1)} s) fullyAccelerated=${decoder.isFullyAccelerated}`);
  log(`ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  post({ type: 'ready', backend, fullyAccelerated: temporal.isFullyAccelerated && depth.isFullyAccelerated && decoder.isFullyAccelerated });
}

// ---------------------------------------------------------------- generation
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// LiteRT.js positional run() does not follow the signature order, so feed by name
// (args_0..args_N in signature order) and read outputs back in output order.
const byName = (details, tensors) => Object.fromEntries(details.map((d, i) => [d.name, tensors[i]]));
const inOrder = (details, rec) => details.map((d) => rec[d.name]);
const zeros = (d) => new Tensor(new Float32Array(Array.from(d.shape).reduce((a, b) => a * b, 1)), Array.from(d.shape));

async function generate() {
  running = true; stopRequested = false;
  samplesSent = 0; samplesConsumed = 0;
  const tIn = temporal.getInputDetails(), tOut = temporal.getOutputDetails();
  const dIn = depth.getInputDetails(), dOut = depth.getOutputDetails();
  const decIn = decoder.getInputDetails(), decOut = decoder.getOutputDetails();
  const DEC_FRAMES = decIn[0].shape[1];
  let state = tIn.slice(3, 7).map(zeros);        // self_k, self_v, cross_k, cross_v
  let decState = decIn.slice(1).map(zeros);
  let prevX = new Tensor(Float32Array.from(sosX), [1, 1, sosX.length]);   // mean embedding of the previous frame's codes
  let framePos = 0, pendingCodes = [], firstChunk = true;
  const tail = new Float32Array(2 * HOP);        // overlap-add carry, per channel
  const stats = { llmMs: 0, decMs: 0, frames: 0, peak: 0, t0: performance.now() };
  log(`generating: ${DEC_FRAMES}-frame decode chunks, temperature ${params.temperature}, top-k ${params.topK}`);
  try {
    while (!stopRequested) {
      // Pace against playback: keep ~targetAhead of audio queued, never idle-spin.
      const ahead = (samplesSent - samplesConsumed) / SR;
      const perFrame = stats.frames ? (stats.llmMs + stats.decMs) / stats.frames : 40;
      const targetAhead = Math.min(2.0, Math.max(0.25, 4 * perFrame / 1000));
      if (ahead > targetAhead) { await sleep(15); continue; }

      const t = performance.now();
      const tFeeds = [new Tensor(buildCond(), [1, 144]), prevX, new Tensor(Int32Array.of(framePos), [1]), ...state];
      const tRes = inOrder(tOut, await temporal.run(byName(tIn, tFeeds)));  // [t_out, self_k, self_v, cross_k, cross_v]
      const dFeeds = [tRes[0], new Tensor(gumbel(NUM_CB * CB), [NUM_CB, CB]),
        new Tensor(Float32Array.of(params.temperature), [1]), new Tensor(Int32Array.of(params.topK), [1])];
      const dRes = inOrder(dOut, await depth.run(byName(dIn, dFeeds)));      // [codes, next prev_x]
      const codesCpu = dRes[0].accelerator === 'wasm' ? dRes[0] : await dRes[0].moveTo('wasm');
      const codes = Int32Array.from(codesCpu.toTypedArray());
      [tFeeds[0], tFeeds[2], prevX, ...state, ...dFeeds, codesCpu].forEach((x) => x.delete());
      if (codesCpu !== dRes[0]) dRes[0].delete();
      state = tRes.slice(1);
      prevX = dRes[1];
      framePos++; stats.frames++; stats.llmMs += performance.now() - t;
      pendingCodes.push(codes);

      if (pendingCodes.length === DEC_FRAMES) {
        const td = performance.now();
        const raw = new Int32Array(DEC_FRAMES * NUM_CB);
        pendingCodes.forEach((c, i) => c.forEach((v, j) => { raw[i * NUM_CB + j] = (v - RESERVED) % CB; }));
        pendingCodes = [];
        const codesT = new Tensor(raw, [1, DEC_FRAMES, NUM_CB]);
        const out = inOrder(decOut, await decoder.run(byName(decIn, [codesT, ...decState])));
        const framesT = out[0].accelerator === 'wasm' ? out[0] : await out[0].moveTo('wasm');
        const fr = framesT.toTypedArray();           // [2][rows][960]
        codesT.delete(); decState.forEach((x) => x.delete()); framesT.delete(); if (framesT !== out[0]) out[0].delete();
        decState = out.slice(1);
        const rows = DEC_FRAMES * ROWS_PER_FRAME, skip = firstChunk ? LOOKAHEAD_ROWS : 0;
        firstChunk = false;
        const pcm = overlapAdd(fr, rows, skip, tail);
        for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > stats.peak) stats.peak = a; }
        if (!Number.isFinite(stats.peak)) throw new Error('decoder produced non-finite audio');
        samplesSent += pcm.length / 2;
        post({ type: 'pcm', pcm }, [pcm.buffer]);
        stats.decMs += performance.now() - td;
        if (stats.frames % 25 === 0) {
          const wall = (performance.now() - stats.t0) / 1000;
          post({ type: 'stats', llmMs: stats.llmMs / stats.frames, decMs: stats.decMs / stats.frames,
            speed: (stats.frames / 25) / wall, ahead: (samplesSent - samplesConsumed) / SR, peak: stats.peak });
          stats.peak = 0;
        }
      }
    }
  } finally {
    running = false;
    [prevX, ...state, ...decState].forEach((x) => { try { x.delete(); } catch (e) { console.error(e); } });
    post({ type: 'stopped' });
  }
}

/**
 * Overlap-add inverse-STFT windows into interleaved stereo PCM.
 * fr: Float32Array laid out [channel][row][960]; each row advances by HOP=480.
 * `skip` rows are discarded first (decoder warm-up); `tail` carries the 480-sample
 * overlap of the last row into the next call.
 */
function overlapAdd(fr, rows, skip, tail) {
  const n = rows - skip;
  const pcm = new Float32Array(n * HOP * 2);
  for (let ch = 0; ch < 2; ch++) {
    const t = tail.subarray(ch * HOP, (ch + 1) * HOP);
    for (let r = skip; r < rows; r++) {
      const base = (ch * rows + r) * WIN, o = (r - skip) * HOP;
      for (let i = 0; i < HOP; i++) {
        pcm[(o + i) * 2 + ch] = (t[i] + fr[base + i]) * OUT_GAIN;
        t[i] = fr[base + HOP + i];
      }
    }
  }
  return pcm;
}

// ---------------------------------------------------------------- messages
self.onmessage = async (e) => {
  const m = e.data;
  // LiteRT.js's threaded WASM build exchanges its own untyped messages with
  // this worker; only our {type: ...} commands are handled here.
  if (!m || typeof m.type !== 'string') return;
  try {
    switch (m.type) {
      case 'init': await init(m); break;
      case 'style': styleTokens = m.tokens; break;      // 12 MusicCoCa tokens or null (masked)
      case 'params': Object.assign(params, m.params); break;
      case 'noteOn': noteOn(m.pitch); break;
      case 'noteOff': noteOff(m.pitch); break;
      case 'consumed': samplesConsumed = m.samples; break;
      case 'start': if (!running) generate(); break;
      case 'stop': stopRequested = true; break;
      default: throw new Error('worker: unknown message ' + m.type);
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', error: String(err?.stack || err) });
  }
};
