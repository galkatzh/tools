// Audio engine: Jam's synth (../jam/synth.js) on one AudioContext, with a new timbre each round.
// Exposes a global `EarAudio` object (NOT `Audio` — that's the built-in HTMLAudioElement
// constructor and clobbering it breaks the platform).
import { Synth, PRESETS } from '../jam/synth.js';

let ctx = null;
let synth = null;

/**
 * Creates the AudioContext on first use, which must be a tap: browsers keep a context made
 * without one silent. Later calls resume it if the browser suspended it. Returns the context.
 */
function ensureAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    // iOS: play even when the device is on silent.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    // Chords stack voices: a compressor keeps them from clipping, as in Jam.
    const bus = new GainNode(ctx, { gain: 0.8 });
    bus.connect(new DynamicsCompressorNode(ctx, { threshold: -12, ratio: 12, attack: 0.003, release: 0.25 }))
      .connect(ctx.destination);
    synth = new Synth(ctx, bus, defaultPatch());
    // iOS suspends audio on interruptions until the next gesture, and only counts a touch's end.
    for (const type of ['pointerdown', 'pointerup', 'keydown']) addEventListener(type, ensureAudio, true);
  }
  if (ctx.state !== 'running') {
    ctx.resume().catch(err => console.error('AudioContext resume failed:', err));
  }
  return ctx;
}

/** A clean, neutral timbre for when random patches are off: a plain triangle wave. */
function defaultPatch() {
  return {
    osc1Wave: 'triangle', osc1Level: 1, osc2Level: 0, cutoff: 18000, filterEnv: 0,
    ampD: 0.15, ampS: 0.55, ampR: 0.7, reverb: 0.1, volume: 1 // as loud as the presets
  };
}

// Jam's presets that speak at once (a slow attack would smear quick melody notes), so ear
// training stays instrument-agnostic.
const VOICES = Object.values(PRESETS).filter(p => (p.ampA ?? 0) < 0.1 && (p.op1A ?? 0) < 0.1);

/** Sets the timbre for a round: a random preset, or the neutral default. */
function newPatch(random) {
  ensureAudio();
  const patch = random ? VOICES[Math.floor(Math.random() * VOICES.length)] : defaultPatch();
  // No echoes, which would sound like extra notes, and no glide, which would bend them.
  synth.setPatch({ ...patch, delayMix: 0, glide: 0 });
}

/** AudioContext time a little ahead, so the notes scheduled together start together. */
const now = () => ensureAudio().currentTime + 0.05;

/** Play MIDI notes together (one note, or a block chord) for `duration` seconds. */
function playChord(midis, duration = 1.6, when = now()) {
  for (const m of midis) {
    synth.noteOn(m, 0.8, when);
    synth.noteOff(m, when + duration);
  }
}

const playNote = (midi, duration = 0.5, when = now()) => playChord([midi], duration, when);

/** Play notes one at a time (arpeggio). spacing = seconds between onsets. */
function playArpeggio(midis, spacing = 0.18, noteDur = 0.4, when = now()) {
  midis.forEach((m, i) => playNote(m, noteDur, when + i * spacing));
}

/**
 * Play a melody (sequential notes). Returns total duration in seconds.
 * `onNote(midi, index, durationSec)` is invoked at each note's onset.
 */
function playMelody(midis, noteDur = 0.45, gap = 0.05, when = now(), onNote) {
  const step = noteDur + gap;
  midis.forEach((m, i) => {
    const onset = when + i * step;
    playNote(m, noteDur, onset);
    // The visual callback runs on a timer aligned with the audio onset; its drift is fine for a highlight.
    if (onNote) setTimeout(() => onNote(m, i, noteDur), Math.max(0, (onset - ctx.currentTime) * 1000));
  });
  return midis.length * step;
}

/** Play a I-IV-V-I cadence in the given key (root midi). Block chords. */
function playCadence(tonicMidi, scaleName) {
  // Natural-minor i-iv-V-i for minor; a major V in both modes for a stronger pull.
  const minor = scaleName === 'minor';
  const seq = [minor ? [0, 3, 7] : [0, 4, 7], minor ? [5, 8, 12] : [5, 9, 12], [7, 11, 14], minor ? [0, 3, 7] : [0, 4, 7]];
  const dur = 0.5, t = now();
  seq.forEach((chord, i) => playChord(chord.map(iv => tonicMidi + iv), dur, t + i * (dur + 0.05)));
  return seq.length * (dur + 0.05);
}

window.EarAudio = {
  ensureAudio,
  newPatch,
  now,
  playNote,
  playChord,
  playArpeggio,
  playMelody,
  playCadence,
  /** Start / stop a held note (the on-screen keyboard). */
  noteOn: (midi, vel) => { ensureAudio(); synth.noteOn(midi, vel); },
  noteOff: midi => synth?.noteOff(midi)
};
