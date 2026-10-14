/**
 * MusicCoCa text front-end in its own worker: prompt text → 12 RVQ style tokens
 * (official path: lowercase → SentencePiece → text_encoder.tflite →
 * pretrained_vector_quantizer.tflite; no mapper). It lives apart from the
 * generation worker so its 500 MB of fp32 weights sit in a separate WASM heap.
 *
 * Messages in:  {type:'init', hf?, cache}  {type:'prompt', id, text}
 * Messages out: {type:'ready'}  {type:'tokens', id, text, tokens|null}  {type:'log'}  {type:'error'}
 */
const LITERT_ESM = 'https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/+esm';
const LITERT_WASM = 'https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/wasm/';
const HF = 'https://huggingface.co/google/magenta-realtime-2/resolve/main/resources/musiccoca/';
const NUM_CB = 12;

self.addEventListener('error', (e) => post({ type: 'error', error: `musiccoca worker: ${e.message}` }));
self.addEventListener('unhandledrejection', (e) => post({ type: 'error', error: `musiccoca worker: ${e.reason?.stack || e.reason}` }));
const post = (m) => self.postMessage(m);
const log = (msg) => { console.log('[musiccoca]', msg); post({ type: 'log', msg }); };

let Tensor, textEncoder, quantizer, sp;

/** Fetch a URL through the shared Cache API cache. */
async function fetchBytes(url, cacheName) {
  const cache = await caches.open(cacheName);
  let resp = await cache.match(url);
  if (!resp) {
    resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    try {
      await cache.put(url, new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }));
    } catch (err) {   // storage quota etc.: keep going uncached
      console.error(err);
      log(`could not cache ${url.split('/').pop()} (${err.message}); it will be downloaded again next time`);
    }
    return bytes;
  }
  return new Uint8Array(await resp.arrayBuffer());
}

async function init(opts) {
  const t0 = performance.now();
  const litert = await import(LITERT_ESM);
  const { SentencePiece } = await import('./spm.js');
  Tensor = litert.Tensor;
  self.Module = { locateFile: (f) => LITERT_WASM + f };   // see worker.js
  await litert.loadLiteRt(LITERT_WASM, { jspi: await litert.supportsFeature('jspi') });   // single-threaded, see worker.js
  const hf = opts.hf || HF;
  const [text, quant, spm] = await Promise.all(['text_encoder.tflite', 'pretrained_vector_quantizer.tflite', 'spm.model']
    .map((f) => fetchBytes(hf + f, opts.cache)));
  textEncoder = await litert.loadAndCompile(text, { accelerator: 'wasm' });
  quantizer = await litert.loadAndCompile(quant, { accelerator: 'wasm' });
  sp = SentencePiece.fromBytes(spm);
  log(`MusicCoCa ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  post({ type: 'ready' });
}

async function embed(text) {
  const t0 = performance.now();
  const ids = new Int32Array(128), pad = new Float32Array(128).fill(1);
  const labels = sp.encode(text.toLowerCase()).slice(0, 127);
  ids[0] = 1;                                     // <s>
  labels.forEach((t, i) => { ids[i + 1] = t; });
  for (let i = 0; i <= labels.length; i++) pad[i] = 0;
  const feeds = {};
  for (const d of textEncoder.getInputDetails()) feeds[d.name] = d.dtype === 'int32' ? new Tensor(ids, [1, 128]) : new Tensor(pad, [1, 128]);
  const emb = Object.values(await textEncoder.run(feeds))[0];
  const q = (await quantizer.run([emb]))[0];
  const tokens = Array.from(q.toTypedArray()).slice(0, NUM_CB);
  Object.values(feeds).forEach((t) => t.delete()); emb.delete(); q.delete();
  log(`prompt "${text}" → style tokens [${tokens.join(', ')}] (${(performance.now() - t0) | 0} ms)`);
  return tokens;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (!m || typeof m.type !== 'string') return;   // WASM-runtime traffic, see worker.js
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'prompt') {
      const text = m.text.trim();
      post({ type: 'tokens', id: m.id, text, tokens: text ? await embed(text) : null });
    } else throw new Error('musiccoca worker: unknown message ' + m.type);
  } catch (err) {
    console.error(err);
    post({ type: 'error', error: String(err?.stack || err) });
  }
};
