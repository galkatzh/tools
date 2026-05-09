// Music theory helpers: notes, scales, chord types, name<->midi conversion.
// Exposed as a global `Theory` to avoid a build step.
(function () {
  'use strict';

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // Scales as semitone offsets from the tonic.
  var SCALES = {
    major:      [0, 2, 4, 5, 7, 9, 11],
    minor:      [0, 2, 3, 5, 7, 8, 10],   // natural minor
    chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  };

  // Chord intervals (root-relative semitones). Insertion order = display order.
  // Includes triads, 7ths, sus, and common extensions/alterations.
  var CHORD_TYPES = {
    'maj':    { intervals: [0, 4, 7],            label: 'Major' },
    'min':    { intervals: [0, 3, 7],            label: 'Minor' },
    'dim':    { intervals: [0, 3, 6],            label: 'Diminished' },
    'aug':    { intervals: [0, 4, 8],            label: 'Augmented' },
    'sus2':   { intervals: [0, 2, 7],            label: 'Sus2' },
    'sus4':   { intervals: [0, 5, 7],            label: 'Sus4' },
    '7':      { intervals: [0, 4, 7, 10],        label: 'Dominant 7' },
    'maj7':   { intervals: [0, 4, 7, 11],        label: 'Major 7' },
    'm7':     { intervals: [0, 3, 7, 10],        label: 'Minor 7' },
    'mMaj7':  { intervals: [0, 3, 7, 11],        label: 'Minor-Major 7' },
    'm7b5':   { intervals: [0, 3, 6, 10],        label: 'Half-dim (m7♭5)' },
    'dim7':   { intervals: [0, 3, 6, 9],         label: 'Diminished 7' },
    '7sus4':  { intervals: [0, 5, 7, 10],        label: '7sus4' },
    '9':      { intervals: [0, 4, 7, 10, 14],    label: 'Dominant 9' },
    'maj9':   { intervals: [0, 4, 7, 11, 14],    label: 'Major 9' },
    'm9':     { intervals: [0, 3, 7, 10, 14],    label: 'Minor 9' },
    '7b9':    { intervals: [0, 4, 7, 10, 13],    label: '7♭9' },
    '7#9':    { intervals: [0, 4, 7, 10, 15],    label: '7♯9' },
    '7#11':   { intervals: [0, 4, 7, 10, 18],    label: '7♯11' },
    '13':     { intervals: [0, 4, 7, 10, 14, 21], label: 'Dominant 13' },
    'maj13':  { intervals: [0, 4, 7, 11, 14, 21], label: 'Major 13' },
    'add9':   { intervals: [0, 4, 7, 14],        label: 'Add 9' },
    '6':      { intervals: [0, 4, 7, 9],         label: 'Major 6' },
    'm6':     { intervals: [0, 3, 7, 9],         label: 'Minor 6' }
  };

  /** MIDI -> "C#4" style name (sharps only). */
  function midiToName(midi) {
    var n = NOTE_NAMES[((midi % 12) + 12) % 12];
    var oct = Math.floor(midi / 12) - 1;
    return n + oct;
  }

  /** Pitch-class index (0-11) regardless of octave. */
  function midiToPc(midi) { return ((midi % 12) + 12) % 12; }

  /** Pitch class name (no octave). */
  function pcName(pc) { return NOTE_NAMES[((pc % 12) + 12) % 12]; }

  /** Random integer in [min, max] inclusive. */
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /** Pick random element. */
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /** Shuffle (Fisher-Yates), returns new array. */
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** Random tonic midi within [minMidi, maxMidi]. Default C3 (48) – C5 (72). */
  function randomTonic(minMidi, maxMidi) {
    if (minMidi == null) minMidi = 48;
    if (maxMidi == null) maxMidi = 72;
    return randInt(minMidi, maxMidi);
  }

  /**
   * Build a melody as an array of MIDI notes, sampling diatonic degrees from
   * `scaleName`. Adjacent jumps are constrained to <= maxJump semitones for
   * musicality (prevents random unsingable leaps).
   */
  function generateMelody(tonicMidi, scaleName, length, opts) {
    opts = opts || {};
    var maxJump = opts.maxJump != null ? opts.maxJump : 7;
    var spanOctaves = opts.spanOctaves != null ? opts.spanOctaves : 1; // up to ±1 octave around tonic
    var scale = SCALES[scaleName] || SCALES.major;

    // Build candidate pool: tonic + scale degrees across span
    var pool = [];
    for (var o = -spanOctaves; o <= spanOctaves; o++) {
      for (var i = 0; i < scale.length; i++) {
        pool.push(tonicMidi + scale[i] + 12 * o);
      }
    }

    var notes = [tonicMidi + scale[pick([0, 2, 4])]]; // start on a stable degree (1, 3, or 5)
    for (var k = 1; k < length; k++) {
      var prev = notes[k - 1];
      var candidates = pool.filter(function (m) {
        return Math.abs(m - prev) <= maxJump && m !== prev;
      });
      if (!candidates.length) candidates = pool;
      notes.push(pick(candidates));
    }
    return notes;
  }

  /** Get chord midis for root + chord type id. */
  function buildChord(rootMidi, chordTypeId) {
    var ct = CHORD_TYPES[chordTypeId];
    if (!ct) {
      console.error('Unknown chord type:', chordTypeId);
      return [rootMidi];
    }
    return ct.intervals.map(function (iv) { return rootMidi + iv; });
  }

  /**
   * Label a semitone offset relative to tonic as a scale degree
   * ("1", "b3", "#4", "7", etc.).
   */
  var DEGREE_LABELS = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];
  function degreeLabel(semitones) {
    return DEGREE_LABELS[((semitones % 12) + 12) % 12];
  }

  /** Diatonic degree labels for a scale. */
  function scaleDegreeLabels(scaleName) {
    var scale = SCALES[scaleName] || SCALES.major;
    return scale.map(function (s) { return DEGREE_LABELS[s]; });
  }

  window.Theory = {
    NOTE_NAMES: NOTE_NAMES,
    SCALES: SCALES,
    CHORD_TYPES: CHORD_TYPES,
    DEGREE_LABELS: DEGREE_LABELS,
    midiToName: midiToName,
    midiToPc: midiToPc,
    pcName: pcName,
    randInt: randInt,
    pick: pick,
    shuffle: shuffle,
    randomTonic: randomTonic,
    generateMelody: generateMelody,
    buildChord: buildChord,
    degreeLabel: degreeLabel,
    scaleDegreeLabels: scaleDegreeLabels
  };
}());
