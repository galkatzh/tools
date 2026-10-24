/*
 * Can two phones talk near the top of human hearing, from a web page?
 *
 * The sender plays a repeating round of short tones from 15 to 21 kHz. The listener measures each
 * tone's SNR: how far its peak stands above the noise right around it. SNR is relative, so the
 * mic's automatic gain doesn't skew it, and it is roughly what a decoder would have to work with.
 * The waterfall spans 0 Hz to Nyquist, so a mic path that quietly low-passes (a voice-processing
 * mode, a resampler) shows up as a dark stretch on the right.
 */

const TONES = Array.from({ length: 13 }, (_, i) => 15000 + 500 * i) // Hz
const REFERENCE = 3000 // Hz; an audible tone first, to tell "too far" apart from "ultrasound is lost"
const TONE = 0.35 // s each tone sounds
const GAP = 0.1 // s of silence after each tone
const RAMP = 0.03 // s of raised-cosine fade at each end; a hard start or stop clicks audibly
const ROUND = 1000 * (TONES.length + 1) * (TONE + GAP) // ms, a whole round with the reference
const FFT = 8192 // the listener's FFT size: ~6 Hz bins and ~170 ms windows at 48 kHz
const SEARCH = 25 // Hz either side of a tone where its peak may land (clocks differ, hands move)
const NOISE = [60, 250] // Hz from a tone: the band whose median level is its noise floor
const CLEAR = 25, FAINT = 15 // dB of SNR; noise alone peaks at 9 to 12 dB over a round
const DB = [-125, -45] // dBFS spanned by the waterfall's colours
const SMEAR = 120 // Hz a peak spreads either side in the waterfall; a tone is only ~3 bins of 4096
const FADE = Float32Array.from({ length: 32 }, (_, i) => Math.sin(Math.PI / 2 * i / 31) ** 2)
const PALETTE = Array.from({ length: 256 }, (_, i) => // black → red → yellow → white
  [3 * i, 3 * i - 255, 3 * i - 510, 255].map(v => Math.min(255, Math.max(0, v))))

// Nothing that escapes a try/catch goes unreported
addEventListener('error', e => {
  console.error('uncaught error', e.error ?? e.message)
  toast(`Error: ${e.error?.message ?? e.message}`)
})
addEventListener('unhandledrejection', e => {
  console.error('unhandled rejection', e.reason)
  toast(`Error: ${e.reason?.message ?? e.reason}`)
})

const $ = s => document.querySelector(s)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

let ctx, lock
let sending = false, master, ticker
let plan = [] // tones scheduled and not yet over: { f, t, end } in AudioContext time
let listening = false, stream, source, analyser, spectrum, raf
let report = [] // lines describing the listener's setup, for "Copy results"
// tone → [its best SNR in the current ROUND-long window, in the one before]. Showing the larger
// covers at least the last whole round, however the rounds and windows line up.
const held = new Map()
let windowAt = 0 // when the current window began
const best = new Map() // tone → its best SNR since listening started
const rows = new Map([REFERENCE, ...TONES].map(f => {
  const li = $('#tones').appendChild(document.createElement('li'))
  li.innerHTML = `<span>${f / 1000} kHz</span><meter max="40" low="${FAINT}" high="${CLEAR}" optimum="40"></meter><output></output>`
  return [f, li]
}))

$('#send').onclick = () => run(setSending, !sending, 'Sending')
$('#listen').onclick = () => run(setListening, !listening, 'Listening')
$('#processing').onchange = () => listening && run(setListening, true, 'Listening') // restarts it
$('#volume').oninput = e => master?.gain.setTargetAtTime(+e.target.value, ctx.currentTime, 0.02)
$('#copy').onclick = async () => {
  const tones = [...best].map(([f, snr]) => `${f / 1000} kHz: best ${Math.round(snr)} dB`)
  await navigator.clipboard.writeText([...report, ...tones].join('\n'))
  toast('Copied', 'var(--accent)')
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && stayAwake())

/** Runs a start or stop; a start that fails is reported and leaves that side stopped. */
async function run(set, on, what) {
  try {
    await set(on)
  } catch (err) {
    console.error(`${what} failed`, err)
    toast(`${what} failed: ${err.message}`)
    await set(false)
  }
}

/** Makes (on the first tap: browsers only start audio from a gesture) and resumes the AudioContext. */
async function audio() {
  ctx ??= new AudioContext()
  session()
  await ctx.resume()
}

/** Safari: play through the iOS mute switch, except that recording needs the play-and-record session. */
function session() {
  if (navigator.audioSession) navigator.audioSession.type = listening ? 'play-and-record' : 'playback'
}

/** Keeps the screen on while sending or listening, since a sleeping phone stops its audio. */
async function stayAwake() {
  const on = sending || listening
  if (on && (!lock || lock.released)) {
    lock = await navigator.wakeLock?.request('screen').catch(err => console.error('the screen may sleep', err))
  }
  if (!on && lock) {
    lock.release()
    lock = null
  }
}

/**
 * Schedules one round of tones into `out` from AudioContext time t0, and returns them as
 * { f, t, end }. Works on any BaseAudioContext, so a test can render a round offline.
 */
export function round(ctx, out, t0, reference) {
  return (reference ? [REFERENCE, ...TONES] : TONES).map((f, i) => {
    const t = t0 + i * (TONE + GAP)
    const env = new GainNode(ctx, { gain: 0 })
    env.gain.setValueCurveAtTime(FADE, t, RAMP)
    env.gain.setValueCurveAtTime(FADE.slice().reverse(), t + TONE - RAMP, RAMP)
    const osc = new OscillatorNode(ctx, { frequency: f })
    osc.connect(env).connect(out)
    osc.start(t)
    osc.stop(t + TONE)
    return { f, t, end: t + TONE }
  })
}

/** Starts or stops playing rounds of tones, back to back. */
async function setSending(on) {
  clearInterval(ticker)
  master?.disconnect() // tones already scheduled play on into nothing
  plan = []
  sending = on
  $('#send').setAttribute('aria-pressed', on)
  $('#now').textContent = ''
  stayAwake()
  if (!on) return
  await audio()
  master = new GainNode(ctx, { gain: +$('#volume').value })
  master.connect(ctx.destination)
  ticker = setInterval(() => {
    const now = ctx.currentTime
    const end = plan.at(-1)?.end ?? 0
    // Queue the next round well before this one ends, so a throttled timer can't leave a pause
    if (end - now < 1.5) plan.push(...round(ctx, master, Math.max(now + 0.05, end + GAP), $('#reference').checked))
    plan = plan.filter(p => p.end > now)
    const playing = plan.find(p => p.t <= now)
    if (playing) $('#now').textContent = `Now ${playing.f / 1000} kHz.`
  }, 100)
}

/** Starts (or restarts) or stops measuring the mic. Stopping leaves the last results on screen. */
async function setListening(on) {
  cancelAnimationFrame(raf)
  stream?.getTracks().forEach(t => t.stop())
  source?.disconnect()
  stream = source = null
  listening = on
  $('#listen').setAttribute('aria-pressed', on)
  stayAwake()
  if (!on) return session()
  if (!navigator.mediaDevices) throw new Error('the microphone needs this page served over HTTPS')
  await audio()
  const asked = $('#processing').checked
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: asked, noiseSuppression: asked, autoGainControl: asked },
  })
  source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream })
  analyser = new AnalyserNode(ctx, { fftSize: FFT, smoothingTimeConstant: 0.6 })
  source.connect(analyser)
  spectrum = new Float32Array(analyser.frequencyBinCount)
  for (const f of rows.keys()) held.set(f, [0, 0])
  windowAt = performance.now()
  best.clear()
  describe(stream.getAudioTracks()[0], asked)
  $('#results').hidden = false
  const c = $('#waterfall')
  c.width = c.clientWidth
  c.height = 60 * ROUND / 1000 // a row per frame: a whole round, at 60 frames a second
  drawAxis()
  raf = requestAnimationFrame(frame)
}

/** Lists what the browser actually gave the listener, which can differ from what was asked. */
function describe(track, asked) {
  const s = track.getSettings()
  const rows = [
    ['Asked for', `voice processing ${asked ? 'on' : 'off'}`],
    ['Audio rate', `${ctx.sampleRate} Hz, so up to ${ctx.sampleRate / 2000} kHz`],
    ['Mic rate', s.sampleRate ? `${s.sampleRate} Hz` : 'not reported'],
    ['Mic', track.label || 'unnamed'],
    ...['echoCancellation', 'noiseSuppression', 'autoGainControl'].map(k =>
      [k, !(k in s) ? 'not reported' : s[k] === asked ? `${s[k]}` : `${s[k]}, though asked for ${asked}`]),
  ]
  $('#settings').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd')
    dt.textContent = k
    dd.textContent = v
    dd.classList.toggle('warn', v.includes('though asked'))
    return [dt, dd]
  }))
  report = [navigator.userAgent, ...rows.map(r => r.join(': '))]
}

/** Labels the waterfall's frequency axis, which runs linearly from 0 Hz to Nyquist. */
function drawAxis() {
  const nyquist = ctx.sampleRate / 2
  const at = f => `${f / nyquist * 100}%`
  $('#axis').innerHTML = `<i style="left:${at(TONES[0])};width:${at(TONES.at(-1) - TONES[0])}"></i>` +
    Array.from({ length: Math.floor(nyquist / 2000) + 1 }, (_, i) => `<span style="left:${at(2000 * i)}">${2 * i}</span>`).join('')
}

/** Every animation frame: a waterfall row, and each tone's SNR. */
function frame() {
  raf = requestAnimationFrame(frame)
  analyser.getFloatFrequencyData(spectrum)
  drawRow()
  const now = performance.now()
  if (now - windowAt > ROUND) {
    windowAt = now
    for (const [f, [current]] of held) held.set(f, [0, current])
  }
  for (const [f, li] of rows) {
    const snr = measure(f)
    if (snr === null) {
      li.querySelector('output').textContent = 'past Nyquist'
      continue
    }
    const h = held.get(f)
    h[0] = Math.max(h[0], snr)
    best.set(f, Math.max(best.get(f) ?? 0, snr))
    const shown = Math.max(...h)
    li.querySelector('meter').value = shown
    li.querySelector('output').textContent =
      `${Math.round(shown)} dB, ${shown >= CLEAR ? 'clear' : shown >= FAINT ? 'faint' : 'not heard'}`
  }
}

/**
 * dB by which the loudest bin within SEARCH of f stands above the median of the bins NOISE away
 * from it; null when that neighbourhood is past Nyquist.
 */
function measure(f) {
  const hz = ctx.sampleRate / FFT
  const bins = (lo, hi) => [...spectrum.subarray(Math.round(lo / hz), Math.round(hi / hz) + 1)]
  if (Math.round((f + NOISE[1]) / hz) >= spectrum.length) return null
  const noise = [...bins(f - NOISE[1], f - NOISE[0]), ...bins(f + NOISE[0], f + NOISE[1])].sort((a, b) => a - b)
  // Digital silence reads -Infinity dB; flooring both keeps the difference a number
  return Math.max(0, Math.max(-200, ...bins(f - SEARCH, f + SEARCH)) - Math.max(-200, noise[noise.length >> 1]))
}

/** Scrolls the waterfall down a pixel and paints the newest spectrum along the top. */
function drawRow() {
  const c = $('#waterfall'), g = c.getContext('2d')
  g.drawImage(c, 0, 1)
  const row = g.createImageData(c.width, 1)
  const per = spectrum.length / c.width, smear = Math.round(SMEAR * FFT / ctx.sampleRate)
  for (let x = 0; x < c.width; x++) {
    const lo = Math.max(0, Math.floor(x * per) - smear)
    const hi = Math.min(spectrum.length, Math.floor((x + 1) * per) + smear)
    let db = -Infinity // the loudest bin under this column, or within SMEAR of it
    for (let i = lo; i < hi; i++) db = Math.max(db, spectrum[i])
    row.data.set(PALETTE[Math.round(255 * clamp((db - DB[0]) / (DB[1] - DB[0]), 0, 1))], 4 * x)
  }
  g.putImageData(row, 0, 0)
}

function toast(text, color = 'var(--danger)') {
  const el = $('#toasts').appendChild(document.createElement('div'))
  el.textContent = text
  el.style.borderColor = color
  setTimeout(() => el.remove(), 5000)
  while ($('#toasts').childElementCount > 3) $('#toasts').firstElementChild.remove()
}
