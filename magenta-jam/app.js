/**
 * Magenta Jam — page glue: UI ↔ worker ↔ AudioWorklet.
 * The worker (worker.js) owns the models and generation; this file only wires
 * controls, the piano keyboard and low-latency PCM playback.
 */
import { Keyboard } from './keyboard.js';

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
};
const ui = {
  prompt: $('prompt'), apply: $('apply'), start: $('start'), stop: $('stop'), volume: $('volume'), backend: $('backend'),
  status: $('status'), progress: $('progress'), stats: $('stats'), log: $('log'), logDetails: $('log-details'),
  styleStrength: $('style-strength'), noteStrength: $('note-strength'), temperature: $('temperature'), topk: $('topk'),
  octaveDown: $('octave-down'), octaveUp: $('octave-up'), octave: $('octave'), keyboard: $('keyboard'),
};

const logLine = (msg) => {
  ui.log.textContent += `${new Date().toLocaleTimeString()} ${msg}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
};
const setStatus = (text, isError = false) => {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', isError);
};
const fail = (msg) => { console.error(msg); logLine('ERROR ' + msg); setStatus(String(msg).split('\n')[0], true); ui.logDetails.open = true; };
window.addEventListener('error', (e) => fail(e.error?.stack || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason?.stack || e.reason));

// ------------------------------------------------------------------ worker
const worker = new Worker('./worker.js'); // classic worker, see worker.js header
const musiccoca = new Worker('./musiccoca-worker.js');   // prompt → style tokens, in its own WASM heap
let ready = false, playing = false, promptId = 0;
musiccoca.onerror = (e) => fail(`musiccoca worker failed to load: ${e.message} (${e.filename}:${e.lineno})`);
musiccoca.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'log': logLine(m.msg); break;
    case 'ready': break;
    case 'tokens':
      if (m.id !== promptId) break;                       // a newer prompt is already in flight
      worker.postMessage({ type: 'style', tokens: m.tokens });
      setStatus(m.tokens ? `Style: "${m.text}"${playing ? ' — playing' : ''}` : 'Style prompt cleared (model is free)');
      break;
    case 'error': fail(m.error); break;
    default: fail('unknown musiccoca message ' + m.type);
  }
};
worker.onerror = (e) => fail(`worker failed to load: ${e.message} (${e.filename}:${e.lineno})`);
worker.onmessage = async (e) => {
  const m = e.data;
  switch (m.type) {
    case 'log': logLine(m.msg); break;
    case 'progress':
      ui.progress.hidden = false; ui.progress.value = m.pct; setStatus(m.note); break;
    case 'ready':
      ready = true; ui.progress.hidden = true;
      setStatus(`Ready on ${m.backend}${m.fullyAccelerated ? '' : ' (partly on CPU)'} — press Start`);
      ui.start.disabled = false; ui.backend.disabled = true;
      break;
    case 'pcm': await audio.push(m.pcm); break;
    case 'stats':
      ui.stats.textContent = `llm ${m.llmMs.toFixed(0)} ms + decode ${m.decMs.toFixed(0)} ms per 40 ms frame · ${m.speed.toFixed(2)}× real-time · ${m.ahead.toFixed(2)} s buffered · peak ${m.peak.toFixed(2)}${m.speed < 1 ? ' — too slow for gapless playback' : ''}`;
      break;
    case 'stopped': playing = false; ui.start.disabled = !ready; ui.stop.disabled = true; setStatus('Stopped'); break;
    case 'error': fail(m.error); ui.start.disabled = !ready; ui.stop.disabled = true; break;
    default: fail('unknown worker message ' + m.type);
  }
};

// ------------------------------------------------------------------ audio
const audio = {
  ctx: null, node: null, gain: null,
  async start() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      if (navigator.audioSession) navigator.audioSession.type = 'playback'; // iOS: play even on silent
      await this.ctx.audioWorklet.addModule('./pcm-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'pcm-player', { outputChannelCount: [2] });
      this.gain = this.ctx.createGain();
      this.node.connect(this.gain).connect(this.ctx.destination);
      this.node.port.onmessage = (e) => {
        const s = e.data;
        worker.postMessage({ type: 'consumed', samples: s.consumed });
      };
      this.setVolume(Number(ui.volume.value));
      logLine(`audio: ${this.ctx.sampleRate} Hz, base latency ${(this.ctx.baseLatency * 1000).toFixed(0)} ms`);
    }
    await this.ctx.resume();
    this.node.port.postMessage({ type: 'reset' });
  },
  async push(pcm) { this.node.port.postMessage({ type: 'pcm', pcm }, [pcm.buffer]); },
  setVolume(v) { if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); },
};

// ------------------------------------------------------------------ controls
const sendParams = () => worker.postMessage({ type: 'params', params: {
  temperature: Number(ui.temperature.value), topK: Number(ui.topk.value),
  cfgStyle: Number(ui.styleStrength.value), cfgNotes: Number(ui.noteStrength.value),
} });
for (const el of [ui.styleStrength, ui.noteStrength, ui.temperature, ui.topk]) {
  const out = $(el.id + '-val');
  el.addEventListener('input', () => { out.textContent = el.value; sendParams(); });
  out.textContent = el.value;
}
ui.volume.addEventListener('input', () => audio.setVolume(Number(ui.volume.value)));

const applyPrompt = () => musiccoca.postMessage({ type: 'prompt', id: ++promptId, text: ui.prompt.value });
ui.apply.addEventListener('click', applyPrompt);
ui.prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyPrompt(); } });
for (const chip of document.querySelectorAll('.preset')) {
  chip.addEventListener('click', () => { ui.prompt.value = chip.dataset.prompt; applyPrompt(); });
}

ui.start.addEventListener('click', async () => {
  ui.start.disabled = true;
  try {
    await audio.start();
    if (!ready) {
      setStatus('Loading models…');
      // ?hf=<base url> overrides where the MusicCoCa files come from (used by the e2e test).
      const hf = new URLSearchParams(location.search).get('hf') || undefined;
      const untilReady = (w) => new Promise((resolve, reject) => {
        const onMsg = (e) => {
          if (e.data.type === 'ready') { w.removeEventListener('message', onMsg); resolve(); }
          if (e.data.type === 'error') { w.removeEventListener('message', onMsg); reject(new Error(e.data.error)); }
        };
        w.addEventListener('message', onMsg);
      });
      worker.postMessage({ type: 'init', backend: ui.backend.value });
      musiccoca.postMessage({ type: 'init', hf, cache: 'magenta-jam-models-v1' });
      await Promise.all([untilReady(worker), untilReady(musiccoca)]);
      applyPrompt();
      sendParams();
    }
    playing = true;
    ui.stop.disabled = false;
    setStatus('Playing — hold keys or change the prompt');
    worker.postMessage({ type: 'start' });
  } catch (err) {
    fail(err.stack || err);
    ui.start.disabled = !ready;
  }
});
ui.stop.addEventListener('click', () => { ui.stop.disabled = true; worker.postMessage({ type: 'stop' }); });

// ------------------------------------------------------------------ keyboard
const keyboard = new Keyboard(ui.keyboard, {
  onNoteOn: (pitch) => worker.postMessage({ type: 'noteOn', pitch }),
  onNoteOff: (pitch) => worker.postMessage({ type: 'noteOff', pitch }),
});
const noteName = (n) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12] + (Math.floor(n / 12) - 1);
const showOctave = () => { ui.octave.textContent = `${noteName(keyboard.baseOctaveNote)}–${noteName(keyboard.baseOctaveNote + 12)}`; };
// Keyboard.setBaseOctaveNote throws outside the rendered range; the buttons just stop at the edges.
const shiftOctave = (delta) => {
  const n = keyboard.baseOctaveNote + delta;
  if (n >= keyboard.lowNote && n + 12 <= keyboard.highNote) { keyboard.setBaseOctaveNote(n); showOctave(); }
};
ui.octaveDown.addEventListener('click', () => shiftOctave(-12));
ui.octaveUp.addEventListener('click', () => shiftOctave(12));
document.addEventListener('keydown', (e) => { if (e.code === 'KeyZ' || e.code === 'KeyX') setTimeout(showOctave); });
showOctave();

if (!('gpu' in navigator)) logLine('WebGPU not available in this browser — the CPU (WASM) backend is much slower');
setStatus('Idle — press Start to download the models (~600 MB once) and play');
