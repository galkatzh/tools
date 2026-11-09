// Melody transcription quiz: play a melody, identify notes via on-screen
// keyboard (absolute pitch) or scale-degree buttons (relative pitch).
// Exposes a global `MelodyQuiz` with init(rootEl).
import { createKeyboard } from '../jam/keyboard.js';

(function () {
  'use strict';

  var T = window.Theory;
  var A = window.EarAudio;
  var S = window.Stats;

  var state = null;
  var root = null; // the view the quiz renders into: .mq-top (redrawn on each answer) over .mq-input
  var kb = null, kbEl = null; // Jam's keyboard and its element, made once (see keyboard())

  function settings() { return window.App.getSettings(); }
  function keyboardMode() { return settings().melodyInputMode === 'keyboard'; }

  /** Reset/build a fresh round based on current settings. */
  function newRound() {
    var s = settings();
    A.newPatch(s.randomizePatch);
    var tonic = T.randomTonic();
    var length = s.melodyLength;
    var scale = s.melodyScale; // 'major' | 'minor' | 'chromatic'
    var melody = T.generateMelody(tonic, scale, length, { maxJump: 7, spanOctaves: 1 });

    state = {
      tonic: tonic,
      scale: scale,
      melody: melody,
      // Quiz variant maps to which slots are user-answerable:
      // 'first' -> [0]; 'last' -> [length-1]; 'all' -> [0..length-1]
      variantSlots: variantSlots(s.melodyVariant, length),
      activeSlotIdx: 0,
      answers: new Array(length).fill(null),
      done: false,
      cadenceOn: !!s.cadenceOn
    };
  }

  function variantSlots(variant, length) {
    if (variant === 'first') return [0];
    if (variant === 'last') return [length - 1];
    return Array.from({ length: length }, function (_, i) { return i; });
  }

  /** Render the round: the quiz on top, the input below. */
  function render() {
    root.innerHTML = '';
    root.appendChild(el('div', 'mq-top'));
    root.appendChild(el('div', 'mq-input'));
    renderTop();
    renderInput();
  }

  /** Header, answer slots, playback controls and, once done, the Next button. */
  function renderTop() {
    var top = root.querySelector('.mq-top');
    top.innerHTML = '';

    // Header strip
    var head = el('div', 'mq-head');
    head.appendChild(el('div', 'mq-key', 'Key: ' + T.midiToName(state.tonic) + ' ' + state.scale));
    var inputToggle = el('button', 'mq-input-toggle btn-ghost',
                         'Input: ' + (keyboardMode() ? 'Keyboard' : 'Degrees'));
    inputToggle.addEventListener('click', function () {
      settings().melodyInputMode = keyboardMode() ? 'degrees' : 'keyboard';
      window.App.saveSettings();
      renderTop();
      renderInput();
    });
    head.appendChild(inputToggle);
    top.appendChild(head);

    // Slots row (one per melody note; shows user's answer or '?')
    var slotsRow = el('div', 'mq-slots');
    state.melody.forEach(function (m, i) {
      var slot = el('button', 'mq-slot');
      var isActive = !state.done && state.variantSlots.includes(i)
        && state.variantSlots[state.activeSlotIdx] === i;
      var isAsked = state.variantSlots.includes(i);
      var ans = state.answers[i];
      if (state.done) {
        // Reveal phase: show correct labels and mark right/wrong.
        slot.textContent = formatNoteForVariant(m);
        if (isAsked) {
          slot.classList.add(ans && ans.correct ? 'mq-slot-correct' : 'mq-slot-wrong');
          if (ans && !ans.correct) {
            var sub = el('div', 'mq-slot-sub', 'you: ' + ans.userLabel);
            slot.appendChild(sub);
          }
        }
      } else if (isAsked) {
        slot.textContent = ans ? ans.userLabel : (isActive ? '?' : '·');
        if (isActive) slot.classList.add('mq-slot-active');
        if (ans && ans.correct) slot.classList.add('mq-slot-correct');
        if (ans && !ans.correct) slot.classList.add('mq-slot-wrong');
      } else {
        slot.textContent = '·';
        slot.classList.add('mq-slot-skip');
      }
      slot.addEventListener('click', function () {
        if (state.done) return;
        var idx = state.variantSlots.indexOf(i);
        if (idx >= 0) {
          state.activeSlotIdx = idx;
          renderTop();
        }
      });
      slotsRow.appendChild(slot);
    });
    top.appendChild(slotsRow);

    // Replay controls
    var ctrl = el('div', 'mq-ctrl');
    var replayBtn = el('button', 'btn', '▶ Replay');
    replayBtn.addEventListener('click', function () { withCadence(function () { A.playMelody(state.melody); }); });
    var solutionBtn = el('button', 'btn-ghost', '💡 Solution');
    solutionBtn.title = 'Play the melody and highlight each note as it plays';
    solutionBtn.addEventListener('click', function () { withCadence(replayWithHighlight); });
    var tonicBtn = el('button', 'btn-ghost', '🎵 Tonic');
    tonicBtn.title = 'Play the tonic';
    tonicBtn.addEventListener('click', function () { A.playNote(state.tonic, 1.0); });
    ctrl.appendChild(replayBtn);
    ctrl.appendChild(solutionBtn);
    ctrl.appendChild(tonicBtn);
    top.appendChild(ctrl);

    // The input stays usable after the round, to audition notes and follow the Solution.
    if (state.done) {
      var nextBtn = el('button', 'btn btn-primary mq-next', 'Next round →');
      nextBtn.addEventListener('click', startRound);
      top.appendChild(nextBtn);
    }
  }

  /** Runs `play`, after the I-IV-V-I cadence when that is on. */
  function withCadence(play) {
    if (!state.cadenceOn) return play();
    A.playCadence(state.tonic, state.scale);
    setTimeout(play, 2200);
  }

  /** The keyboard (centred on the tonic) or the scale-degree buttons. */
  function renderInput() {
    var input = root.querySelector('.mq-input');
    if (kb) kb.releaseAll(); // the keys may be leaving the page with a finger on them
    input.innerHTML = '';
    input.classList.toggle('mq-input-keys', keyboardMode());
    if (!keyboardMode()) {
      input.appendChild(renderDegreeButtons());
      return;
    }
    input.appendChild(keyboard());
    var old = kbEl.querySelector('.key.tonic');
    if (old) old.classList.remove('tonic');
    kbEl.querySelector('.key[data-note="' + state.tonic + '"]').classList.add('tonic');
    kb.show(state.tonic);
  }

  function formatNoteForVariant(midi) {
    // Show degree label + note name for clarity in reveal.
    var semis = midi - state.tonic;
    var deg = T.degreeLabel(semis);
    return deg + '\n' + T.midiToName(midi);
  }

  /**
   * Jam's piano: multi-touch, the computer keys and a navigator strip to scroll and resize the
   * keys. Made the first time it shows and kept for good, as its window listeners last as long
   * as the page; it answers only while on the page. A finger keeps its first key, as sliding
   * onto others would answer several slots.
   */
  function keyboard() {
    if (kbEl) return kbEl;
    kbEl = el('div', 'mq-keyboard');
    kbEl.innerHTML =
      '<div class="kb-bar">' +
        '<button class="kb-shift" data-d="-1" aria-label="Octave down">−</button>' +
        '<span class="kb-octave" title="Octave the computer keys play"></span>' +
        '<button class="kb-shift" data-d="1" aria-label="Octave up">+</button>' +
        '<div class="kb-nav" role="img"></div>' +
      '</div>' +
      '<div class="kb-keys"></div>' +
      '<p class="kb-hint">Play with A–\' and W–P · Z/X: octave −/+ · Drag the strip to scroll, its edges to resize</p>';
    kb = createKeyboard({
      keys: kbEl.querySelector('.kb-keys'),
      octave: kbEl.querySelector('.kb-octave'),
      nav: kbEl.querySelector('.kb-nav'),
      view: settings().keyboardView,
      slide: false
    }, {
      onNoteOn: function (note, vel) { A.noteOn(note, vel); onKeyPick(note); },
      onNoteOff: A.noteOff,
      onPedal: function () {},
      onView: function (view) { settings().keyboardView = view; window.App.saveSettings(); }
    });
    kbEl.querySelectorAll('.kb-shift').forEach(function (b) {
      b.addEventListener('click', function () { kb.shift(+b.dataset.d); });
    });
    // Keys held as the page hides, or another tab replaces the keys, would never be let go.
    addEventListener('hashchange', kb.releaseAll);
    document.addEventListener('visibilitychange', function () { if (document.hidden) kb.releaseAll(); });
    return kbEl;
  }

  function renderDegreeButtons() {
    // For chromatic mode, show all 12; for diatonic scales show in-key plus
    // the chromatics dimmed (so you can still get it right if the melody
    // generator picks oddities — but our melody generator stays diatonic).
    var scale = T.SCALES[state.scale] || T.SCALES.major;
    var inKey = {};
    scale.forEach(function (s) { inKey[s] = true; });

    var row = el('div', 'mq-degrees');
    for (var s = 0; s < 12; s++) {
      var b = el('button', 'mq-degree-btn');
      b.textContent = T.DEGREE_LABELS[s];
      b.dataset.semis = String(s);
      if (!inKey[s]) b.classList.add('mq-degree-out');
      (function (semis) {
        b.addEventListener('click', function () { onDegreePick(semis); });
      }(s));
      row.appendChild(b);
    }
    return row;
  }

  /** A key went down (the keyboard plays it): answers the active slot. */
  function onKeyPick(midi) {
    if (state.done) return;
    var slotIdx = state.variantSlots[state.activeSlotIdx];
    var target = state.melody[slotIdx];
    var correct = midi === target;
    state.answers[slotIdx] = {
      correct: correct,
      userMidi: midi,
      userLabel: T.midiToName(midi)
    };
    advance(correct);
  }

  function onDegreePick(semitones) {
    // Audition the picked degree first so it works both during the round
    // and after it ends (when the user is exploring the solution).
    A.playNote(state.tonic + semitones, 0.5);
    if (state.done) return;
    var slotIdx = state.variantSlots[state.activeSlotIdx];
    var target = state.melody[slotIdx];
    var targetSemis = ((target - state.tonic) % 12 + 12) % 12;
    var correct = semitones === targetSemis;
    state.answers[slotIdx] = {
      correct: correct,
      userSemis: semitones,
      userLabel: T.DEGREE_LABELS[semitones]
    };
    advance(correct);
  }

  function advance(correct) {
    var done = false;
    if (state.activeSlotIdx + 1 < state.variantSlots.length) {
      state.activeSlotIdx++;
    } else {
      done = true;
      state.done = true;
    }
    renderTop();

    if (done) {
      // Compute overall correctness (all asked slots correct).
      var allCorrect = state.variantSlots.every(function (i) {
        return state.answers[i] && state.answers[i].correct;
      });
      S.recordAttempt({
        type: 'melody',
        subtype: state.scale + ':' + state.variantSlots.length,
        correct: allCorrect,
        details: {
          tonic: state.tonic,
          scale: state.scale,
          melody: state.melody,
          answers: state.answers
        }
      });
    }
  }

  /**
   * Play the melody and visually highlight each note on the active input UI
   * (keyboard or degree buttons) at its audio onset. Used by the Solution
   * button so the user can see exactly which note lands where.
   */
  function replayWithHighlight() {
    A.playMelody(state.melody, undefined, undefined, undefined, highlightNote);
  }

  /**
   * Transiently highlight the note's key (also on the strip, so keys scrolled out of
   * view show it) or its degree button, so successive notes don't pile up.
   */
  function highlightNote(midi) {
    var HOLD_MS = 350;
    if (keyboardMode()) {
      kb.mark(midi, 'solution', 'var(--accent)');
      setTimeout(function () { kb.mark(midi, 'solution', null); }, HOLD_MS);
    } else {
      var semis = ((midi - state.tonic) % 12 + 12) % 12;
      var degBtn = root.querySelector('.mq-degree-btn[data-semis="' + semis + '"]');
      if (degBtn) {
        degBtn.classList.add('mq-degree-playing');
        setTimeout(function () { degBtn.classList.remove('mq-degree-playing'); }, HOLD_MS);
      }
    }
  }

  /** Public: kick off a fresh round and play it. */
  function startRound() {
    newRound();
    render();
    // Slight delay so user is looking at the UI before audio fires.
    setTimeout(function () {
      if (state.cadenceOn) {
        A.playCadence(state.tonic, state.scale);
        setTimeout(function () { A.playMelody(state.melody); }, 2200);
      } else {
        // Play tonic as reference, then melody.
        A.playNote(state.tonic, 0.6);
        setTimeout(function () { A.playMelody(state.melody); }, 900);
      }
    }, 300);
  }

  /** Render entry-point: shows a "Start" button if no round is active. */
  function init(rootEl) {
    root = rootEl;
    root.innerHTML = '';
    var welcome = el('div', 'mq-welcome');
    welcome.appendChild(el('h2', '', 'Melody Transcription'));
    welcome.appendChild(el('p', 'muted',
      'Tap Start. Listen to the melody, then identify the notes using either ' +
      'the on-screen keyboard or scale-degree buttons.'));
    var btn = el('button', 'btn btn-primary', '▶ Start round');
    btn.addEventListener('click', function () {
      A.ensureAudio();
      startRound();
    });
    welcome.appendChild(btn);
    root.appendChild(welcome);
  }

  // tiny dom helper
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  window.MelodyQuiz = { init: init, startRound: startRound };
}());
