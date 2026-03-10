(function () {
  'use strict';

  // ── State ──────────────────────────────────────
  var state = {
    bpm: 120,
    tsNum: 4,
    tsDen: 4,
    isPlaying: false,
    currentBeat: 0,
    currentSub: 0,
    accents: [2, 1, 1, 1],           // per-beat: 0=muted, 1=normal, 2=accented
    beatSubdivisions: [1, 1, 1, 1],  // per-beat subdivision count (1..8)
    beatSubMutes: [[], [], [], []]    // beatSubMutes[i][j] = is sub (j+1) muted for beat i
  };

  // ── SVG visual constants ───────────────────────
  var SIZE = 60;                     // beat dot diameter in px
  var CX = SIZE / 2, CY = SIZE / 2;
  var R  = SIZE / 2 - 2;            // circle radius (leaves room for stroke)
  var NS = 'http://www.w3.org/2000/svg';

  // Colors matching the CSS theme
  var C = {
    bg:        '#0d0d1a',
    beatNorm:  '#252550',   // normal main-beat fill
    beatAcc:   '#3a1808',   // accented main-beat fill (dark orange tint)
    border:    '#333366',   // normal border
    borderAcc: '#ff6b35',   // accented border
    subFill:   '#1a1a3a',   // subdivision slice fill
    subMuted:  '#0f0f22',   // muted subdivision fill
    sep:       '#0d0d1a'    // separator line (matches bg for clean gap)
  };

  // ── Time signature presets ─────────────────────
  var PRESETS = [
    { n: 2, d: 4 }, { n: 3, d: 4 }, { n: 4, d: 4 }, { n: 5, d: 4 },
    { n: 6, d: 4 }, { n: 7, d: 4 }, { n: 3, d: 8 }, { n: 5, d: 8 },
    { n: 6, d: 8 }, { n: 7, d: 8 }, { n: 9, d: 8 }, { n: 12, d: 8 }
  ];

  // ── DOM refs ───────────────────────────────────
  var tsNumEl    = document.getElementById('ts-num');
  var tsDenEl    = document.getElementById('ts-den');
  var beatsEl    = document.getElementById('beats');
  var bpmValueEl = document.getElementById('bpm-value');
  var bpmSlider  = document.getElementById('bpm-slider');
  var playBtn    = document.getElementById('play-btn');
  var tapBtn     = document.getElementById('tap-btn');
  var tsPicker   = document.getElementById('ts-picker');
  var tsPresetsEl = document.getElementById('ts-presets');

  // ── Audio engine ───────────────────────────────
  var audioCtx = null;
  var SCHEDULE_AHEAD = 0.1;
  var TIMER_INTERVAL = 25;
  var nextNoteTime = 0.0;
  var timerId = null;
  var beatEls = [];

  /** Ensure AudioContext exists and is running. */
  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Tell iOS to play audio even when the device is on silent.
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function (err) {
        console.error('AudioContext resume failed:', err);
      });
    }
  }

  /**
   * Schedule a short click sound at the given AudioContext time.
   * @param {number} time - AudioContext schedule time
   * @param {'accent'|'normal'|'muted'|'sub'} type
   */
  function createClick(time, type) {
    if (type === 'muted') return;
    var osc  = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    if (type === 'accent') {
      osc.frequency.value = 1000;
      gain.gain.setValueAtTime(1.0, time);
    } else if (type === 'normal') {
      osc.frequency.value = 800;
      gain.gain.setValueAtTime(0.5, time);
    } else {
      // subdivision: quieter, lower pitch
      osc.frequency.value = 600;
      gain.gain.setValueAtTime(0.2, time);
    }
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
    osc.start(time);
    osc.stop(time + 0.03);
  }

  /** Beat duration in seconds based on denominator and BPM. */
  function beatDuration() {
    switch (state.tsDen) {
      case 2:  return 120.0 / state.bpm;
      case 8:  return 30.0  / state.bpm;
      case 16: return 15.0  / state.bpm;
      default: return 60.0  / state.bpm;
    }
  }

  /** Schedule the next sub-note and advance beat/sub counters. */
  function scheduleNote() {
    var beat = state.currentBeat;
    var subs = state.beatSubdivisions[beat];

    // Guard against out-of-bounds currentSub (e.g. if subs decreased mid-play)
    if (state.currentSub >= subs) {
      state.currentSub = 0;
      state.currentBeat = (state.currentBeat + 1) % state.tsNum;
      beat = state.currentBeat;
      subs = state.beatSubdivisions[beat];
    }

    var sub = state.currentSub;
    if (sub === 0) {
      var accent = state.accents[beat];
      createClick(nextNoteTime, accent === 2 ? 'accent' : accent === 1 ? 'normal' : 'muted');
      // Visual highlight synced to audio
      var delay = Math.max(0, (nextNoteTime - audioCtx.currentTime) * 1000);
      (function (b) { setTimeout(function () { highlightBeat(b); }, delay); }(beat));
    } else if (!state.beatSubMutes[beat][sub - 1]) {
      createClick(nextNoteTime, 'sub');
    }

    state.currentSub++;
    if (state.currentSub >= subs) {
      state.currentSub = 0;
      state.currentBeat = (state.currentBeat + 1) % state.tsNum;
    }
    // Each subdivision slot occupies beatDuration/subs seconds
    nextNoteTime += beatDuration() / subs;
  }

  /** Lookahead scheduler. */
  function scheduler() {
    while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) scheduleNote();
  }

  function startMetronome() {
    ensureAudio();
    state.isPlaying  = true;
    state.currentBeat = 0;
    state.currentSub  = 0;
    nextNoteTime = audioCtx.currentTime + 0.05;
    timerId = setInterval(scheduler, TIMER_INTERVAL);
    playBtn.textContent = '\u25A0';
    playBtn.classList.add('playing');
  }

  function stopMetronome() {
    state.isPlaying = false;
    clearInterval(timerId);
    timerId = null;
    clearBeatHighlights();
    playBtn.textContent = '\u25B6';
    playBtn.classList.remove('playing');
  }

  function togglePlay() {
    if (state.isPlaying) stopMetronome();
    else startMetronome();
  }

  // ── SVG helpers ────────────────────────────────

  /**
   * Build a pie-slice SVG path string.
   * Angles are in radians, measured clockwise from the top (-π/2).
   */
  function slicePath(startAngle, endAngle) {
    var x1 = CX + R * Math.cos(startAngle);
    var y1 = CY + R * Math.sin(startAngle);
    var x2 = CX + R * Math.cos(endAngle);
    var y2 = CY + R * Math.sin(endAngle);
    var large = (endAngle - startAngle > Math.PI) ? 1 : 0;
    return 'M' + CX + ',' + CY +
           ' L' + x1 + ',' + y1 +
           ' A' + R + ',' + R + ' 0 ' + large + ',1 ' + x2 + ',' + y2 + ' Z';
  }

  /**
   * Create an SVG element in the SVG namespace with given attributes.
   * Pass 'data-foo' keys directly; special key 'dataset' sets dataset properties.
   */
  function svgEl(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(function (k) {
      if (k === 'dataset') {
        Object.keys(attrs[k]).forEach(function (dk) { el.dataset[dk] = attrs[k][dk]; });
      } else {
        el.setAttribute(k, attrs[k]);
      }
    });
    return el;
  }

  /** Fill color for the main-beat slice based on accent level. */
  function mainFill(accent) {
    return accent === 2 ? C.beatAcc : C.beatNorm;
  }

  /** Border stroke color based on accent level. */
  function borderColor(accent) {
    return accent === 2 ? C.borderAcc : C.border;
  }

  /**
   * Rebuild the SVG inside beatEls[idx] to reflect current state.
   * Draws a full circle (subs=1) or pie slices (subs>1).
   */
  function rebuildBeatSvg(idx) {
    var el = beatEls[idx];
    if (!el) return;
    el.innerHTML = '';

    var subs   = state.beatSubdivisions[idx];
    var accent = state.accents[idx];
    var mutes  = state.beatSubMutes[idx];
    var dashed = accent === 0 ? '4 3' : 'none';

    var svg = svgEl('svg', {
      width: SIZE, height: SIZE,
      viewBox: '0 0 ' + SIZE + ' ' + SIZE
    });

    if (subs === 1) {
      // Simple circle — no pie slices needed
      svg.appendChild(svgEl('circle', {
        cx: CX, cy: CY, r: R,
        fill: mainFill(accent),
        stroke: borderColor(accent),
        'stroke-width': 2,
        'stroke-dasharray': dashed
      }));
    } else {
      // Dark background behind slices
      svg.appendChild(svgEl('circle', {
        cx: CX, cy: CY, r: R,
        fill: C.bg,
        'pointer-events': 'none'
      }));

      // Pie slices — each receives its own click events via data-sub-idx
      for (var i = 0; i < subs; i++) {
        var a0 = (i / subs)       * 2 * Math.PI - Math.PI / 2;
        var a1 = ((i + 1) / subs) * 2 * Math.PI - Math.PI / 2;
        var fill = (i === 0)
          ? mainFill(accent)
          : (mutes[i - 1] ? C.subMuted : C.subFill);
        svg.appendChild(svgEl('path', {
          d: slicePath(a0, a1),
          fill: fill,
          dataset: { subIdx: i }
        }));
      }

      // Separator lines (pointer-events:none so clicks reach slices below)
      for (var k = 0; k < subs; k++) {
        var ang = (k / subs) * 2 * Math.PI - Math.PI / 2;
        svg.appendChild(svgEl('line', {
          x1: CX, y1: CY,
          x2: CX + R * Math.cos(ang),
          y2: CY + R * Math.sin(ang),
          stroke: C.sep,
          'stroke-width': 1.5,
          'pointer-events': 'none'
        }));
      }

      // Border ring drawn on top for clean edge
      svg.appendChild(svgEl('circle', {
        cx: CX, cy: CY, r: R,
        fill: 'none',
        stroke: borderColor(accent),
        'stroke-width': 2,
        'stroke-dasharray': dashed,
        'pointer-events': 'none'
      }));
    }

    el.appendChild(svg);

    // Sync CSS accent classes (used for active-state filter color in CSS)
    el.classList.toggle('accented', accent === 2);
    el.classList.toggle('muted',    accent === 0);
  }

  // ── Beat building ──────────────────────────────

  /** Rebuild all beat DOM elements, preserving state where possible. */
  function buildBeats() {
    beatsEl.innerHTML = '';
    beatEls = [];

    // Resize state arrays, preserving existing values
    var newAccents = [], newSubs = [], newMutes = [];
    for (var i = 0; i < state.tsNum; i++) {
      newAccents.push(i < state.accents.length ? state.accents[i] : (i === 0 ? 2 : 1));
      var s = i < state.beatSubdivisions.length ? state.beatSubdivisions[i] : 1;
      newSubs.push(s);
      var prev = i < state.beatSubMutes.length ? state.beatSubMutes[i] : [];
      var arr = [];
      for (var j = 0; j < s - 1; j++) arr.push(j < prev.length ? prev[j] : false);
      newMutes.push(arr);
    }
    state.accents          = newAccents;
    state.beatSubdivisions = newSubs;
    state.beatSubMutes     = newMutes;

    for (var b = 0; b < state.tsNum; b++) {
      var el = document.createElement('div');
      el.className = 'beat';
      el.dataset.index = b;
      setupBeatInteraction(el, b);
      beatsEl.appendChild(el);
      beatEls.push(el);
      rebuildBeatSvg(b);
    }
  }

  /**
   * Attach drag and click interactions to a beat element.
   *
   * Drag down → increase subdivisions (positive Y = more).
   * Drag up   → decrease subdivisions.
   * Click on main slice (sub-idx 0 or no slice) → cycle accent: normal→accented→muted→normal.
   * Click on sub slice (sub-idx ≥ 1) → toggle that subdivision's mute.
   */
  function setupBeatInteraction(el, idx) {
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var clickTarget = e.target;  // capture element under pointer at drag start
      var startY      = e.clientY;
      var startSubs   = state.beatSubdivisions[idx];
      var dragging    = false;
      var lastSubs    = startSubs;

      function onMove(me) {
        var dy = me.clientY - startY;
        if (!dragging && Math.abs(dy) > 8) dragging = true;
        if (!dragging) return;
        // Every ~22px of drag changes the count by 1; down = add, up = remove
        var n = Math.max(1, Math.min(8, startSubs + Math.round(dy / 22)));
        if (n !== lastSubs) {
          lastSubs = n;
          setBeatSubdivisions(idx, n);
        }
      }

      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup',   onUp);
        if (dragging) return;

        // Determine which pie slice was clicked via data-sub-idx
        var subIdx = (clickTarget && clickTarget.dataset && clickTarget.dataset.subIdx !== undefined)
          ? parseInt(clickTarget.dataset.subIdx, 10) : 0;

        if (subIdx === 0) {
          // Cycle accent on main beat: 1→2→0→1
          var cur = state.accents[idx];
          state.accents[idx] = cur === 1 ? 2 : cur === 2 ? 0 : 1;
          rebuildBeatSvg(idx);
        } else {
          // Toggle mute for subdivision slice
          state.beatSubMutes[idx][subIdx - 1] = !state.beatSubMutes[idx][subIdx - 1];
          rebuildBeatSvg(idx);
        }
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup',   onUp);
    });
  }

  /**
   * Set subdivision count for a beat, resizing its mute array accordingly.
   * @param {number} idx - beat index
   * @param {number} count - new subdivision count (1..8)
   */
  function setBeatSubdivisions(idx, count) {
    state.beatSubdivisions[idx] = count;
    var m = state.beatSubMutes[idx];
    while (m.length < count - 1) m.push(false);
    m.length = count - 1;
    rebuildBeatSvg(idx);
  }

  function highlightBeat(index) {
    for (var i = 0; i < beatEls.length; i++) beatEls[i].classList.remove('active');
    if (index < beatEls.length) beatEls[index].classList.add('active');
  }

  function clearBeatHighlights() {
    for (var i = 0; i < beatEls.length; i++) beatEls[i].classList.remove('active');
  }

  // ── Time signature ─────────────────────────────

  function setTimeSignature(num, den) {
    state.tsNum = num;
    state.tsDen = den;
    tsNumEl.textContent = num;
    tsDenEl.textContent = den;
    // Reset all per-beat state when time signature changes
    state.accents          = [];
    state.beatSubdivisions = [];
    state.beatSubMutes     = [];
    for (var i = 0; i < num; i++) {
      state.accents.push(i === 0 ? 2 : 1);
      state.beatSubdivisions.push(1);
      state.beatSubMutes.push([]);
    }
    buildBeats();
    updatePresetHighlight();
    if (state.isPlaying) { stopMetronome(); startMetronome(); }
  }

  function updatePresetHighlight() {
    var btns = tsPresetsEl.querySelectorAll('.ts-preset');
    btns.forEach(function (btn) {
      var n = parseInt(btn.dataset.num, 10);
      var d = parseInt(btn.dataset.den, 10);
      btn.classList.toggle('selected', n === state.tsNum && d === state.tsDen);
    });
  }

  function buildPresets() {
    PRESETS.forEach(function (p) {
      var btn = document.createElement('button');
      btn.className = 'ts-preset';
      btn.textContent = p.n + '/' + p.d;
      btn.dataset.num = p.n;
      btn.dataset.den = p.d;
      btn.addEventListener('click', function () {
        setTimeSignature(p.n, p.d);
        tsPicker.classList.add('hidden');
      });
      tsPresetsEl.appendChild(btn);
    });
    updatePresetHighlight();
  }

  function openPicker()  { tsPicker.classList.remove('hidden'); }
  function closePicker() { tsPicker.classList.add('hidden'); }

  // ── BPM controls ───────────────────────────────

  function setBpm(val) {
    state.bpm = Math.max(30, Math.min(300, val));
    bpmValueEl.textContent = state.bpm;
    bpmSlider.value = state.bpm;
  }

  /** Long-press repeat for +/- BPM buttons. */
  function setupRepeatButton(btnEl, delta) {
    var intervalId = null, timeoutId = null;
    function stop() {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
      timeoutId = intervalId = null;
    }
    function start(e) {
      e.preventDefault();
      setBpm(state.bpm + delta);
      timeoutId = setTimeout(function () {
        intervalId = setInterval(function () { setBpm(state.bpm + delta); }, 80);
      }, 400);
    }
    btnEl.addEventListener('pointerdown',  start);
    btnEl.addEventListener('pointerup',    stop);
    btnEl.addEventListener('pointerleave', stop);
    btnEl.addEventListener('pointercancel', stop);
  }

  // ── Tap tempo ──────────────────────────────────
  var tapTimes  = [];
  var TAP_TIMEOUT = 2000;
  var TAP_HISTORY = 6;

  function handleTap() {
    ensureAudio();
    var now = performance.now();
    if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > TAP_TIMEOUT) tapTimes = [];
    tapTimes.push(now);
    if (tapTimes.length < 2) return;
    if (tapTimes.length > TAP_HISTORY + 1) tapTimes = tapTimes.slice(-(TAP_HISTORY + 1));
    var sum = 0;
    for (var i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
    setBpm(Math.round(60000 / (sum / (tapTimes.length - 1))));
  }

  // ── Event binding ──────────────────────────────

  // Global subdivision shortcuts — apply the same count to every beat at once.
  // Buttons have no persistent selected state; they're one-shot shortcuts.
  document.querySelectorAll('.sub-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var count = parseInt(btn.dataset.sub, 10);
      for (var i = 0; i < state.tsNum; i++) setBeatSubdivisions(i, count);
    });
  });

  playBtn.addEventListener('click', togglePlay);
  tapBtn.addEventListener('click', handleTap);
  bpmSlider.addEventListener('input', function () { setBpm(parseInt(this.value, 10)); });

  setupRepeatButton(document.getElementById('bpm-down'), -1);
  setupRepeatButton(document.getElementById('bpm-up'),   +1);

  document.getElementById('time-sig-btn').addEventListener('click', openPicker);
  document.getElementById('ts-close').addEventListener('click', closePicker);
  tsPicker.addEventListener('click', function (e) { if (e.target === tsPicker) closePicker(); });

  document.getElementById('ts-custom-ok').addEventListener('click', function () {
    var num = parseInt(document.getElementById('ts-custom-num').value, 10);
    var den = parseInt(document.getElementById('ts-custom-den').value, 10);
    if (num >= 1 && num <= 32) { setTimeSignature(num, den); closePicker(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); togglePlay(); }
  });

  // ── Init ───────────────────────────────────────
  buildPresets();
  buildBeats();
})();
