// Looper — loop and slow down audio for music transcription practice.
// Supports two sources: local audio file and YouTube video.

// ─── Global error visibility ────────────────────────────────
window.addEventListener('error', e => {
  console.error('Unhandled error:', e.error || e.message);
  showError(e.error?.message || e.message || 'Unknown error');
});
window.addEventListener('unhandledrejection', e => {
  console.error('Unhandled rejection:', e.reason);
  showError(e.reason?.message || String(e.reason));
});

function showError(msg) {
  let bar = document.getElementById('error-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'error-bar';
    Object.assign(bar.style, {
      position: 'fixed', top: '0', left: '0', right: '0',
      background: '#e94560', color: 'white', padding: '0.75rem 1rem',
      fontFamily: 'sans-serif', zIndex: '9999', textAlign: 'center',
    });
    bar.onclick = () => bar.remove();
    document.body.appendChild(bar);
  }
  bar.textContent = `Error (click to dismiss): ${msg}`;
}

// ─── DOM references ─────────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {
  tabs: document.querySelectorAll('.tab'),
  panelFile: $('panel-file'),
  panelYt: $('panel-yt'),
  dropZone: $('drop-zone'),
  fileInput: $('file-input'),
  ytForm: $('yt-form'),
  ytUrl: $('yt-url'),

  player: $('player'),
  picker: $('source-picker'),
  waveform: $('waveform'),
  ytEmbed: $('yt-embed'),

  seekBar: $('seek-bar'),
  loopRegion: $('loop-region'),
  handleStart: $('loop-handle-start'),
  handleEnd: $('loop-handle-end'),
  playhead: $('playhead'),
  labelStart: $('loop-label-start'),
  labelEnd: $('loop-label-end'),
  hoverLabel: $('hover-label'),

  timeCur: $('time-current'),
  timeTotal: $('time-total'),

  playBtn: $('play-btn'),
  iconPlay: $('icon-play'),
  iconPause: $('icon-pause'),
  speed: $('speed'),
  speedVal: $('speed-val'),
  loopEnabled: $('loop-enabled'),
  setStart: $('set-start'),
  setEnd: $('set-end'),
  clearLoop: $('clear-loop'),
  newSource: $('new-source'),
};

// ─── Source-tab switching ───────────────────────────────────
els.tabs.forEach(tab => tab.addEventListener('click', () => {
  els.tabs.forEach(t => t.classList.toggle('active', t === tab));
  const which = tab.dataset.tab;
  els.panelFile.classList.toggle('hidden', which !== 'file');
  els.panelYt.classList.toggle('hidden', which !== 'yt');
}));

// ─── File picker / drag-drop ────────────────────────────────
els.dropZone.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', e => {
  const f = e.target.files?.[0];
  if (f) loadFile(f);
});
['dragenter', 'dragover'].forEach(ev =>
  els.dropZone.addEventListener(ev, e => { e.preventDefault(); els.dropZone.classList.add('drag'); })
);
['dragleave', 'drop'].forEach(ev =>
  els.dropZone.addEventListener(ev, e => { e.preventDefault(); els.dropZone.classList.remove('drag'); })
);
els.dropZone.addEventListener('drop', e => {
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// ─── YouTube form ───────────────────────────────────────────
els.ytForm.addEventListener('submit', e => {
  e.preventDefault();
  const id = extractVideoId(els.ytUrl.value.trim());
  if (!id) { showError('Could not parse a YouTube video ID from that input.'); return; }
  loadYouTube(id);
});

function extractVideoId(input) {
  if (!input) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([\w-]{11})/,
    /^([\w-]{11})$/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── Player abstraction ─────────────────────────────────────
// Both implementations expose the same interface so the UI doesn't
// need to know what's playing under the hood.

// SoundTouchJS audio-worklet — WSOLA time-stretching with pitch preservation.
// Higher fidelity than the browser's native <audio>.preservesPitch, and
// works over a much wider tempo range.
const SOUNDTOUCH_BASE = 'https://cdn.jsdelivr.net/npm/@soundtouchjs/audio-worklet@2.0.3/.dist';
let SoundTouchNodeClass = null;
async function loadSoundTouch() {
  if (SoundTouchNodeClass) return SoundTouchNodeClass;
  const mod = await import(`${SOUNDTOUCH_BASE}/index.js`);
  SoundTouchNodeClass = mod.SoundTouchNode;
  return SoundTouchNodeClass;
}

class FilePlayer {
  constructor(ctx, buffer, file) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.file = file;
    this._rate = 1;
    this._playing = false;
    // Playback position is tracked as: anchor + elapsed_ctx_time * rate.
    // Re-anchor on every seek / rate change so the math stays simple.
    this._anchor = 0;
    this._anchorCtxTime = 0;
    this._source = null;
    this._st = null;
    this.ready = this._init();
  }

  async _init() {
    const SoundTouchNode = await loadSoundTouch();
    await SoundTouchNode.register(this.ctx, `${SOUNDTOUCH_BASE}/soundtouch-processor.js`);
    this._st = new SoundTouchNode({
      context: this.ctx,
      outputChannelCount: this.buffer.numberOfChannels,
    });
    this._st.connect(this.ctx.destination);
  }

  get duration() { return this.buffer.duration; }
  get currentTime() {
    if (!this._playing) return clamp(this._anchor, 0, this.duration);
    const t = this._anchor + (this.ctx.currentTime - this._anchorCtxTime) * this._rate;
    return clamp(t, 0, this.duration);
  }

  seek(t) {
    const wasPlaying = this._playing;
    this._stopSource();
    this._anchor = clamp(t, 0, this.duration);
    if (wasPlaying) this._startSource();
  }

  async play() {
    if (this._playing) return;
    await this.ctx.resume();   // satisfy autoplay policy
    this._startSource();
  }

  pause() {
    if (!this._playing) return;
    this._anchor = this.currentTime;
    this._stopSource();
  }

  isPlaying() { return this._playing; }

  setRate(r) {
    if (this._playing) {
      // Re-anchor so currentTime() stays continuous across the rate change.
      this._anchor = this.currentTime;
      this._anchorCtxTime = this.ctx.currentTime;
      if (this._source) this._source.playbackRate.value = r;
      if (this._st) this._st.playbackRate.value = r;
    }
    this._rate = r;
  }

  _startSource() {
    if (this._anchor >= this.duration) this._anchor = 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    // SoundTouchNode compensates pitch when its playbackRate matches the source's.
    this._st.playbackRate.value = this._rate;
    src.connect(this._st);
    src.onended = () => {
      // Only react to a *natural* end — stop()+replace would also fire onended.
      if (this._source === src) {
        this._playing = false;
        this._anchor = this.duration;
        this._source = null;
      }
    };
    this._source = src;
    this._anchorCtxTime = this.ctx.currentTime;
    src.start(0, this._anchor);
    this._playing = true;
  }

  _stopSource() {
    if (this._source) {
      const s = this._source;
      this._source = null;   // clear before stop() so onended is a no-op
      try { s.stop(); } catch (e) { console.error('Source stop failed:', e); }
      try { s.disconnect(); } catch (e) { console.error('Source disconnect failed:', e); }
    }
    this._playing = false;
  }

  destroy() {
    this._stopSource();
    if (this._st) { try { this._st.disconnect(); } catch (e) { console.error('ST disconnect failed:', e); } }
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(e => console.error('ctx close failed:', e));
  }
}

class YouTubePlayer {
  constructor(videoId) {
    this.videoId = videoId;
    this.ready = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this._init();
  }
  async _init() {
    await loadYouTubeAPI();
    this.yt = new YT.Player('yt-embed', {
      videoId: this.videoId,
      playerVars: { playsinline: 1, enablejsapi: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => this._resolve(),
        onError: e => {
          // YT error codes: 2=bad param, 5=html5, 100=not found, 101/150=embed disabled
          const msg = { 2: 'Bad video ID', 5: 'HTML5 player error',
            100: 'Video not found', 101: 'Embedding disabled', 150: 'Embedding disabled' }[e.data] || `code ${e.data}`;
          showError(`YouTube error: ${msg}`);
        },
      },
    });
  }
  get duration() { return this.yt?.getDuration?.() || 0; }
  get currentTime() { return this.yt?.getCurrentTime?.() || 0; }
  seek(t) { this.yt?.seekTo(clamp(t, 0, this.duration), true); }
  play() { this.yt?.playVideo(); }
  pause() { this.yt?.pauseVideo(); }
  isPlaying() { return this.yt?.getPlayerState?.() === YT.PlayerState.PLAYING; }
  setRate(r) {
    // YouTube only allows specific rates; pick the nearest supported.
    const allowed = this.yt?.getAvailablePlaybackRates?.() || [r];
    const nearest = allowed.reduce((a, b) => Math.abs(b - r) < Math.abs(a - r) ? b : a);
    this.yt?.setPlaybackRate(nearest);
  }
  destroy() {
    try { this.yt?.destroy(); } catch (e) { console.error('YT destroy failed:', e); }
  }
}

let ytAPILoaded = null;
function loadYouTubeAPI() {
  if (ytAPILoaded) return ytAPILoaded;
  ytAPILoaded = new Promise(resolve => {
    if (window.YT && window.YT.Player) return resolve();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => resolve();
  });
  return ytAPILoaded;
}

// ─── App state ──────────────────────────────────────────────
let player = null;
let mode = null;            // 'file' | 'yt'
let loopStart = null;       // seconds, null = unset
let loopEnd = null;
let waveformData = null;    // cached channel data for redrawing on resize
let rafId = null;

// ─── Source loaders ─────────────────────────────────────────
async function loadFile(file) {
  await switchToPlayer('file');
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Allow playback while the iOS mute switch is on.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const p = new FilePlayer(ctx, buf, file);
    await p.ready;
    setPlayer(p);
    waveformData = buf.getChannelData(0);
    renderWaveform();
  } catch (e) {
    console.error('Could not load file:', e);
    showError(`Could not load file: ${e.message || e}`);
  }
}

async function loadYouTube(videoId) {
  await switchToPlayer('yt');
  const p = new YouTubePlayer(videoId);
  try {
    await p.ready;
  } catch (e) {
    showError(`Could not load YouTube video: ${e.message}`);
    return;
  }
  setPlayer(p);
}

async function switchToPlayer(newMode) {
  if (player) { player.destroy(); player = null; }
  mode = newMode;
  els.picker.classList.add('hidden');
  els.player.classList.remove('hidden');
  els.waveform.classList.toggle('hidden', newMode !== 'file');
  els.ytEmbed.classList.toggle('hidden', newMode !== 'yt');
  loopStart = null;
  loopEnd = null;
  waveformData = null;
  // File mode uses SoundTouchJS, which is happy with extreme stretch ratios;
  // YouTube only supports 0.25–2 (and snaps to a small set of allowed rates).
  els.speed.min = '0.25';
  els.speed.max = newMode === 'file' ? '3' : '2';
  if (parseFloat(els.speed.value) > parseFloat(els.speed.max)) {
    els.speed.value = els.speed.max;
    els.speedVal.textContent = `${parseFloat(els.speed.max).toFixed(2)}×`;
  }
  updateLoopUI();
}

function setPlayer(p) {
  player = p;
  els.timeTotal.textContent = formatTime(player.duration);
  p.setRate(parseFloat(els.speed.value));
  startUILoop();
}

// ─── Waveform drawing ───────────────────────────────────────
function renderWaveform() {
  if (!waveformData) return;
  const canvas = els.waveform;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  c.clearRect(0, 0, cssW, cssH);
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--wave').trim() || '#5b8def';

  const samplesPerPx = Math.max(1, Math.floor(waveformData.length / cssW));
  const mid = cssH / 2;
  for (let x = 0; x < cssW; x++) {
    let min = 1, max = -1;
    const start = x * samplesPerPx;
    const end = Math.min(start + samplesPerPx, waveformData.length);
    for (let i = start; i < end; i++) {
      const v = waveformData[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - max) * mid;
    const y2 = (1 - min) * mid;
    c.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

const ro = new ResizeObserver(() => renderWaveform());
ro.observe(els.waveform);

// ─── Seek bar interactions ──────────────────────────────────
// Click → seek. Drag (> threshold) → define a new loop region.
// Handles can be re-dragged to adjust either end.
const DRAG_THRESHOLD = 4;  // px before mouse-move counts as drag

let dragState = null;  // { kind: 'seek'|'loop'|'handle-start'|'handle-end', startX, startT }

function barRect() { return els.seekBar.getBoundingClientRect(); }
function xToTime(x) {
  if (!player) return 0;
  const r = barRect();
  return clamp((x - r.left) / r.width, 0, 1) * player.duration;
}

els.seekBar.addEventListener('pointerdown', e => {
  if (!player || !player.duration) return;
  // Handles take priority — handled by their own listeners.
  if (e.target === els.handleStart || e.target === els.handleEnd) return;
  els.seekBar.setPointerCapture(e.pointerId);
  dragState = { kind: 'maybe', startX: e.clientX, startT: xToTime(e.clientX) };
});

els.seekBar.addEventListener('pointermove', e => {
  if (!dragState || !player) return;
  if (dragState.kind === 'maybe') {
    if (Math.abs(e.clientX - dragState.startX) < DRAG_THRESHOLD) return;
    dragState.kind = 'loop';
  }
  if (dragState.kind === 'loop') {
    const t = xToTime(e.clientX);
    loopStart = Math.min(dragState.startT, t);
    loopEnd = Math.max(dragState.startT, t);
    updateLoopUI();
  }
});

els.seekBar.addEventListener('pointerup', e => {
  if (!dragState || !player) { dragState = null; return; }
  if (dragState.kind === 'maybe') {
    // Treat as a click-to-seek.
    player.seek(xToTime(e.clientX));
    updatePlayhead();
  } else if (dragState.kind === 'loop') {
    // Tiny accidental loops get cleared.
    if (loopEnd - loopStart < 0.05) {
      loopStart = null; loopEnd = null;
      updateLoopUI();
    }
  }
  dragState = null;
});

function attachHandle(el, which) {
  el.addEventListener('pointerdown', e => {
    if (!player) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    dragState = { kind: 'handle', which };
    // Pointer events route to the handle while captured, so the seek-bar's
    // hover label can't update — hide it so it doesn't show a stale time.
    els.hoverLabel.classList.add('hidden');
  });
  el.addEventListener('pointermove', e => {
    if (dragState?.kind !== 'handle' || dragState.which !== which || !player) return;
    const t = xToTime(e.clientX);
    if (which === 'start') loopStart = Math.min(t, loopEnd ?? player.duration);
    else loopEnd = Math.max(t, loopStart ?? 0);
    updateLoopUI();
  });
  el.addEventListener('pointerup', e => {
    if (dragState?.kind === 'handle') dragState = null;
    el.releasePointerCapture(e.pointerId);
  });
}
attachHandle(els.handleStart, 'start');
attachHandle(els.handleEnd, 'end');

// ─── Transport controls ─────────────────────────────────────
els.playBtn.addEventListener('click', () => {
  if (!player) return;
  if (player.isPlaying()) player.pause();
  else player.play();
  updatePlayIcon();
});

els.speed.addEventListener('input', () => {
  const r = parseFloat(els.speed.value);
  els.speedVal.textContent = `${r.toFixed(2)}×`;
  if (player) player.setRate(r);
});

els.setStart.addEventListener('click', () => {
  if (!player) return;
  loopStart = player.currentTime;
  if (loopEnd != null && loopEnd <= loopStart) loopEnd = null;
  updateLoopUI();
});
els.setEnd.addEventListener('click', () => {
  if (!player) return;
  loopEnd = player.currentTime;
  if (loopStart != null && loopStart >= loopEnd) loopStart = null;
  updateLoopUI();
});
els.clearLoop.addEventListener('click', () => {
  loopStart = null;
  loopEnd = null;
  updateLoopUI();
});

els.newSource.addEventListener('click', () => {
  if (player) { player.destroy(); player = null; }
  if (rafId) cancelAnimationFrame(rafId);
  els.player.classList.add('hidden');
  els.picker.classList.remove('hidden');
  els.fileInput.value = '';
  els.ytUrl.value = '';
});

// Keyboard shortcuts: space=play/pause, arrows=seek 2s, [/]=set loop, \=clear.
document.addEventListener('keydown', e => {
  if (!player) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.code === 'Space') { e.preventDefault(); els.playBtn.click(); }
  else if (e.key === 'ArrowLeft') player.seek(player.currentTime - 2);
  else if (e.key === 'ArrowRight') player.seek(player.currentTime + 2);
  else if (e.key === '[') els.setStart.click();
  else if (e.key === ']') els.setEnd.click();
  else if (e.key === '\\') els.clearLoop.click();
});

// ─── Per-frame UI loop ──────────────────────────────────────
function startUILoop() {
  if (rafId) cancelAnimationFrame(rafId);
  const tick = () => {
    if (!player) return;
    // Loop-back when current time crosses loopEnd.
    if (els.loopEnabled.checked
        && loopStart != null && loopEnd != null
        && player.isPlaying()
        && player.currentTime >= loopEnd) {
      player.seek(loopStart);
    }
    updatePlayhead();
    updatePlayIcon();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function updatePlayhead() {
  if (!player || !player.duration) return;
  const pct = (player.currentTime / player.duration) * 100;
  els.playhead.style.left = `${pct}%`;
  els.timeCur.textContent = formatTime(player.currentTime);
  // Total may take a moment to resolve on YouTube.
  els.timeTotal.textContent = formatTime(player.duration);
}

function updatePlayIcon() {
  const playing = player?.isPlaying();
  els.iconPlay.classList.toggle('hidden', !!playing);
  els.iconPause.classList.toggle('hidden', !playing);
}

function updateLoopUI() {
  const haveBoth = loopStart != null && loopEnd != null && player?.duration;
  els.loopRegion.classList.toggle('hidden', !haveBoth);
  els.handleStart.classList.toggle('hidden', loopStart == null || !player?.duration);
  els.handleEnd.classList.toggle('hidden', loopEnd == null || !player?.duration);
  els.labelStart.classList.toggle('hidden', loopStart == null || !player?.duration);
  els.labelEnd.classList.toggle('hidden', loopEnd == null || !player?.duration);
  if (!player?.duration) return;
  const d = player.duration;
  if (loopStart != null) {
    const pct = (loopStart / d) * 100;
    els.handleStart.style.left = `${pct}%`;
    els.labelStart.style.left = `${pct}%`;
    els.labelStart.textContent = formatTimePrecise(loopStart);
  }
  if (loopEnd != null) {
    const pct = (loopEnd / d) * 100;
    els.handleEnd.style.left = `${pct}%`;
    els.labelEnd.style.left = `${pct}%`;
    els.labelEnd.textContent = formatTimePrecise(loopEnd);
  }
  if (haveBoth) {
    const left = (loopStart / d) * 100;
    const width = ((loopEnd - loopStart) / d) * 100;
    els.loopRegion.style.left = `${left}%`;
    els.loopRegion.style.width = `${width}%`;
  }
}

// ─── Hover tooltip on the seek bar ──────────────────────────
// Shows the time corresponding to the cursor position so the user
// can pick a precise loop point. Uses pointer events so it also
// tracks the finger during touch drags.
function updateHoverLabel(clientX) {
  if (!player?.duration) return;
  const r = barRect();
  const pct = clamp((clientX - r.left) / r.width, 0, 1);
  els.hoverLabel.style.left = `${pct * 100}%`;
  els.hoverLabel.textContent = formatTimePrecise(pct * player.duration);
  els.hoverLabel.classList.remove('hidden');
}
els.seekBar.addEventListener('pointermove', e => updateHoverLabel(e.clientX));
els.seekBar.addEventListener('pointerdown', e => updateHoverLabel(e.clientX));
els.seekBar.addEventListener('pointerleave', () => els.hoverLabel.classList.add('hidden'));
els.seekBar.addEventListener('pointercancel', () => els.hoverLabel.classList.add('hidden'));

// ─── Helpers ────────────────────────────────────────────────
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function formatTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
// One-decimal precision — useful when picking a loop point by ear.
function formatTimePrecise(s) {
  if (!isFinite(s) || s < 0) return '0:00.0';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const secStr = sec.toFixed(1).padStart(4, '0');  // e.g. "07.3"
  return `${m}:${secStr}`;
}
