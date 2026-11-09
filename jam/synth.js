/**
 * Polyphonic synthesizer on Web Audio with two engines: subtractive ("Analog") and 4-operator FM.
 *
 * The host (Synth) owns what both engines share: the patch and its sanitizing, voice allocation
 * and stealing, glide and vibrato, and the output chain:
 *
 *   voices ─► out ─► dc ─┬─────────────► dest
 *                        ├─► delay ⟲ ───► dest
 *                        └─► reverbMix ─► reverb (one per AudioContext, shared by every synth)
 *
 * An engine builds one voice's nodes (start), applies the parameters sounding notes follow
 * (tune), and releases them (release). Each voice keeps the engine it started with, so switching
 * engines never cuts off sounding notes. Methods take AudioContext times, so notes and parameter
 * changes can be scheduled ahead of time, which is how the other players' parts are replayed.
 */

const WAVES = ['sawtooth', 'square', 'triangle', 'sine']
const MAX_VOICES = 16
const MAX_TAILS = 8 // released voices left ringing; older ones are faded out quickly
const PEAK = 0.25 // amp level of a full-velocity subtractive voice, leaving headroom for chords
const FM_PEAK = 0.28 // the same for FM carriers, measured to match the analog presets' loudness
const MAX_INDEX = 8 // FM: phase deviation in radians of a modulator at full level and velocity

const pct = (group, label, def) => ({ group, label, min: 0, max: 1, def, unit: '%' })
const time = (group, label, def) => ({ group, label, min: 0.001, max: 8, log: true, def, unit: 's' })
/** Tags parameters with the engine they belong to; untagged ones are shared. */
const only = (engine, params) => Object.fromEntries(Object.entries(params).map(([k, p]) => [k, { ...p, engine }]))

/**
 * The eight TX81Z algorithms: which operator modulates which ([from, to]), and which ones are
 * heard (carriers). Modulation only flows to lower numbers, and op 4, on top, has feedback.
 */
export const ALGS = [
  { name: 'Stack', mods: [[4, 3], [3, 2], [2, 1]], out: [1] },
  { name: 'Branch', mods: [[3, 2], [4, 2], [2, 1]], out: [1] },
  { name: 'Fork', mods: [[3, 2], [2, 1], [4, 1]], out: [1] },
  { name: 'Twin', mods: [[4, 3], [3, 1], [2, 1]], out: [1] },
  { name: 'Pairs', mods: [[2, 1], [4, 3]], out: [1, 3] },
  { name: 'Fan', mods: [[4, 1], [4, 2], [4, 3]], out: [1, 2, 3] },
  { name: 'Pair + 2', mods: [[4, 3]], out: [1, 2, 3] },
  { name: 'Organ', mods: [], out: [1, 2, 3, 4] },
]

/** One FM operator's parameters, keyed op1Level, op1Ratio… */
const operator = (n, level, ratio) => {
  const g = `Op ${n}`
  return only('fm', {
    [`op${n}Level`]: pct(g, 'Level', level),
    [`op${n}Ratio`]: { group: g, label: 'Ratio', min: 0.5, max: 16, step: 0.5, def: ratio, unit: '×' },
    [`op${n}Detune`]: { group: g, label: 'Detune', min: -50, max: 50, step: 1, def: 0, unit: 'ct' },
    [`op${n}Vel`]: pct(g, 'Velocity', 0.5),
    [`op${n}A`]: time(g, 'Attack', 0.002),
    [`op${n}D`]: time(g, 'Decay', 1),
    [`op${n}S`]: pct(g, 'Sustain', 0.5),
    [`op${n}R`]: time(g, 'Release', 0.3),
  })
}

/** Every patch parameter. Drives the UI, the defaults, and sanitizing patches sent by peers. */
export const PARAMS = {
  engine: { label: 'Engine', options: ['sub', 'fm'], def: 'sub' },
  ...only('sub', {
    osc1Wave: { group: 'Osc 1', label: 'Wave', options: WAVES, def: 'sawtooth' },
    osc1Oct: { group: 'Osc 1', label: 'Octave', min: -2, max: 2, step: 1, def: 0 },
    osc1Level: pct('Osc 1', 'Level', 0.7),
    osc2Wave: { group: 'Osc 2', label: 'Wave', options: WAVES, def: 'square' },
    osc2Oct: { group: 'Osc 2', label: 'Octave', min: -2, max: 2, step: 1, def: 0 },
    osc2Semi: { group: 'Osc 2', label: 'Semi', min: -12, max: 12, step: 1, def: 0, unit: 'st' },
    osc2Fine: { group: 'Osc 2', label: 'Fine', min: -50, max: 50, step: 1, def: 7, unit: 'ct' },
    osc2Level: pct('Osc 2', 'Level', 0.4),
    noise: pct('Osc 2', 'Noise', 0),
    filterType: { group: 'Filter', label: 'Type', options: ['lowpass', 'highpass', 'bandpass'], def: 'lowpass' },
    cutoff: { group: 'Filter', label: 'Cutoff', min: 30, max: 18000, log: true, def: 1500, unit: 'Hz' },
    reso: { group: 'Filter', label: 'Resonance', min: 0.7, max: 25, def: 4 },
    filterEnv: { group: 'Filter', label: 'Env amount', min: -4, max: 4, def: 2, unit: 'oct' },
    keyTrack: pct('Filter', 'Key track', 0.5),
    filtA: time('Filter env', 'Attack', 0.005),
    filtD: time('Filter env', 'Decay', 0.4),
    filtS: pct('Filter env', 'Sustain', 0.3),
    filtR: time('Filter env', 'Release', 0.3),
    ampA: time('Amp env', 'Attack', 0.005),
    ampD: time('Amp env', 'Decay', 0.3),
    ampS: pct('Amp env', 'Sustain', 0.7),
    ampR: time('Amp env', 'Release', 0.25),
  }),
  ...only('fm', {
    fmAlg: { group: 'FM', label: 'Algorithm', min: 1, max: 8, step: 1, def: 1 },
    fmBright: { group: 'FM', label: 'Brightness', min: 0, max: 2, def: 1, unit: '%' },
    fmFeedback: { ...pct('FM', 'Feedback', 0), step: 0.05 }, // feedbackWave has 21 steps
    fmKeyScale: pct('FM', 'Key scaling', 0.3),
    fmRateScale: pct('FM', 'Rate scaling', 0.3),
  }),
  ...operator(1, 0.85, 1),
  ...operator(2, 0.5, 1),
  ...operator(3, 0.35, 2),
  ...operator(4, 0.25, 3),
  lfoWave: { group: 'LFO', label: 'Wave', options: WAVES, def: 'sine' },
  lfoRate: { group: 'LFO', label: 'Rate', min: 0.05, max: 20, log: true, def: 5, unit: 'Hz' },
  lfoPitch: { group: 'LFO', label: 'Vibrato', min: 0, max: 100, def: 0, unit: 'ct' },
  lfoFilter: { group: 'LFO', label: 'Wah', min: 0, max: 2400, def: 0, unit: 'ct', engine: 'sub' },
  glide: { group: 'Voice', label: 'Glide', min: 0, max: 1, def: 0, unit: 's' },
  volume: pct('Voice', 'Volume', 0.8),
  delayTime: { group: 'FX', label: 'Delay time', min: 0.02, max: 1.5, log: true, def: 0.375, unit: 's' },
  delayFb: { group: 'FX', label: 'Feedback', min: 0, max: 0.9, def: 0.35, unit: '%' },
  delayMix: pct('FX', 'Delay mix', 0),
  reverb: pct('FX', 'Reverb', 0.15),
}

/** An FM preset: per operator [ratio, detune, level, velocity, attack, decay, sustain, release]. */
const fmPreset = (head, ops, rest) => {
  const keys = ['Ratio', 'Detune', 'Level', 'Vel', 'A', 'D', 'S', 'R']
  const patch = { engine: 'fm', ...head, ...rest }
  ops.forEach((values, i) => values.forEach((x, j) => { patch[`op${i + 1}${keys[j]}`] = x }))
  return patch
}

/** Presets only list what differs from the defaults; FM ones spell out every operator. */
export const PRESETS = {
  Init: {},
  'Fat lead': {
    osc2Wave: 'sawtooth', osc2Fine: 9, osc2Level: 0.6, cutoff: 2200, reso: 6, filterEnv: 1.5,
    filtD: 0.35, filtS: 0.4, ampS: 0.85, ampR: 0.2, glide: 0.06, lfoPitch: 12, lfoRate: 5.5,
    delayMix: 0.2, reverb: 0.2,
  },
  'Soft pad': {
    osc2Wave: 'sawtooth', osc2Fine: 14, cutoff: 700, reso: 2, filterEnv: 1.2, filtA: 1.5, filtD: 2,
    filtS: 0.6, filtR: 2, ampA: 0.9, ampD: 1.5, ampS: 0.85, ampR: 2.2, lfoFilter: 250, lfoRate: 0.25,
    reverb: 0.55,
  },
  Pluck: {
    osc1Wave: 'square', osc2Wave: 'sawtooth', osc2Fine: 5, cutoff: 350, reso: 8, filterEnv: 3.5,
    filtA: 0.001, filtD: 0.22, filtS: 0, filtR: 0.2, ampA: 0.001, ampD: 0.6, ampS: 0, ampR: 0.35,
    delayTime: 0.28, delayMix: 0.3, reverb: 0.25,
  },
  'Sub bass': {
    osc2Oct: -1, osc2Fine: 0, osc2Level: 0.6, cutoff: 260, reso: 5, filterEnv: 1.8, filtA: 0.001,
    filtD: 0.25, filtS: 0.2, ampA: 0.003, ampS: 0.9, ampR: 0.08, keyTrack: 0.3, reverb: 0,
  },
  Brass: {
    osc2Wave: 'sawtooth', osc2Fine: 6, cutoff: 600, reso: 2, filterEnv: 2.2, filtA: 0.06,
    filtD: 0.5, filtS: 0.5, ampA: 0.03, ampD: 0.4, ampS: 0.8, ampR: 0.18, lfoPitch: 6, reverb: 0.25,
  },
  'Hollow keys': {
    osc1Wave: 'triangle', osc2Oct: 1, osc2Level: 0.25, cutoff: 1500, reso: 1, filterEnv: 1,
    filtA: 0.001, filtD: 0.8, filtS: 0.2, ampA: 0.002, ampD: 1.2, ampS: 0.3, ampR: 0.4, lfoPitch: 4,
    reverb: 0.3,
  },
  'Init FM': { engine: 'fm' },
  // Two detuned pairs: a 1:1 body whose index (bark) follows velocity, and a 14:1 tine "ding"
  'DX piano': fmPreset({ fmAlg: 5, fmKeyScale: 0.35, fmRateScale: 0.35 }, [
    [1, -3, 0.9, 0.45, 0.001, 2.6, 0, 0.45],
    [1, -3, 0.55, 0.85, 0.001, 1, 0.12, 0.45],
    [1, 3, 0.62, 0.45, 0.001, 1.6, 0, 0.45],
    [14, 3, 0.34, 0.9, 0.001, 0.35, 0, 0.3]], { reverb: 0.25 }),
  // 1:3.5 gives inharmonic partials 1, 2.5, 4.5, 6, 8; a 7-cent pair beats like a struck tube
  'Tubular bell': fmPreset({ fmAlg: 5, fmKeyScale: 0.2, fmRateScale: 0.3 }, [
    [1, 0, 0.9, 0.5, 0.001, 6, 0, 3],
    [3.5, 0, 0.55, 0.7, 0.001, 4, 0, 3],
    [1, 7, 0.6, 0.5, 0.001, 3, 0, 2.5],
    [7, 7, 0.38, 1, 0.001, 0.5, 0, 1]], { reverb: 0.45 }),
  // Fed-back op 4 on op 1 is a sawtooth whose index acts like a filter envelope; op 2 knocks
  'FM bass': fmPreset({ fmAlg: 3, fmFeedback: 0.9, fmKeyScale: 0.15, fmRateScale: 0.2 }, [
    [1, 0, 0.95, 0.3, 0.001, 1.5, 0.75, 0.1],
    [1, 0, 0.38, 0.8, 0.001, 0.08, 0, 0.05],
    [1, 0, 0, 0.5, 0.001, 1, 0.5, 0.1],
    [1, 0, 0.47, 0.6, 0.001, 0.35, 0.5, 0.12]], { volume: 0.55, reverb: 0.05 }),
  // DX7 BRASS 1 in four operators: one fed-back modulator, three detuned 1:1 players
  'Brass section': fmPreset({ fmAlg: 6, fmFeedback: 0.85, fmKeyScale: 0.3, fmRateScale: 0.2 }, [
    [1, 0, 0.85, 0.4, 0.05, 0.5, 0.85, 0.2],
    [1, 7, 0.7, 0.4, 0.06, 0.5, 0.85, 0.2],
    [1, -7, 0.7, 0.4, 0.07, 0.5, 0.85, 0.2],
    [1, 0, 0.55, 0.7, 0.09, 0.4, 0.75, 0.25]], { lfoPitch: 6, lfoRate: 5.5, reverb: 0.25 }),
  // Bar partials 1 and 4, each struck by a 50 ms modulator burst
  Marimba: fmPreset({ fmAlg: 5, fmKeyScale: 0.3, fmRateScale: 0.5 }, [
    [1, 0, 0.95, 0.4, 0.001, 1.1, 0, 0.5],
    [1, 0, 0.45, 0.8, 0.001, 0.06, 0, 0.05],
    [4, 0, 0.55, 0.6, 0.001, 0.35, 0, 0.3],
    [3.5, 0, 0.4, 0.8, 0.001, 0.05, 0, 0.05]], { reverb: 0.25 }),
  // Drawbars 8', 4', 16' and a decaying 2 2/3' "percussion"
  'Drawbar organ': fmPreset({ fmAlg: 8, fmKeyScale: 0, fmRateScale: 0.2 }, [
    [1, 0, 0.9, 0, 0.004, 0.1, 1, 0.06],
    [2, 0, 0.65, 0, 0.004, 0.1, 1, 0.06],
    [0.5, 0, 0.55, 0, 0.004, 0.1, 1, 0.06],
    [3, 0, 0.6, 0.3, 0.001, 0.35, 0, 0.06]], { volume: 0.65, lfoPitch: 7, lfoRate: 6.8, reverb: 0.2 }),
  'Glass pad': fmPreset({ fmAlg: 5, fmFeedback: 0.2, fmKeyScale: 0.4, fmRateScale: 0.2 }, [
    [1, -6, 0.8, 0.3, 1.2, 2, 0.8, 2.5],
    [3, -6, 0.32, 0.4, 1.8, 3, 0.6, 2.5],
    [2, 6, 0.55, 0.3, 0.8, 2.5, 0.7, 2.5],
    [7, 6, 0.22, 0.3, 2, 3, 0.5, 2]], { lfoPitch: 4, lfoRate: 0.35, delayTime: 0.5, delayFb: 0.45, delayMix: 0.25, reverb: 0.6 }),
  'Digital pluck': fmPreset({ fmAlg: 4, fmFeedback: 0.7, fmKeyScale: 0.3, fmRateScale: 0.3 }, [
    [1, 0, 0.9, 0.5, 0.001, 0.8, 0.45, 0.25],
    [2, 0, 0.45, 0.8, 0.001, 0.18, 0.2, 0.2],
    [1, 0, 0.4, 0.6, 0.001, 0.3, 0.35, 0.2],
    [1, 0, 0.3, 0.4, 0.001, 0.4, 0.5, 0.2]], { delayTime: 0.28, delayFb: 0.4, delayMix: 0.28, reverb: 0.2 }),
}

/** Human-readable value of a parameter, for the UI. */
export function fmt(key, v) {
  const { unit = '', options } = PARAMS[key]
  if (options) return v
  if (unit === '%') return `${Math.round(v * 100)}%`
  if (unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`
  if (unit === 'Hz' && v >= 1000) return `${(v / 1000).toFixed(1)} kHz`
  if (unit === '×') return `×${v}`
  const a = Math.abs(v)
  return `${v.toFixed(Number.isInteger(v) || a >= 10 ? 0 : a < 1 ? 2 : 1)} ${unit}`.trim()
}

const buffersCache = new WeakMap()

/** Per-context buffers, made once: looped white noise and a synthetic reverb impulse response. */
function buffers(ctx) {
  if (!buffersCache.has(ctx)) {
    const sr = ctx.sampleRate
    const noise = ctx.createBuffer(1, sr * 2, sr)
    const impulse = ctx.createBuffer(2, sr * 2.5, sr)
    for (const buf of [noise, impulse]) {
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c)
        const decay = buf === impulse ? 4 : 0
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** decay
      }
    }
    buffersCache.set(ctx, { noise, impulse, waves: new Map() }) // waves: feedbackWave's cache
  }
  return buffersCache.get(ctx)
}

/**
 * A reverb for synths to share: convolution is linear, so one reverb fed by every synth sounds
 * exactly like one per synth, at a fraction of the cost.
 */
export function createReverb(ctx, dest) {
  const reverb = new ConvolverNode(ctx, { buffer: buffers(ctx).impulse })
  reverb.connect(dest)
  return reverb
}

/**
 * Op 4's waveform: a sine fed back into its own phase like a DX operator, y = sin(φ + β·y).
 * With ψ = φ + β·y this is Kepler's equation, φ = ψ − β·sin ψ, so the sine series
 * b_n = (2/π)∫₀^π y·sin(nφ) dφ can be integrated over ψ without ever solving for y (β ≤ 1
 * keeps y single-valued; the midpoint rule is exact to rounding here). β = 0 is a plain sine.
 * peak = Σ n·|b_n| bounds |dy/dφ|, i.e. how much faster than a sine the wave can swing.
 */
function feedbackWave(ctx, beta) {
  beta = Math.round(beta * 20) / 20 // 21 steps, so the waves can be cached
  const { waves } = buffers(ctx)
  if (!waves.has(beta)) {
    const H = 32, N = 128
    const imag = new Float32Array(H + 1)
    let peak = 0
    for (let n = 1; n <= H; n++) {
      for (let k = 0.5; k < N; k++) {
        const psi = Math.PI * k / N
        imag[n] += Math.sin(psi) * Math.sin(n * (psi - beta * Math.sin(psi))) * (1 - beta * Math.cos(psi)) * 2 / N
      }
      peak += n * Math.abs(imag[n])
    }
    waves.set(beta, { wave: new PeriodicWave(ctx, { real: new Float32Array(H + 1), imag, disableNormalization: true }), peak })
  }
  return waves.get(beta)
}

// Envelopes are built only from setTargetAtTime curves. A release can then start at any moment,
// even one scheduled in the future, and continue smoothly from wherever the curve is, without
// cancelAndHoldAtTime (which Firefox lacks). Each stage gets ~95% of the way in its nominal time.
function attack(param, t, peak, a, d, s) {
  param.setValueAtTime(0, t)
  param.setTargetAtTime(peak, t, a / 3)
  param.setTargetAtTime(peak * s, t + a, d / 3)
}

function release(param, t, r) {
  param.cancelScheduledValues(t)
  param.setTargetAtTime(0, t, r / 3)
}

/**
 * Subtractive voice:
 *
 *   osc 1 ─┐
 *   osc 2 ─┼─► levels ─► filter ─► amp (= v.out)
 *   noise ─┘   (only when Noise is up as the note starts)
 *
 * The amp and the filter each have an ADSR envelope (the filter's moves its detune, i.e. it is
 * measured in octaves).
 */
const subtractive = {
  start(synth, v, t) {
    const { ctx, patch: p } = synth
    v.pitched = [new OscillatorNode(ctx, { frequency: v.freq }), new OscillatorNode(ctx, { frequency: v.freq })]
    v.sources = p.noise ? [...v.pitched, new AudioBufferSourceNode(ctx, { buffer: buffers(ctx).noise, loop: true })] : v.pitched
    v.levels = v.sources.map(() => new GainNode(ctx))
    v.filter = new BiquadFilterNode(ctx)
    v.out = new GainNode(ctx, { gain: 0 })
    v.sources.forEach((s, i) => s.connect(v.levels[i]).connect(v.filter))
    v.filter.connect(v.out)
    synth.link(v, synth.lfoFilter, v.filter.detune)
    attack(v.out.gain, t, v.vel * PEAK, p.ampA, p.ampD, p.ampS)
    attack(v.filter.detune, t, p.filterEnv * 1200, p.filtA, p.filtD, p.filtS)
  },

  tune(v, p, set) {
    v.pitched[0].type = p.osc1Wave
    v.pitched[1].type = p.osc2Wave
    set(v.pitched[0].detune, p.osc1Oct * 1200)
    set(v.pitched[1].detune, p.osc2Oct * 1200 + p.osc2Semi * 100 + p.osc2Fine)
    v.levels.forEach((level, i) => set(level.gain, [p.osc1Level, p.osc2Level, p.noise][i]))
    v.filter.type = p.filterType
    set(v.filter.frequency, Math.min(20000, p.cutoff * 2 ** ((v.note - 60) / 12 * p.keyTrack)))
    set(v.filter.Q, p.reso)
  },

  /** Returns the release time of what is heard. */
  release(v, p, t) {
    release(v.out.gain, t, p.ampR)
    release(v.filter.detune, t, p.filtR)
    return p.ampR
  },
}

/**
 * 4-operator FM voice. Each operator is a sine oscillator with its own ADSR envelope:
 *
 *   osc ─► env ─► lvl ─► d/dt ─► other operators' frequency     modulator
 *   osc ─► env ─► lvl ─► v.out                                   carrier
 *
 * Yamaha's "FM" is phase modulation: a modulator adds I·sin(Φ) to its carriers' phase, I being
 * the index (in radians). Web Audio can only modulate frequency, which a carrier integrates into
 * phase, so a modulator sends the derivative of what it should add: k·(x[n] − x[n−1]), with
 * k = I·sampleRate/2π, built as lvl (gain k) plus a copy of it delayed by one sample and
 * inverted. The carrier's running phase sum telescopes back to exactly I·x[n]: sample-exact PM.
 * Hence:
 * - the depth in Hz follows the modulator's actual frequency on every key, through glide and
 *   vibrato, and even when the modulator is itself modulated, with no per-note scaling,
 * - stacks stay in tune: a sine fed straight into frequency leaks a DC term that shifts the
 *   carrier's pitch as envelopes move.
 */
const fm = {
  start(synth, v, t) {
    const { ctx, patch: p } = synth
    const alg = ALGS[p.fmAlg - 1]
    v.carriers = alg.out.length
    v.rate = Math.min(4, 2 ** (-p.fmRateScale * (v.note - 60) / 12)) // envelopes run faster up the keyboard
    v.out = new GainNode(ctx)
    v.ops = [1, 2, 3, 4].map(n => {
      const op = { n, mod: !alg.out.includes(n), srcs: [], osc: new OscillatorNode(ctx), env: new GainNode(ctx, { gain: 0 }), lvl: new GainNode(ctx) }
      op.osc.connect(op.env).connect(op.lvl)
      if (!op.mod) op.lvl.connect(v.out)
      attack(op.env.gain, t, 1, p[`op${n}A`] * v.rate, p[`op${n}D`] * v.rate, p[`op${n}S`])
      return op
    })
    for (const [from, to] of alg.mods.map(m => m.map(n => v.ops[n - 1]))) {
      // Built from plain nodes: an IIRFilterNode would do d/dt in one, but takes milliseconds to create
      from.neg ??= from.lvl.connect(new DelayNode(ctx, { delayTime: 1 / ctx.sampleRate, maxDelayTime: 0.001 }))
        .connect(new GainNode(ctx, { gain: -1 }))
      from.lvl.connect(to.osc.frequency)
      from.neg.connect(to.osc.frequency)
      to.srcs.push(from)
    }
    v.sources = v.pitched = v.ops.map(op => op.osc)
  },

  /**
   * Chrome and Safari clamp an oscillator's frequency to ±Nyquist (a clamped carrier loses phase
   * and falls out of tune), and silence one set above it, while Firefox aliases. So operators
   * above 0.9 × Nyquist are muted, and from op 4 down (modulation only flows to lower numbers)
   * each operator's incoming depth is capped to keep its peak frequency below that. Every
   * browser then plays the same notes, which matters as peers render each other's synths.
   */
  tune(v, p, set, ctx, t) {
    const fb = feedbackWave(ctx, p.fmFeedback)
    if (v.wave !== fb.wave) v.ops[3].osc.setPeriodicWave(v.wave = fb.wave)
    const keyScale = Math.min(2, 2 ** (-p.fmKeyScale * (v.note - 60) / 12)) // modulators soften up the keyboard
    const limit = 0.45 * ctx.sampleRate * (t < v.settle ? v.freq / v.from : 1) // a glide from above starts higher
    for (const op of [...v.ops].reverse()) {
      const k = name => p[`op${op.n}${name}`]
      op.f = v.freq * k('Ratio') * 2 ** (k('Detune') / 1200)
      op.gain = op.f > limit ? 0 : k('Level') ** 2 * (1 + k('Vel') * (v.vel - 1)) // squared: an audio taper
        * (op.mod ? MAX_INDEX * keyScale * p.fmBright : FM_PEAK / Math.sqrt(v.carriers))
      // A modulator swings its target by up to index × its own peak frequency × its wave's steepness
      const dev = op.srcs.reduce((sum, src) => sum + src.gain * src.top * (src.n === 4 ? fb.peak : 1), 0)
      const room = op.gain ? Math.max(0, limit - op.f) : Infinity // what a silent operator receives is never heard
      if (dev > room) for (const src of op.srcs) src.gain *= room / dev
      op.top = op.f + Math.min(dev, room)
    }
    for (const op of v.ops) {
      // Re-set only on change: retuning a held note must not cut its glide short
      if (op.f !== op.setF) set(op.osc.frequency, op.setF = op.f)
      set(op.lvl.gain, op.mod ? op.gain * ctx.sampleRate / (2 * Math.PI) : op.gain)
    }
  },

  release(v, p, t) {
    let r = 0
    for (const op of v.ops) {
      release(op.env.gain, t, p[`op${op.n}R`] * v.rate)
      if (!op.mod) r = Math.max(r, p[`op${op.n}R`] * v.rate)
    }
    return r
  },
}

const ENGINES = { sub: subtractive, fm }

export class Synth {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} dest where the dry sound and the delay go
   * @param {object} [patch]
   * @param {AudioNode} [reverb] where the reverb send goes: a shared reverb, or a mixer gain in front of one
   */
  constructor(ctx, dest, patch, reverb = createReverb(ctx, dest)) {
    this.ctx = ctx
    this.voices = new Map() // held note → voice; insertion order doubles as age for voice stealing
    this.tails = new Set() // released voices still ringing, oldest first
    this.lastFreq = null // glide starts from the previously played note
    this.out = new GainNode(ctx)
    // Detuned FM pairs put a slow sideband near 0 Hz: keep it out of the effects and the compressor.
    // Low/high-pass Q is in dB in Web Audio; −3 dB is a Butterworth, flat above the cutoff.
    const dc = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 15, Q: -3 })
    this.delay = new DelayNode(ctx, { maxDelayTime: 2 })
    this.feedback = new GainNode(ctx)
    this.delayMix = new GainNode(ctx)
    this.reverbMix = new GainNode(ctx)
    this.out.connect(dc).connect(dest)
    dc.connect(this.delay).connect(this.feedback).connect(this.delay)
    this.delay.connect(this.delayMix).connect(dest)
    dc.connect(this.reverbMix).connect(reverb)
    this.lfo = new OscillatorNode(ctx)
    this.lfoPitch = new GainNode(ctx)
    this.lfoFilter = new GainNode(ctx)
    this.lfo.connect(this.lfoPitch)
    this.lfo.connect(this.lfoFilter)
    this.lfo.start()
    this.globals = { // synth-wide parameters, set straight on their node
      volume: this.out.gain, delayTime: this.delay.delayTime, delayFb: this.feedback.gain,
      delayMix: this.delayMix.gain, reverb: this.reverbMix.gain, lfoRate: this.lfo.frequency,
      lfoPitch: this.lfoPitch.gain, lfoFilter: this.lfoFilter.gain,
    }
    this.patch = {}
    this.setPatch(patch)
  }

  /** Replaces the whole patch at time t; missing or invalid keys fall back to their defaults. */
  setPatch(patch, t = this.ctx.currentTime) {
    for (const key in PARAMS) this.apply(key, patch?.[key], t)
    this.retune(t)
  }

  /** Sets one parameter at time t; sounding notes follow where that makes sense. */
  set(key, value, t = this.ctx.currentTime) {
    if (this.apply(key, value, t)) this.retune(t)
  }

  /**
   * Stores one parameter, clamped to its range and step (peers may send anything), and applies
   * it if it is synth-wide. Returns whether held notes need retuning.
   */
  apply(key, value, t) {
    if (!Object.hasOwn(PARAMS, key)) return false
    const p = PARAMS[key]
    if (p.options) value = p.options.includes(value) ? value : p.def
    else value = Number.isFinite(value) ? Math.min(p.max, Math.max(p.min, value)) : p.def
    if (p.step) value = Math.round(value / p.step) * p.step
    this.patch[key] = value
    if (key === 'lfoWave') this.lfo.type = value
    else if (this.globals[key]) this.globals[key].setTargetAtTime(value, t, 0.01)
    else return true
    return false
  }

  /** Applies the patch to every held note, through the note's own engine. */
  retune(t) {
    const set = (param, x) => param.setTargetAtTime(x, t, 0.01)
    for (const v of this.voices.values()) {
      v.engine.tune(v, this.patch, set, this.ctx, t)
      if (t < v.settle) this.lift(v) // replaces the lift scheduled with the old values
    }
  }

  /** Lifts a downward FM glide's Nyquist limit once the slide has (nearly) arrived. */
  lift(v) {
    v.engine.tune(v, this.patch, (param, x) => param.setTargetAtTime(x, v.settle, 0.01), this.ctx, v.settle)
  }

  /** Connects a long-lived node to a voice's param, to be undone when the voice ends. */
  link(v, from, to) {
    from.connect(to)
    v.links.push([from, to])
  }

  /** Starts a MIDI note at AudioContext time t; vel is 0..1. */
  noteOn(note, vel = 0.8, t = this.ctx.currentTime) {
    this.noteOff(note, t)
    if (this.voices.size >= MAX_VOICES) this.noteOff(this.voices.keys().next().value, t)
    if (this.tails.size >= MAX_TAILS) this.silence(this.tails.values().next().value, t)
    const p = this.patch
    const freq = 440 * 2 ** ((note - 69) / 12)
    const v = { note, vel, freq, from: (p.glide && this.lastFreq) || freq, engine: ENGINES[p.engine], links: [] }
    if (v.engine === fm && v.from > freq) v.settle = t + 2 * p.glide // until a glide from above has (nearly) arrived
    v.engine.start(this, v, t)
    v.engine.tune(v, p, (param, x) => { param.value = x }, this.ctx, t)
    v.out.connect(this.out)
    for (const o of v.pitched) {
      this.link(v, this.lfoPitch, o.detune)
      // Glide on frequency, not detune: detune would also scale an FM modulator's output, and so
      // the index. Every oscillator slides by the same ratio, from the value tune just set.
      if (v.from !== freq) {
        const f = o.frequency.value
        o.frequency.setValueAtTime(f * v.from / freq, t)
        o.frequency.setTargetAtTime(f, t, p.glide / 3)
      }
    }
    if (v.settle) this.lift(v)
    // Chromium and WebKit misread an oscillator's frequency input during the render quantum it
    // starts in, which would leave an FM carrier with a phase error for the whole note. Starting a
    // quantum early, while every envelope is still closed, makes that input silence.
    v.sources.forEach(s => s.start(Math.max(this.ctx.currentTime, t - 128 / this.ctx.sampleRate)))
    this.voices.set(note, v)
    this.lastFreq = freq
  }

  /** Releases a MIDI note at AudioContext time t; its nodes are freed once the release fades out. */
  noteOff(note, t = this.ctx.currentTime) {
    const v = this.voices.get(note)
    if (!v) return
    this.voices.delete(note)
    const r = v.engine.release(v, this.patch, t)
    v.sources.forEach(s => s.stop(t + r * 2 + 0.05)) // 6 time constants: −52 dB
    this.tails.add(v)
    v.sources[0].onended = () => {
      this.tails.delete(v)
      v.out.disconnect()
      for (const [from, to] of v.links) from.disconnect(to)
    }
  }

  /** Fades out a released voice within ~50 ms (a later stop() replaces the earlier one). */
  silence(v, t) {
    this.tails.delete(v)
    v.out.gain.cancelScheduledValues(t)
    v.out.gain.setTargetAtTime(0, t, 0.01)
    v.sources.forEach(s => s.stop(t + 0.05))
  }

  allOff(t) {
    for (const note of [...this.voices.keys()]) this.noteOff(note, t)
  }

  /** Silences and detaches the synth for good. */
  dispose() {
    this.allOff()
    this.lfo.stop()
    this.out.disconnect()
    this.reverbMix.disconnect()
  }
}
