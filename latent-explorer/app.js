/**
 * Latent Explorer — poke at the Stable Audio 3 autoencoder's latent space.
 *
 * worker.js owns the ONNX sessions (encode: audio → 256-dim latents at
 * ~10.77 Hz, decode: latents → audio). This module owns everything else:
 * sound slots, latent edits (morph / gain / noise / smear / stretch / PCA
 * directions), rendering, and the MediaPipe hand-control loop that maps hand
 * keypoints to latent vectors and re-decodes a looping window continuously.
 */

const $ = (s) => document.querySelector(s);
const SR = 44100;
const HOP = 4096;
const C = 256;

// ── Fail loudly: surface anything that escapes a try/catch ───────────────────
window.addEventListener('error', (e) => showError(e.message));
window.addEventListener('unhandledrejection', (e) => showError(`Unhandled rejection: ${e.reason?.message || e.reason}`));

function showError(message) {
  console.error('[latent-explorer]', message);
  const box = $('#load-progress');
  box.classList.remove('hidden');
  $('#load-text').textContent = `Error: ${message}`;
  $('#load-bar').style.background = '#f44336';
  $('#load-bar').style.width = '100%';
}

// ── Worker plumbing (promise-per-request) ────────────────────────────────────

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let msgId = 0;
const pending = new Map();   // id → {resolve, reject}

let model = null;            // {model, backend, fixedFrames} once loaded

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    $('#load-progress').classList.remove('hidden');
    $('#load-bar').style.background = '';
    $('#load-bar').style.width = `${Math.round(data.frac * 100)}%`;
    $('#load-text').textContent = data.text;
  } else if (data.type === 'loaded') {
    model = data;
    $('#load-model').disabled = false;
    $('#load-model').textContent = 'Reload model';
    $('#hand-window-control').classList.toggle('hidden', !!data.fixedFrames);
    onModelLoaded();
  } else if (data.type === 'encoded' || data.type === 'decoded') {
    pending.get(data.id)?.resolve(data);
    pending.delete(data.id);
  } else if (data.type === 'error') {
    if (data.id !== undefined && pending.has(data.id)) {
      pending.get(data.id).reject(new Error(data.message));
      pending.delete(data.id);
    } else {
      showError(data.message);
      $('#load-model').disabled = false;
    }
  }
};
worker.onerror = (e) => showError(e.message || 'Worker crashed');

const request = (msg, transfer = []) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id }, transfer);
});

const encodeAudio = (left, right) => request({ type: 'encode', left, right });
const decodeLatents = (latents, frames) => request({ type: 'decode', latents: latents.slice(), frames });

// ── Model loading + settings persistence ────────────────────────────────────

function loadModel() {
  if (handState.running) stopHand();   // the loop must not race a model swap
  const choice = { model: $('#model-select').value, ep: $('#ep-select').value };
  localStorage.setItem('latent-explorer-settings', JSON.stringify(choice));
  $('#load-model').disabled = true;
  model = null;
  worker.postMessage({ type: 'load', ...choice });
}

try {
  const saved = JSON.parse(localStorage.getItem('latent-explorer-settings') || '{}');
  if (saved.model) $('#model-select').value = saved.model;
  if (saved.ep) $('#ep-select').value = saved.ep;
} catch (err) { console.error('Bad saved settings:', err); }

$('#load-model').addEventListener('click', loadModel);

async function onModelLoaded() {
  // (Re-)encode any sounds that were loaded before the model (or for another model).
  for (const slot of ['A', 'B']) {
    if (slots[slot].pcm) await encodeSlot(slot).catch((e) => showError(e.message));
  }
  refreshUI();
}

// ── Sound slots ──────────────────────────────────────────────────────────────

const slots = {
  A: { pcm: null, latents: null, frames: 0, name: '' },
  B: { pcm: null, latents: null, frames: 0, name: '' },
};

function maxSeconds() { return model?.fixedFrames ? model.fixedFrames * HOP / SR : 30; }

async function decodeToStereo44k(arrayBuffer) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await ac.decodeAudioData(arrayBuffer); } finally { ac.close(); }
  const length = Math.max(1, Math.ceil(decoded.duration * SR));
  const off = new OfflineAudioContext(2, length, SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { left: rendered.getChannelData(0).slice(), right: rendered.getChannelData(1).slice() };
}

async function setSlotAudio(slot, left, right, name) {
  const cap = Math.floor(maxSeconds() * SR);
  let trimmed = false;
  if (left.length > cap) { left = left.slice(0, cap); right = right.slice(0, cap); trimmed = true; }
  slots[slot] = { pcm: { left, right }, latents: null, frames: 0, name };
  drawWave($(`#wave-${slot}`), left);
  setStatus(slot, `${name} — ${(left.length / SR).toFixed(1)}s${trimmed ? ' (trimmed)' : ''}`);
  if (model) await encodeSlot(slot);
  refreshUI();
}

async function encodeSlot(slot) {
  const s = slots[slot];
  setStatus(slot, `${s.name} — encoding…`);
  const { latents, frames, ms } = await encodeAudio(s.pcm.left.slice(), s.pcm.right.slice());
  s.latents = latents;
  s.frames = frames;
  setStatus(slot, `${s.name} — ${frames} latent frames (${(ms / 1000).toFixed(1)}s)`);
  if (slot === 'A' || !slots.A.latents) pcaState = null;   // base sound changed
  refreshUI();
}

const setStatus = (slot, text) => { $(`#status-${slot}`).textContent = text; };

async function onFile(slot, file) {
  if (!file) return;
  try {
    setStatus(slot, `decoding ${file.name}…`);
    const { left, right } = await decodeToStereo44k(await file.arrayBuffer());
    await setSlotAudio(slot, left, right, file.name);
  } catch (err) {
    console.error('Audio decode failed:', err);
    setStatus(slot, `couldn't decode (${err.message})`);
  }
}

// Microphone recording per slot.
let recorder = null;
async function toggleRecord(slot, btn) {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error('Microphone access failed:', err);
    setStatus(slot, `microphone blocked (${err.message})`);
    return;
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    btn.classList.remove('recording');
    btn.textContent = '● Rec';
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const { left, right } = await decodeToStereo44k(await blob.arrayBuffer());
      await setSlotAudio(slot, left, right, 'recording');
    } catch (err) {
      console.error('Recording decode failed:', err);
      setStatus(slot, `couldn't decode recording (${err.message})`);
    }
  };
  recorder.start();
  btn.classList.add('recording');
  btn.textContent = '■ Stop';
  setStatus(slot, 'recording… click ■ to stop');
}

/** Synthesized demo clips so the app works without any files. */
function makeDemo(slot) {
  const secs = Math.min(8, maxSeconds());
  const n = Math.floor(secs * SR / HOP) * HOP;
  const L = new Float32Array(n), R = new Float32Array(n);
  if (slot === 'A') {
    // arpeggio + kick
    const notes = [220, 277.18, 329.63, 440];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const step = Math.floor(t * 4) % notes.length;
      const ph = t % 0.25;
      const f = notes[step];
      let v = 0.35 * Math.exp(-ph * 6) * Math.sin(2 * Math.PI * f * t) +
              0.2 * Math.exp(-ph * 6) * Math.sin(2 * Math.PI * f * 2 * t);
      const beat = (t * 2) % 1;
      v += 0.55 * Math.exp(-beat * 16) * Math.sin(2 * Math.PI * 52 * Math.pow(beat, 0.6));
      L[i] = v; R[i] = 0.35 * Math.exp(-ph * 6) * Math.sin(2 * Math.PI * f * t + 0.5) + v * 0.6;
    }
  } else {
    // breathy noise sweeps + low drone
    let lp = 0, seed = 9;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const cutoff = 0.02 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.9));
      lp += cutoff * (rnd() - lp);
      const drone = 0.25 * Math.sin(2 * Math.PI * 65.4 * t) * (0.6 + 0.4 * Math.sin(t * 0.5));
      L[i] = 0.5 * lp + drone; R[i] = 0.5 * lp - drone * 0.8;
    }
  }
  return { left: L, right: R };
}

document.querySelectorAll('input[type=file][data-slot]').forEach((inp) =>
  inp.addEventListener('change', () => onFile(inp.dataset.slot, inp.files[0])));
document.querySelectorAll('.rec-btn').forEach((btn) =>
  btn.addEventListener('click', () => toggleRecord(btn.dataset.slot, btn)));
document.querySelectorAll('.demo-btn').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const { left, right } = makeDemo(btn.dataset.slot);
    await setSlotAudio(btn.dataset.slot, left, right, btn.dataset.slot === 'A' ? 'demo arpeggio' : 'demo texture');
  }));

// ── Latent math ──────────────────────────────────────────────────────────────
// Latents are stored channel-major: Float32Array(256 * frames), value(c, f) = a[c*frames + f].

/** Per-frame spherical interpolation between two latent sequences. */
function slerpLatents(a, fa, b, fb, t) {
  const frames = Math.min(fa, fb);
  const out = new Float32Array(C * frames);
  for (let f = 0; f < frames; f++) {
    let dot = 0, na = 0, nb = 0;
    for (let c = 0; c < C; c++) {
      const va = a[c * fa + f], vb = b[c * fb + f];
      dot += va * vb; na += va * va; nb += vb * vb;
    }
    na = Math.sqrt(na); nb = Math.sqrt(nb);
    const cosw = Math.min(1, Math.max(-1, dot / (na * nb + 1e-9)));
    const w = Math.acos(cosw), sw = Math.sin(w);
    let ka, kb;
    if (sw < 1e-4) { ka = 1 - t; kb = t; }                       // nearly parallel → lerp
    else { ka = Math.sin((1 - t) * w) / sw; kb = Math.sin(t * w) / sw; }
    for (let c = 0; c < C; c++) out[c * frames + f] = ka * a[c * fa + f] + kb * b[c * fb + f];
  }
  return { latents: out, frames };
}

function latentStd(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length) || 1;
}

// mulberry32 — deterministic RNG for noise + the random hand projection.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Top-k PCA over latent frames via power iteration (frames as samples, 256 dims). */
function computePCA(latents, frames, k = 6) {
  const mean = new Float32Array(C);
  for (let c = 0; c < C; c++) {
    let s = 0;
    for (let f = 0; f < frames; f++) s += latents[c * frames + f];
    mean[c] = s / frames;
  }
  // covariance (C × C)
  const cov = new Float32Array(C * C);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < C; i++) {
      const vi = latents[i * frames + f] - mean[i];
      if (vi === 0) continue;
      const row = i * C;
      for (let j = i; j < C; j++) cov[row + j] += vi * (latents[j * frames + f] - mean[j]);
    }
  }
  for (let i = 0; i < C; i++) for (let j = 0; j < i; j++) cov[i * C + j] = cov[j * C + i];
  for (let i = 0; i < cov.length; i++) cov[i] /= Math.max(1, frames - 1);

  const comps = [], sigmas = [];
  const rand = mulberry32(1234);
  for (let kk = 0; kk < k; kk++) {
    let v = Float32Array.from({ length: C }, () => rand() - 0.5);
    let lambda = 0;
    for (let it = 0; it < 60; it++) {
      const nv = new Float32Array(C);
      for (let i = 0; i < C; i++) {
        let s = 0;
        const row = i * C;
        for (let j = 0; j < C; j++) s += cov[row + j] * v[j];
        nv[i] = s;
      }
      lambda = Math.sqrt(nv.reduce((s, x) => s + x * x, 0));
      for (let i = 0; i < C; i++) nv[i] /= lambda || 1;
      v = nv;
    }
    comps.push(v);
    sigmas.push(Math.sqrt(Math.max(lambda, 0)));
    // deflate: cov -= λ v vᵀ
    for (let i = 0; i < C; i++) for (let j = 0; j < C; j++) cov[i * C + j] -= lambda * v[i] * v[j];
  }
  return { comps, sigmas, mean };
}

let pcaState = null;   // {comps, sigmas, base: 'frames at compute time'}

function ensurePCA(base) {
  if (!pcaState) {
    pcaState = computePCA(base.latents, base.frames);
    buildPcaSliders();
  }
  return pcaState;
}

function buildPcaSliders() {
  const box = $('#pca-sliders');
  box.innerHTML = '';
  pcaState.comps.forEach((_, i) => {
    const div = document.createElement('div');
    div.className = 'control';
    div.innerHTML = `<label>PC${i + 1} <span class="val" id="pc-val-${i}">0.0</span></label>
      <input type="range" id="pc-${i}" min="-3" max="3" step="0.1" value="0">`;
    box.appendChild(div);
    div.querySelector('input').addEventListener('input', (e) => {
      $(`#pc-val-${i}`).textContent = (+e.target.value).toFixed(1);
      refreshUI();
    });
  });
}

/** The "working" latents: morph base + all edits applied. */
function computeWorking() {
  const A = slots.A, B = slots.B;
  if (!A.latents) return null;

  let base;
  const t = +$('#morph').value;
  if (B.latents && t > 0) base = slerpLatents(A.latents, A.frames, B.latents, B.frames, t);
  else base = { latents: A.latents.slice(), frames: A.frames };

  let { latents, frames } = base;

  // PCA direction offsets (added uniformly over time)
  if (pcaState) {
    for (let i = 0; i < pcaState.comps.length; i++) {
      const amt = +($(`#pc-${i}`)?.value || 0);
      if (!amt) continue;
      const v = pcaState.comps[i], s = pcaState.sigmas[i] * amt;
      for (let c = 0; c < C; c++) {
        const o = s * v[c];
        if (!o) continue;
        for (let f = 0; f < frames; f++) latents[c * frames + f] += o;
      }
    }
  }

  // time stretch (linear resample along frames)
  const stretch = +$('#stretch').value;
  if (Math.abs(stretch - 1) > 1e-3) {
    const nf = Math.max(1, Math.min(Math.round(frames * stretch), Math.floor(maxSeconds() * SR / HOP)));
    const out = new Float32Array(C * nf);
    for (let f = 0; f < nf; f++) {
      const x = f / stretch;
      const i0 = Math.min(Math.floor(x), frames - 1), i1 = Math.min(i0 + 1, frames - 1);
      const w = x - i0;
      for (let c = 0; c < C; c++) out[c * nf + f] = (1 - w) * latents[c * frames + i0] + w * latents[c * frames + i1];
    }
    latents = out; frames = nf;
  }

  if ($('#reverse').checked) {
    for (let c = 0; c < C; c++) {
      const row = c * frames;
      for (let f = 0, g = frames - 1; f < g; f++, g--) {
        const tmp = latents[row + f]; latents[row + f] = latents[row + g]; latents[row + g] = tmp;
      }
    }
  }

  // time smear (moving average over frames)
  const smear = +$('#smooth').value | 0;
  if (smear > 0) {
    const out = new Float32Array(C * frames);
    for (let c = 0; c < C; c++) {
      const row = c * frames;
      for (let f = 0; f < frames; f++) {
        let s = 0, n = 0;
        for (let d = -smear; d <= smear; d++) {
          const ff = f + d;
          if (ff >= 0 && ff < frames) { s += latents[row + ff]; n++; }
        }
        out[row + f] = s / n;
      }
    }
    latents = out;
  }

  const gain = +$('#gain').value;
  const sigma = +$('#noise').value;
  if (gain !== 1 || sigma > 0) {
    const rand = mulberry32(42);
    const std = latentStd(latents);
    for (let i = 0; i < latents.length; i++) {
      let v = latents[i] * gain;
      if (sigma > 0) {
        const u1 = Math.max(rand(), 1e-12), u2 = rand();
        v += sigma * std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      }
      latents[i] = v;
    }
  }

  return { latents, frames };
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function drawWave(canvas, pcm) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#7aa2ff';
  ctx.beginPath();
  const step = Math.max(1, Math.floor(pcm.length / w));
  for (let x = 0; x < w; x++) {
    let mn = 1, mx = -1;
    for (let i = x * step; i < Math.min((x + 1) * step, pcm.length); i++) {
      if (pcm[i] < mn) mn = pcm[i];
      if (pcm[i] > mx) mx = pcm[i];
    }
    ctx.moveTo(x + 0.5, (1 - mx) * h / 2);
    ctx.lineTo(x + 0.5, (1 - mn) * h / 2 + 1);
  }
  ctx.stroke();
}

function drawLatents(work) {
  const canvas = $('#latent-canvas');
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (!work) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '14px system-ui';
    ctx.fillText('Load a model and add Sound A to see its latents', 20, h / 2);
    return;
  }
  const { latents, frames } = work;
  const std = latentStd(latents) * 2;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const c = Math.floor(y / h * C);
    for (let x = 0; x < w; x++) {
      const f = Math.floor(x / w * frames);
      const v = Math.max(-1, Math.min(1, latents[c * frames + f] / std));
      const k = (y * w + x) * 4;
      // diverging palette: negative → blue, positive → amber
      img.data[k] = v > 0 ? 40 + 215 * v : 30;
      img.data[k + 1] = 30 + 90 * Math.abs(v);
      img.data[k + 2] = v < 0 ? 60 + 195 * -v : 40;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (handState.running) {
    // playhead window marker
    const x0 = handState.winStart / frames * w;
    const x1 = (handState.winStart + handState.winLen) / frames * w;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
  }
}

// ── Playback ─────────────────────────────────────────────────────────────────

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    // iOS: keep playing even with the silent switch on (Safari-only Audio Session API).
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function toBuffer(left, right) {
  const ctx = getAudioCtx();
  const buf = ctx.createBuffer(2, left.length, SR);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  return buf;
}

let playing = null;   // {src}
function playOnce(left, right) {
  stopPlayback();
  const ctx = getAudioCtx();
  const src = ctx.createBufferSource();
  src.buffer = toBuffer(left, right);
  src.connect(ctx.destination);
  src.onended = () => { if (playing?.src === src) { playing = null; $('#stop-play').disabled = true; } };
  src.start();
  playing = { src };
  $('#stop-play').disabled = false;
}

function stopPlayback() {
  if (playing) { try { playing.src.stop(); } catch (err) { console.error(err); } playing = null; }
  $('#stop-play').disabled = true;
}

// Crossfading looper for hand mode.
let loopVoice = null;   // {src, gain}
function playLoopCrossfade(left, right) {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = toBuffer(left, right);
  src.loop = true;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(1, now + 0.12);
  src.connect(g).connect(ctx.destination);
  src.start();
  if (loopVoice) {
    const old = loopVoice;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(old.gain.gain.value, now);
    old.gain.gain.linearRampToValueAtTime(0, now + 0.12);
    old.src.stop(now + 0.15);
  }
  loopVoice = { src, gain: g };
}

function stopLoop() {
  if (loopVoice) { try { loopVoice.src.stop(); } catch (err) { console.error(err); } loopVoice = null; }
}

// ── Render flow ──────────────────────────────────────────────────────────────

let rendering = false;
async function render() {
  if (rendering) return;
  const work = computeWorking();
  if (!work) return;
  rendering = true;
  $('#render').disabled = true;
  $('#render-status').textContent = 'decoding…';
  try {
    const t0 = performance.now();
    const { left, right } = await decodeLatents(work.latents, work.frames);
    $('#render-status').textContent = `decoded ${(left.length / SR).toFixed(1)}s in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    const wave = $('#out-wave');
    wave.classList.remove('hidden');
    drawWave(wave, left);
    const blob = encodeWav(left, right, SR);
    const url = URL.createObjectURL(blob);
    const dl = $('#download');
    if (dl.dataset.url) URL.revokeObjectURL(dl.dataset.url);
    dl.dataset.url = url;
    dl.href = url;
    dl.download = 'latent-explorer.wav';
    dl.classList.remove('hidden');
    playOnce(left, right);
  } catch (err) {
    console.error('Render failed:', err);
    $('#render-status').textContent = `error: ${err.message}`;
  } finally {
    rendering = false;
    refreshUI();
  }
}

function encodeWav(left, right, sampleRate) {
  const n = left.length;
  const buffer = new ArrayBuffer(44 + n * 4);
  const view = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * 4, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    view.setInt16(off, Math.max(-1, Math.min(1, left[i])) * 32767, true); off += 2;
    view.setInt16(off, Math.max(-1, Math.min(1, right[i])) * 32767, true); off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ── Hand control (MediaPipe) ─────────────────────────────────────────────────

const handState = {
  running: false,
  landmarker: null,
  video: null,
  stream: null,
  features: null,        // {x, y, open, pinch, raw63}
  decodePending: false,
  winStart: 0,
  winLen: 8,
  randProj: null,        // Float32Array(C*63), lazily seeded
};

async function startHand() {
  const work = computeWorking();
  if (!work) { $('#hand-status').textContent = 'Load a model and Sound A first.'; return; }
  $('#hand-toggle').disabled = true;
  $('#hand-status').textContent = 'Loading hand tracker…';
  $('#hand-stage').classList.remove('hidden');
  try {
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
    handState.landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
    });
    handState.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 } });
    const video = $('#hand-video');
    video.srcObject = handState.stream;
    await video.play();
    handState.video = video;
    handState.running = true;
    getAudioCtx();
    $('#hand-toggle').textContent = 'Stop hand control';
    $('#hand-toggle').disabled = false;
    $('#hand-status').textContent = 'Show a hand to the camera…';
    requestAnimationFrame(handFrame);
    handDecodeLoop();
  } catch (err) {
    console.error('Hand control failed to start:', err);
    $('#hand-status').textContent = `error: ${err.message}`;
    stopHand();
  }
}

function stopHand() {
  handState.running = false;
  handState.stream?.getTracks().forEach((t) => t.stop());
  handState.stream = null;
  handState.landmarker?.close();
  handState.landmarker = null;
  handState.features = null;
  stopLoop();
  $('#hand-toggle').textContent = 'Start hand control';
  $('#hand-toggle').disabled = !model || !slots.A.latents;
  $('#hand-stage').classList.add('hidden');
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

function extractFeatures(lm) {
  const wrist = lm[0];
  const scale = dist(wrist, lm[9]) || 1e-3;                 // wrist → middle MCP
  const tips = [8, 12, 16, 20];
  const open = tips.reduce((s, i) => s + dist(lm[i], wrist), 0) / tips.length / scale;
  const pinch = dist(lm[4], lm[8]) / scale;
  const raw = new Float32Array(63);
  for (let i = 0; i < 21; i++) {
    raw[i * 3] = (lm[i].x - wrist.x) / scale;
    raw[i * 3 + 1] = (lm[i].y - wrist.y) / scale;
    raw[i * 3 + 2] = ((lm[i].z || 0) - (wrist.z || 0)) / scale;
  }
  return {
    x: Math.min(1, Math.max(0, 1 - wrist.x)),               // mirrored: right = forward
    y: Math.min(1, Math.max(0, 1 - wrist.y)),               // up = 1
    open: Math.min(1, Math.max(0, (open - 1.2) / 1.0)),
    pinch: Math.min(1, Math.max(0, pinch / 1.2)),
    raw,
  };
}

function handFrame() {
  if (!handState.running) return;
  const { video, landmarker } = handState;
  const canvas = $('#hand-canvas');
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(-1, 1);                                          // mirror preview
  ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
  ctx.restore();
  try {
    const res = landmarker.detectForVideo(video, performance.now());
    if (res.landmarks?.length) {
      const lm = res.landmarks[0];
      handState.features = extractFeatures(lm);
      ctx.fillStyle = '#7aff9f';
      for (const p of lm) {
        ctx.beginPath();
        ctx.arc((1 - p.x) * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const f = handState.features;
      $('#meter-x').style.width = `${f.x * 100}%`;
      $('#meter-y').style.width = `${f.y * 100}%`;
      $('#meter-open').style.width = `${f.open * 100}%`;
      $('#meter-pinch').style.width = `${f.pinch * 100}%`;
    } else {
      handState.features = null;
    }
  } catch (err) {
    console.error('Hand detection failed:', err);
    $('#hand-status').textContent = `detection error: ${err.message}`;
  }
  requestAnimationFrame(handFrame);
}

/** Map current hand features to a latent window and decode it; loop forever. */
async function handDecodeLoop() {
  while (handState.running) {
    const f = handState.features;
    const work = computeWorking();
    if (!f || !work) { await new Promise((r) => setTimeout(r, 120)); continue; }

    const fixed = model.fixedFrames;
    const winLen = fixed ? Math.min(fixed, work.frames) : Math.min(+$('#hand-window').value, work.frames);
    const start = Math.round(f.x * Math.max(0, work.frames - winLen));
    handState.winStart = start;
    handState.winLen = winLen;
    drawLatents(work);

    // window slice (channel-major)
    const win = new Float32Array(C * winLen);
    for (let c = 0; c < C; c++) win.set(work.latents.subarray(c * work.frames + start, c * work.frames + start + winLen), c * winLen);

    const amt = +$('#hand-amount').value;
    const std = latentStd(win);
    if ($('#hand-mapping').value === 'random') {
      // 63 keypoint coords → 256-dim latent vector through a fixed random projection
      if (!handState.randProj) {
        const rand = mulberry32(777);
        handState.randProj = new Float32Array(C * 63);
        for (let i = 0; i < handState.randProj.length; i++) {
          const u1 = Math.max(rand(), 1e-12), u2 = rand();
          handState.randProj[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        }
      }
      for (let c = 0; c < C; c++) {
        let s = 0;
        for (let j = 0; j < 63; j++) s += handState.randProj[c * 63 + j] * f.raw[j];
        const o = amt * std * 0.35 * s / Math.sqrt(63);
        for (let ff = 0; ff < winLen; ff++) win[c * winLen + ff] += o;
      }
    } else {
      const pca = ensurePCA(work);
      const drive = [(f.y - 0.5) * 2, (f.open - 0.5) * 2];
      for (let d = 0; d < 2; d++) {
        const v = pca.comps[d], s = amt * pca.sigmas[d] * 1.5 * drive[d];
        if (!s) continue;
        for (let c = 0; c < C; c++) {
          const o = s * v[c];
          for (let ff = 0; ff < winLen; ff++) win[c * winLen + ff] += o;
        }
      }
      const g = 0.4 + 1.6 * (1 - f.pinch);                  // pinch closed → louder
      if (g !== 1) for (let i = 0; i < win.length; i++) win[i] *= g;
    }

    try {
      const t0 = performance.now();
      const { left, right, ms } = await decodeLatents(win, winLen);
      if (!handState.running) break;
      playLoopCrossfade(left, right);
      $('#hand-status').textContent =
        `decoding ${(winLen * HOP / SR).toFixed(2)}s windows in ${(ms / 1000).toFixed(2)}s (${((performance.now() - t0) / 1000).toFixed(2)}s round-trip)`;
    } catch (err) {
      console.error('Hand decode failed:', err);
      $('#hand-status').textContent = `decode error: ${err.message}`;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

$('#hand-toggle').addEventListener('click', () => (handState.running ? stopHand() : startHand()));

// ── UI wiring ────────────────────────────────────────────────────────────────

const fmt = (v, d = 2) => (+v).toFixed(d);
const liveControls = [
  ['#morph', '#morph-val', (v) => fmt(v)],
  ['#gain', '#gain-val', (v) => fmt(v)],
  ['#noise', '#noise-val', (v) => fmt(v)],
  ['#smooth', '#smooth-val', (v) => `${v}`],
  ['#stretch', '#stretch-val', (v) => `${fmt(v)}×`],
  ['#hand-amount', '#hand-amount-val', (v) => fmt(v, 1)],
  ['#hand-window', '#hand-window-val', (v) => `${v} frames`],
];
for (const [sel, valSel, f] of liveControls) {
  $(sel).addEventListener('input', () => { $(valSel).textContent = f($(sel).value); refreshUI(); });
  $(valSel).textContent = f($(sel).value);
}
$('#reverse').addEventListener('change', refreshUI);
$('#render').addEventListener('click', render);
$('#stop-play').addEventListener('click', stopPlayback);
$('#pca-details').addEventListener('toggle', () => {
  if ($('#pca-details').open && slots.A.latents) {
    const work = computeWorking();
    if (work) ensurePCA(work);
  }
});

function refreshUI() {
  const haveA = !!slots.A.latents;
  $('#morph').disabled = !(slots.A.latents && slots.B.latents);
  $('#render').disabled = !haveA || !model || rendering;
  $('#hand-toggle').disabled = (!haveA || !model) && !handState.running;
  if (!handState.running) drawLatents(computeWorking());
}

refreshUI();

// Debug/testing hook (e.g. injecting synthetic hand features in automated tests).
window.latentExplorerDebug = { handState, slots, computeWorking };
