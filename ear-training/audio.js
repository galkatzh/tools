// Audio engine: Tone.js PolySynth with randomized patches per quiz round.
// Exposes a global `EarAudio` object (NOT `Audio` — that's the built-in
// HTMLAudioElement constructor and clobbering it breaks the platform).
// Tone.js is loaded from CDN in index.html.
(function () {
  'use strict';

  var ctx = null;
  var synth = null;
  var currentPatch = null;

  /** Initialize AudioContext + Tone, with iOS silent-mode unlock. Idempotent. */
  function ensureAudio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      // iOS: play even when device is on silent.
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      try {
        Tone.setContext(ctx);
      } catch (err) {
        console.error('Tone.setContext failed:', err);
      }
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(function (err) {
        console.error('AudioContext resume failed:', err);
      });
    }
    return ctx;
  }

  // Randomize timbre each round to keep ear training instrument-agnostic.
  // Picks oscillator type + envelope ADSR. Restricted to musically-pleasant ranges.
  var OSC_TYPES = ['sine', 'triangle', 'sawtooth', 'square',
                   'fmsine', 'fmtriangle', 'amsine', 'amtriangle', 'pulse'];

  function rand(min, max) { return min + Math.random() * (max - min); }

  function randomPatch() {
    return {
      oscillator: { type: OSC_TYPES[Math.floor(Math.random() * OSC_TYPES.length)] },
      envelope: {
        attack:  +rand(0.005, 0.05).toFixed(3),
        decay:   +rand(0.05, 0.3).toFixed(3),
        sustain: +rand(0.3, 0.7).toFixed(2),
        release: +rand(0.4, 1.2).toFixed(2)
      },
      // gentle amplitude so chord stacks don't clip the master.
      volume: -10
    };
  }

  /** Build (or rebuild) the PolySynth with the given patch. */
  function applyPatch(patch) {
    ensureAudio();
    if (synth) {
      try { synth.dispose(); } catch (err) { console.error('Synth dispose failed:', err); }
    }
    currentPatch = patch;
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: patch.oscillator,
      envelope: patch.envelope
    }).toDestination();
    synth.volume.value = patch.volume;
  }

  /** Pick + apply a fresh random patch. Returns the patch (for diagnostics). */
  function randomizePatch() {
    var p = randomPatch();
    applyPatch(p);
    return p;
  }

  /** Ensure a synth exists (lazy). */
  function getSynth() {
    if (!synth) randomizePatch();
    return synth;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** Play a single MIDI note. duration in seconds. */
  function playNote(midi, duration, when) {
    ensureAudio();
    var s = getSynth();
    var t = (when != null ? when : Tone.now());
    var dur = duration != null ? duration : 0.5;
    try {
      s.triggerAttackRelease(midiToFreq(midi), dur, t);
    } catch (err) {
      console.error('playNote failed:', err);
    }
  }

  /** Play a list of MIDI notes simultaneously (block chord). */
  function playChord(midis, duration, when) {
    ensureAudio();
    var s = getSynth();
    var t = (when != null ? when : Tone.now());
    var dur = duration != null ? duration : 1.6;
    try {
      s.triggerAttackRelease(midis.map(midiToFreq), dur, t);
    } catch (err) {
      console.error('playChord failed:', err);
    }
  }

  /** Play notes one at a time (arpeggio). spacing = seconds between onsets. */
  function playArpeggio(midis, spacing, noteDur, when) {
    ensureAudio();
    var s = getSynth();
    var t0 = (when != null ? when : Tone.now()) + 0.05;
    spacing = spacing != null ? spacing : 0.18;
    noteDur = noteDur != null ? noteDur : 0.4;
    midis.forEach(function (m, i) {
      try {
        s.triggerAttackRelease(midiToFreq(m), noteDur, t0 + i * spacing);
      } catch (err) {
        console.error('playArpeggio note failed:', err);
      }
    });
  }

  /** Play a melody (sequential notes). Returns total duration in seconds. */
  function playMelody(midis, noteDur, gap, when) {
    ensureAudio();
    var s = getSynth();
    noteDur = noteDur != null ? noteDur : 0.45;
    gap = gap != null ? gap : 0.05;
    var step = noteDur + gap;
    var t0 = (when != null ? when : Tone.now()) + 0.05;
    midis.forEach(function (m, i) {
      try {
        s.triggerAttackRelease(midiToFreq(m), noteDur, t0 + i * step);
      } catch (err) {
        console.error('playMelody note failed:', err);
      }
    });
    return midis.length * step;
  }

  /** Play a I-IV-V-I cadence in the given key (root midi). Block chords. */
  function playCadence(tonicMidi, scaleName) {
    ensureAudio();
    var s = getSynth();
    // Major cadence by default; for minor use natural-minor i-iv-V-i (raised V works).
    var minor = scaleName === 'minor';
    var I  = minor ? [0, 3, 7]  : [0, 4, 7];
    var IV = minor ? [5, 8, 12] : [5, 9, 12];
    var V  = [7, 11, 14]; // major V in both modes for stronger pull
    var seq = [I, IV, V, I];
    var dur = 0.5;
    var t = Tone.now() + 0.05;
    seq.forEach(function (chord, i) {
      var midis = chord.map(function (iv) { return tonicMidi + iv; });
      try {
        s.triggerAttackRelease(midis.map(midiToFreq), dur, t + i * (dur + 0.05));
      } catch (err) {
        console.error('playCadence chord failed:', err);
      }
    });
    return seq.length * (dur + 0.05);
  }

  function getCurrentPatch() { return currentPatch; }

  window.EarAudio = {
    ensureAudio: ensureAudio,
    randomizePatch: randomizePatch,
    applyPatch: applyPatch,
    getCurrentPatch: getCurrentPatch,
    playNote: playNote,
    playChord: playChord,
    playArpeggio: playArpeggio,
    playMelody: playMelody,
    playCadence: playCadence
  };
}());
