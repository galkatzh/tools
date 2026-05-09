// Chord-quality recognition quiz: play a chord, user picks its quality from
// a multiple-choice set drawn from the user's enabled chord types.
// Exposes a global `ChordQuiz` with init(rootEl).
(function () {
  'use strict';

  var T = window.Theory;
  var A = window.EarAudio;
  var S = window.Stats;

  var state = null;

  function newRound(settings) {
    if (settings.randomizePatch) A.randomizePatch();
    else if (!A.hasSynth()) A.applyPatch(A.defaultPatch());

    var enabled = settings.enabledChordTypes && settings.enabledChordTypes.length
      ? settings.enabledChordTypes.slice()
      : ['maj', 'min', '7', 'm7'];

    var correctType = T.pick(enabled);

    // Pick a root in a comfy mid range; cap top so extensions don't blow past MIDI 96.
    var rootMidi = T.randInt(48, 60);
    var midis = T.buildChord(rootMidi, correctType);

    // Build choices: correct + up to 3 distractors from enabled set, shuffled.
    var distractors = enabled.filter(function (id) { return id !== correctType; });
    distractors = T.shuffle(distractors).slice(0, Math.max(0, Math.min(3, enabled.length - 1)));
    var choices = T.shuffle([correctType].concat(distractors));

    state = {
      rootMidi: rootMidi,
      correctType: correctType,
      midis: midis,
      choices: choices,
      arpeggiate: !!settings.arpeggiateChords,
      revealed: false,
      pickedType: null
    };
  }

  function play() {
    if (state.arpeggiate) {
      A.playArpeggio(state.midis, 0.16, 0.4);
      // Then also strike the full chord at the end so the user hears the stack.
      var spacing = 0.16;
      var when = (window.Tone ? Tone.now() : 0) + state.midis.length * spacing + 0.4;
      A.playChord(state.midis, 1.4, when);
    } else {
      A.playChord(state.midis, 1.6);
    }
  }

  function render(rootEl) {
    rootEl.innerHTML = '';
    var head = el('div', 'cq-head');
    head.appendChild(el('div', 'cq-root', 'Root: ' + T.midiToName(state.rootMidi)));
    rootEl.appendChild(head);

    var ctrl = el('div', 'cq-ctrl');
    var replayBtn = el('button', 'btn', '▶ Replay chord');
    replayBtn.addEventListener('click', play);
    ctrl.appendChild(replayBtn);
    rootEl.appendChild(ctrl);

    var grid = el('div', 'cq-choices');
    state.choices.forEach(function (id) {
      var btn = el('button', 'cq-choice');
      var label = (T.CHORD_TYPES[id] && T.CHORD_TYPES[id].label) || id;
      btn.textContent = label;
      btn.dataset.type = id;
      if (state.revealed) {
        if (id === state.correctType) btn.classList.add('cq-correct');
        if (state.pickedType === id && id !== state.correctType) btn.classList.add('cq-wrong');
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function () { pick(rootEl, id); });
      }
      grid.appendChild(btn);
    });
    rootEl.appendChild(grid);

    if (state.revealed) {
      var nextBtn = el('button', 'btn btn-primary cq-next', 'Next chord →');
      nextBtn.addEventListener('click', function () { startRound(rootEl); });
      rootEl.appendChild(nextBtn);
    }
  }

  function pick(rootEl, id) {
    state.pickedType = id;
    state.revealed = true;
    var correct = id === state.correctType;
    render(rootEl);
    S.recordAttempt({
      type: 'chord',
      subtype: state.correctType,
      correct: correct,
      details: {
        rootMidi: state.rootMidi,
        chordMidis: state.midis,
        picked: id,
        choices: state.choices
      }
    });
  }

  function startRound(rootEl) {
    var settings = window.App.getSettings();
    newRound(settings);
    render(rootEl);
    setTimeout(play, 250);
  }

  function init(rootEl) {
    rootEl.innerHTML = '';
    var welcome = el('div', 'cq-welcome');
    welcome.appendChild(el('h2', '', 'Chord Quality'));
    welcome.appendChild(el('p', 'muted',
      'Listen to the chord and pick its quality. Configure which chord types ' +
      'appear in Settings.'));
    var btn = el('button', 'btn btn-primary', '▶ Start round');
    btn.addEventListener('click', function () {
      A.ensureAudio();
      startRound(rootEl);
    });
    welcome.appendChild(btn);
    rootEl.appendChild(welcome);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  window.ChordQuiz = { init: init, startRound: startRound };
}());
