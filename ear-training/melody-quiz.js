// Melody transcription quiz: play a melody, identify notes via on-screen
// keyboard (absolute pitch) or scale-degree buttons (relative pitch).
// Exposes a global `MelodyQuiz` with init(rootEl, getSettings).
(function () {
  'use strict';

  var T = window.Theory;
  var A = window.EarAudio;
  var S = window.Stats;

  var state = null;

  /** Reset/build a fresh round based on current settings. */
  function newRound(settings) {
    if (settings.randomizePatch) A.randomizePatch();
    else if (!A.hasSynth()) A.applyPatch(A.defaultPatch());
    var tonic = T.randomTonic();
    var length = settings.melodyLength;
    var scale = settings.melodyScale; // 'major' | 'minor' | 'chromatic'
    var melody = T.generateMelody(tonic, scale, length, { maxJump: 7, spanOctaves: 1 });

    state = {
      tonic: tonic,
      scale: scale,
      melody: melody,
      // Quiz variant maps to which slots are user-answerable:
      // 'first' -> [0]; 'last' -> [length-1]; 'all' -> [0..length-1]
      variantSlots: variantSlots(settings.melodyVariant, length),
      activeSlotIdx: 0,
      answers: new Array(length).fill(null),
      done: false,
      cadenceOn: !!settings.cadenceOn,
      inputMode: settings.melodyInputMode || 'degrees' // 'degrees' | 'keyboard'
    };
  }

  function variantSlots(variant, length) {
    if (variant === 'first') return [0];
    if (variant === 'last') return [length - 1];
    return Array.from({ length: length }, function (_, i) { return i; });
  }

  /** Render the round into rootEl. */
  function render(rootEl) {
    rootEl.innerHTML = '';

    // Header strip
    var head = el('div', 'mq-head');
    head.appendChild(el('div', 'mq-key', 'Key: ' + T.midiToName(state.tonic) + ' ' + state.scale));
    var inputToggle = el('button', 'mq-input-toggle btn-ghost',
                         'Input: ' + (state.inputMode === 'keyboard' ? 'Keyboard' : 'Degrees'));
    inputToggle.addEventListener('click', function () {
      state.inputMode = state.inputMode === 'keyboard' ? 'degrees' : 'keyboard';
      render(rootEl);
    });
    head.appendChild(inputToggle);
    rootEl.appendChild(head);

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
          render(rootEl);
        }
      });
      slotsRow.appendChild(slot);
    });
    rootEl.appendChild(slotsRow);

    // Replay controls
    var ctrl = el('div', 'mq-ctrl');
    var replayBtn = el('button', 'btn', '▶ Replay melody');
    replayBtn.addEventListener('click', function () {
      if (state.cadenceOn) {
        A.playCadence(state.tonic, state.scale);
        setTimeout(function () { A.playMelody(state.melody); }, 2200);
      } else {
        A.playMelody(state.melody);
      }
    });
    var solutionBtn = el('button', 'btn-ghost', '💡 Solution');
    solutionBtn.title = 'Play the melody and highlight each note as it plays';
    solutionBtn.addEventListener('click', function () {
      if (state.cadenceOn) {
        A.playCadence(state.tonic, state.scale);
        setTimeout(function () { replayWithHighlight(rootEl); }, 2200);
      } else {
        replayWithHighlight(rootEl);
      }
    });
    var tonicBtn = el('button', 'btn-ghost', '🎵 Play tonic');
    tonicBtn.addEventListener('click', function () { A.playNote(state.tonic, 1.0); });
    ctrl.appendChild(replayBtn);
    ctrl.appendChild(solutionBtn);
    ctrl.appendChild(tonicBtn);
    rootEl.appendChild(ctrl);

    // Input area: keyboard or degree buttons. Remains visible after the
    // round is done so the user can use Solution to see highlights and
    // audition individual notes — followed by the Next button.
    var inputArea = el('div', 'mq-input');
    if (state.inputMode === 'keyboard') {
      inputArea.appendChild(renderKeyboard(rootEl));
    } else {
      inputArea.appendChild(renderDegreeButtons(rootEl));
    }
    if (state.done) {
      var nextBtn = el('button', 'btn btn-primary mq-next', 'Next round →');
      nextBtn.addEventListener('click', function () { startRound(rootEl); });
      inputArea.appendChild(nextBtn);
    }
    rootEl.appendChild(inputArea);
  }

  function formatNoteForVariant(midi) {
    // Show degree label + note name for clarity in reveal.
    var semis = midi - state.tonic;
    var deg = T.degreeLabel(semis);
    return deg + '\n' + T.midiToName(midi);
  }

  /** Render the on-screen piano keyboard centered around the tonic. */
  function renderKeyboard(rootEl) {
    // Build a 2-octave keyboard centered on the tonic.
    var startMidi = state.tonic - 12;
    var endMidi = state.tonic + 12;
    var kb = el('div', 'mq-keyboard');

    var whiteKeys = [];
    for (var m = startMidi; m <= endMidi; m++) {
      var pc = T.midiToPc(m);
      var isBlack = [1, 3, 6, 8, 10].indexOf(pc) >= 0;
      if (!isBlack) {
        whiteKeys.push(m);
      }
    }

    // White keys
    var whiteRow = el('div', 'mq-white-row');
    whiteKeys.forEach(function (m) {
      var k = el('button', 'mq-key-white');
      k.dataset.midi = String(m);
      if (m === state.tonic) k.classList.add('mq-key-tonic');
      k.textContent = T.pcName(T.midiToPc(m));
      k.addEventListener('click', function () { onKeyPick(rootEl, m); });
      whiteRow.appendChild(k);
    });
    kb.appendChild(whiteRow);

    // Black keys overlay (positioned with flexbox approx).
    // Compute black key offsets relative to white keys.
    var blackRow = el('div', 'mq-black-row');
    whiteKeys.forEach(function (wm, idx) {
      // Black key sits to the right of white key wm if pc+1 is black.
      var nextWhite = whiteKeys[idx + 1];
      var blackMidi = wm + 1;
      var hasBlack = nextWhite != null && nextWhite > blackMidi
        && [1, 3, 6, 8, 10].indexOf(T.midiToPc(blackMidi)) >= 0;
      var spacer = el('div', 'mq-black-spacer');
      if (hasBlack) {
        var bk = el('button', 'mq-key-black');
        bk.dataset.midi = String(blackMidi);
        if (blackMidi === state.tonic) bk.classList.add('mq-key-tonic');
        bk.textContent = T.pcName(T.midiToPc(blackMidi));
        bk.addEventListener('click', function () { onKeyPick(rootEl, blackMidi); });
        spacer.appendChild(bk);
      }
      blackRow.appendChild(spacer);
    });
    kb.appendChild(blackRow);

    return kb;
  }

  function renderDegreeButtons(rootEl) {
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
        b.addEventListener('click', function () { onDegreePick(rootEl, semis); });
      }(s));
      row.appendChild(b);
    }
    return row;
  }

  function onKeyPick(rootEl, midi) {
    A.playNote(midi, 0.6);
    if (state.done) return;
    var slotIdx = state.variantSlots[state.activeSlotIdx];
    var target = state.melody[slotIdx];
    var correct = midi === target;
    state.answers[slotIdx] = {
      correct: correct,
      userMidi: midi,
      userLabel: T.midiToName(midi)
    };
    advance(rootEl, correct);
  }

  function onDegreePick(rootEl, semitones) {
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
    advance(rootEl, correct);
  }

  function advance(rootEl, correct) {
    var done = false;
    if (state.activeSlotIdx + 1 < state.variantSlots.length) {
      state.activeSlotIdx++;
    } else {
      done = true;
      state.done = true;
    }
    render(rootEl);

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
  function replayWithHighlight(rootEl) {
    A.playMelody(state.melody, undefined, undefined, undefined, function (midi) {
      highlightNote(rootEl, midi);
    });
  }

  /**
   * Add a transient highlight class to the matching keyboard key (in keyboard
   * mode) or degree button (in degree mode). Class auto-removes so successive
   * notes don't pile up.
   */
  function highlightNote(rootEl, midi) {
    var HOLD_MS = 350;
    if (state.inputMode === 'keyboard') {
      var btn = rootEl.querySelector('button[data-midi="' + midi + '"]');
      if (btn) {
        btn.classList.add('mq-key-playing');
        setTimeout(function () { btn.classList.remove('mq-key-playing'); }, HOLD_MS);
      }
    } else {
      var semis = ((midi - state.tonic) % 12 + 12) % 12;
      var degBtn = rootEl.querySelector('.mq-degree-btn[data-semis="' + semis + '"]');
      if (degBtn) {
        degBtn.classList.add('mq-degree-playing');
        setTimeout(function () { degBtn.classList.remove('mq-degree-playing'); }, HOLD_MS);
      }
    }
  }

  /** Public: kick off a fresh round and play it. */
  function startRound(rootEl) {
    var settings = window.App.getSettings();
    newRound(settings);
    render(rootEl);
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
    rootEl.innerHTML = '';
    var welcome = el('div', 'mq-welcome');
    welcome.appendChild(el('h2', '', 'Melody Transcription'));
    welcome.appendChild(el('p', 'muted',
      'Tap Start. Listen to the melody, then identify the notes using either ' +
      'the on-screen keyboard or scale-degree buttons.'));
    var btn = el('button', 'btn btn-primary', '▶ Start round');
    btn.addEventListener('click', function () {
      A.ensureAudio();
      startRound(rootEl);
    });
    welcome.appendChild(btn);
    rootEl.appendChild(welcome);
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
