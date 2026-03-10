(function () {
  'use strict';

  // ── State ──────────────────────────────────────
  // Accent levels: 0 = muted, 1 = normal, 2 = accented
  var state = {
    bpm: 120,
    tsNum: 4,
    tsDen: 4,
    isPlaying: false,
    currentBeat: 0,
    currentSub: 0,
    subdivision: 1,          // 1=off, 2=8ths, 3=triplets, 4=16ths
    accents: [2, 1, 1, 1]    // per-beat accent levels
  };

  // ── Time signature presets ─────────────────────
  var PRESETS = [
    { n: 2, d: 4 }, { n: 3, d: 4 }, { n: 4, d: 4 }, { n: 5, d: 4 },
    { n: 6, d: 4 }, { n: 7, d: 4 }, { n: 3, d: 8 }, { n: 5, d: 8 },
    { n: 6, d: 8 }, { n: 7, d: 8 }, { n: 9, d: 8 }, { n: 12, d: 8 }
  ];

  // ── DOM refs ───────────────────────────────────
  var tsNumEl = document.getElementById('ts-num');
  var tsDenEl = document.getElementById('ts-den');
  var beatsEl = document.getElementById('beats');
  var bpmValueEl = document.getElementById('bpm-value');
  var bpmSlider = document.getElementById('bpm-slider');
  var playBtn = document.getElementById('play-btn');
  var tapBtn = document.getElementById('tap-btn');
  var tsPicker = document.getElementById('ts-picker');
  var tsPresetsEl = document.getElementById('ts-presets');
  var subBtns = document.querySelectorAll('.sub-btn');

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
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function (err) {
        console.error('AudioContext resume failed:', err);
      });
    }
  }

  /**
   * Schedule a click at the given AudioContext time.
   * @param {number} time - AudioContext schedule time
   * @param {'accent'|'normal'|'muted'|'sub'} type - click type
   */
  function createClick(time, type) {
    if (type === 'muted') return;

    var osc = audioCtx.createOscillator();
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
      // subdivision click: quieter, lower pitch
      osc.frequency.value = 600;
      gain.gain.setValueAtTime(0.2, time);
    }

    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
    osc.start(time);
    osc.stop(time + 0.03);
  }

  /** Beat duration in seconds, based on denominator and BPM. */
  function beatDuration() {
    switch (state.tsDen) {
      case 2:  return 120.0 / state.bpm;
      case 8:  return 30.0 / state.bpm;
      case 16: return 15.0 / state.bpm;
      default: return 60.0 / state.bpm;
    }
  }

  /** Schedule the next sub-note and advance counters. */
  function scheduleNote() {
    var isMainBeat = state.currentSub === 0;

    if (isMainBeat) {
      // Determine click type from accent level
      var accent = state.accents[state.currentBeat];
      var type = accent === 2 ? 'accent' : accent === 1 ? 'normal' : 'muted';
      createClick(nextNoteTime, type);

      // Visual highlight synced to audio
      var delay = Math.max(0, (nextNoteTime - audioCtx.currentTime) * 1000);
      var beat = state.currentBeat;
      setTimeout(function () { highlightBeat(beat); }, delay);
    } else {
      // Subdivision click
      createClick(nextNoteTime, 'sub');
    }

    // Advance sub-beat, then beat
    state.currentSub++;
    if (state.currentSub >= state.subdivision) {
      state.currentSub = 0;
      state.currentBeat = (state.currentBeat + 1) % state.tsNum;
    }

    // Time to next sub-note = beat duration / subdivision
    nextNoteTime += beatDuration() / state.subdivision;
  }

  /** Lookahead scheduler. */
  function scheduler() {
    while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
      scheduleNote();
    }
  }

  function startMetronome() {
    ensureAudio();
    state.isPlaying = true;
    state.currentBeat = 0;
    state.currentSub = 0;
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

  // ── Beat visualization ─────────────────────────

  /** Rebuild beat indicators and accents array. */
  function buildBeats() {
    beatsEl.innerHTML = '';
    beatEls = [];

    // Preserve existing accents where possible, default new beats to normal
    var newAccents = [];
    for (var i = 0; i < state.tsNum; i++) {
      if (i < state.accents.length) {
        newAccents.push(state.accents[i]);
      } else {
        newAccents.push(1);
      }
    }
    // First beat defaults to accented if it was before
    if (newAccents.length > 0 && state.accents.length > 0 && state.accents[0] === 2) {
      newAccents[0] = 2;
    }
    state.accents = newAccents;

    for (var j = 0; j < state.tsNum; j++) {
      var el = document.createElement('div');
      el.className = 'beat';
      applyAccentClass(el, state.accents[j]);
      el.dataset.index = j;
      el.addEventListener('click', onBeatClick);
      beatsEl.appendChild(el);
      beatEls.push(el);
    }
  }

  /** Apply the correct CSS class for an accent level. */
  function applyAccentClass(el, level) {
    el.classList.remove('accented', 'muted');
    if (level === 2) el.classList.add('accented');
    else if (level === 0) el.classList.add('muted');
  }

  /** Cycle accent on click: normal(1) → accented(2) → muted(0) → normal(1). */
  function onBeatClick(e) {
    var idx = parseInt(e.currentTarget.dataset.index, 10);
    var current = state.accents[idx];
    // Cycle: 1→2→0→1
    state.accents[idx] = current === 1 ? 2 : current === 2 ? 0 : 1;
    applyAccentClass(beatEls[idx], state.accents[idx]);
  }

  function highlightBeat(index) {
    for (var i = 0; i < beatEls.length; i++) {
      beatEls[i].classList.remove('active');
    }
    if (index < beatEls.length) {
      beatEls[index].classList.add('active');
    }
  }

  function clearBeatHighlights() {
    for (var i = 0; i < beatEls.length; i++) {
      beatEls[i].classList.remove('active');
    }
  }

  // ── Subdivision ────────────────────────────────

  function setSubdivision(val) {
    state.subdivision = val;
    subBtns.forEach(function (btn) {
      btn.classList.toggle('selected', parseInt(btn.dataset.sub, 10) === val);
    });
  }

  subBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setSubdivision(parseInt(btn.dataset.sub, 10));
    });
  });

  // ── Time signature ─────────────────────────────

  function setTimeSignature(num, den) {
    state.tsNum = num;
    state.tsDen = den;
    tsNumEl.textContent = num;
    tsDenEl.textContent = den;

    // Reset accents: first beat accented, rest normal
    state.accents = [];
    for (var i = 0; i < num; i++) {
      state.accents.push(i === 0 ? 2 : 1);
    }

    buildBeats();
    updatePresetHighlight();
    if (state.isPlaying) {
      stopMetronome();
      startMetronome();
    }
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

  function openPicker() { tsPicker.classList.remove('hidden'); }
  function closePicker() { tsPicker.classList.add('hidden'); }

  // ── BPM controls ───────────────────────────────

  function setBpm(val) {
    state.bpm = Math.max(30, Math.min(300, val));
    bpmValueEl.textContent = state.bpm;
    bpmSlider.value = state.bpm;
  }

  /** Long-press repeat for +/- buttons. */
  function setupRepeatButton(btnEl, delta) {
    var intervalId = null;
    var timeoutId = null;

    function stop() {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
      timeoutId = null;
      intervalId = null;
    }

    function start(e) {
      e.preventDefault();
      setBpm(state.bpm + delta);
      timeoutId = setTimeout(function () {
        intervalId = setInterval(function () {
          setBpm(state.bpm + delta);
        }, 80);
      }, 400);
    }

    btnEl.addEventListener('pointerdown', start);
    btnEl.addEventListener('pointerup', stop);
    btnEl.addEventListener('pointerleave', stop);
    btnEl.addEventListener('pointercancel', stop);
  }

  // ── Tap tempo ──────────────────────────────────
  var tapTimes = [];
  var TAP_TIMEOUT = 2000;
  var TAP_HISTORY = 6;

  function handleTap() {
    ensureAudio();
    var now = performance.now();

    if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > TAP_TIMEOUT) {
      tapTimes = [];
    }

    tapTimes.push(now);

    if (tapTimes.length < 2) return;

    if (tapTimes.length > TAP_HISTORY + 1) {
      tapTimes = tapTimes.slice(-(TAP_HISTORY + 1));
    }

    var sum = 0;
    for (var i = 1; i < tapTimes.length; i++) {
      sum += tapTimes[i] - tapTimes[i - 1];
    }
    var avgMs = sum / (tapTimes.length - 1);
    setBpm(Math.round(60000 / avgMs));
  }

  // ── Event binding ──────────────────────────────

  playBtn.addEventListener('click', togglePlay);
  tapBtn.addEventListener('click', handleTap);
  bpmSlider.addEventListener('input', function () {
    setBpm(parseInt(this.value, 10));
  });

  setupRepeatButton(document.getElementById('bpm-down'), -1);
  setupRepeatButton(document.getElementById('bpm-up'), 1);

  document.getElementById('time-sig-btn').addEventListener('click', openPicker);
  document.getElementById('ts-close').addEventListener('click', closePicker);

  tsPicker.addEventListener('click', function (e) {
    if (e.target === tsPicker) closePicker();
  });

  document.getElementById('ts-custom-ok').addEventListener('click', function () {
    var num = parseInt(document.getElementById('ts-custom-num').value, 10);
    var den = parseInt(document.getElementById('ts-custom-den').value, 10);
    if (num >= 1 && num <= 32) {
      setTimeSignature(num, den);
      closePicker();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      togglePlay();
    }
  });

  // ── Init ───────────────────────────────────────
  buildPresets();
  buildBeats();
})();
