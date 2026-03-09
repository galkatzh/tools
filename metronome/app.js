(function () {
  'use strict';

  // ── State ──────────────────────────────────────
  var state = {
    bpm: 120,
    tsNum: 4,
    tsDen: 4,
    isPlaying: false,
    currentBeat: 0
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

  // ── Audio engine ───────────────────────────────
  var audioCtx = null;
  var SCHEDULE_AHEAD = 0.1;  // seconds lookahead
  var TIMER_INTERVAL = 25;   // ms between scheduler ticks
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

  /** Schedule a short oscillator click at the given AudioContext time. */
  function createClick(time, isDownbeat) {
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.frequency.value = isDownbeat ? 1000 : 800;
    gain.gain.setValueAtTime(isDownbeat ? 1.0 : 0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);

    osc.start(time);
    osc.stop(time + 0.03);
  }

  /** Beat duration in seconds, based on denominator and BPM. */
  function beatDuration() {
    // BPM always refers to quarter-note tempo
    switch (state.tsDen) {
      case 2:  return 120.0 / state.bpm;
      case 8:  return 30.0 / state.bpm;
      case 16: return 15.0 / state.bpm;
      default: return 60.0 / state.bpm; // /4
    }
  }

  /** Schedule the next note and advance the beat counter. */
  function scheduleNote() {
    var isDownbeat = state.currentBeat === 0;
    createClick(nextNoteTime, isDownbeat);

    // Visual highlight synced roughly to audio time
    var delay = Math.max(0, (nextNoteTime - audioCtx.currentTime) * 1000);
    var beat = state.currentBeat;
    setTimeout(function () { highlightBeat(beat); }, delay);

    state.currentBeat = (state.currentBeat + 1) % state.tsNum;
    nextNoteTime += beatDuration();
  }

  /** Lookahead scheduler — called by setInterval, schedules ahead on AudioContext. */
  function scheduler() {
    while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
      scheduleNote();
    }
  }

  function startMetronome() {
    ensureAudio();
    state.isPlaying = true;
    state.currentBeat = 0;
    nextNoteTime = audioCtx.currentTime + 0.05;
    timerId = setInterval(scheduler, TIMER_INTERVAL);
    playBtn.textContent = '\u25A0'; // stop square
    playBtn.classList.add('playing');
  }

  function stopMetronome() {
    state.isPlaying = false;
    clearInterval(timerId);
    timerId = null;
    clearBeatHighlights();
    playBtn.textContent = '\u25B6'; // play triangle
    playBtn.classList.remove('playing');
  }

  function togglePlay() {
    if (state.isPlaying) stopMetronome();
    else startMetronome();
  }

  // ── Beat visualization ─────────────────────────

  /** Rebuild beat indicator circles from current time signature. */
  function buildBeats() {
    beatsEl.innerHTML = '';
    beatEls = [];
    for (var i = 0; i < state.tsNum; i++) {
      var el = document.createElement('div');
      el.className = 'beat' + (i === 0 ? ' downbeat' : '');
      beatsEl.appendChild(el);
      beatEls.push(el);
    }
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

  // ── Time signature ─────────────────────────────

  function setTimeSignature(num, den) {
    state.tsNum = num;
    state.tsDen = den;
    tsNumEl.textContent = num;
    tsDenEl.textContent = den;
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
      // After 400ms, start repeating at 80ms intervals
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

  // Close picker when clicking backdrop
  tsPicker.addEventListener('click', function (e) {
    if (e.target === tsPicker) closePicker();
  });

  // Custom time signature
  document.getElementById('ts-custom-ok').addEventListener('click', function () {
    var num = parseInt(document.getElementById('ts-custom-num').value, 10);
    var den = parseInt(document.getElementById('ts-custom-den').value, 10);
    if (num >= 1 && num <= 32) {
      setTimeSignature(num, den);
      closePicker();
    }
  });

  // Keyboard: spacebar toggles play
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
