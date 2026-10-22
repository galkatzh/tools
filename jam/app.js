import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm'
import { Synth, PARAMS, PRESETS, ALGS, fmt, createReverb } from './synth.js'
import { createKeyboard } from './keyboard.js'

/*
 * NINJAM-style jamming over WebRTC.
 *
 * Time is cut into intervals of `bpi` beats. What you play during your interval n is streamed
 * to the others as you play it, and they hear it during *their* interval n + 1, at the same
 * offset into the interval. So everyone plays along to everyone else's previous interval,
 * and any network delay shorter than an interval is inaudible.
 *
 * "Interval n" must mean roughly the same moment for everyone, so peers share a clock: the
 * longest-present player (the leader) is the reference, and the others estimate their offset
 * to it NTP-style. Clock error only decides which local interval a part lands in; the part
 * still lines up with the listener's own beat grid, so tens of ms of error are harmless.
 *
 * Only MIDI-like events travel: note on/off and synth parameter changes. Every client runs a
 * copy of every player's synth, with their patch, so each player's sound is rebuilt locally.
 * Signaling goes through public Nostr relays (Trystero); the jam itself is peer-to-peer.
 */

const APP_ID = 'galkatzh-tools-jam'
const PROTOCOL = 1 // bumped when peers on different versions would hear each other wrong
const TICK = 25 // ms between scheduler runs
const LOOKAHEAD = 120 // ms of upcoming clicks and remote events handed to Web Audio per run
const LATE = 250 // ms; a remote note-on later than this is dropped rather than played off-beat
const OPTION_LABELS = {
  sub: 'Analog', fm: 'FM',
  sawtooth: 'Saw', square: 'Square', triangle: 'Triangle', sine: 'Sine',
  lowpass: 'Low-pass', highpass: 'High-pass', bandpass: 'Band-pass',
}

// Nothing that escapes a try/catch goes unreported
addEventListener('error', e => {
  console.error('uncaught error', e.error ?? e.message)
  toast(`Error: ${e.error?.message ?? e.message}`, 'var(--danger)')
})
addEventListener('unhandledrejection', e => {
  console.error('unhandled rejection', e.reason)
  toast(`Error: ${e.reason?.message ?? e.reason}`, 'var(--danger)')
})

const $ = s => document.querySelector(s)
const $$ = s => document.querySelectorAll(s)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

let ctx, bus, hall, clickBus, net, kb, me, echo
let heard = false // whether another player has spoken to us yet
const players = new Map() // id → { id, name, since, hue, color, gain, wet, li, synth }; includes me
/**
 * Sessions { bpm, bpi, epoch, rev, since, solo } in the order they take effect: epoch is when a
 * session's interval 0 begins, since is when its maker joined, and solo marks one made before its
 * maker had met anyone. Holds the one in effect, possibly a tempo change waiting for its downbeat,
 * and the previous one, for parts still arriving on its grid.
 */
let timeline = []
const told = new Map() // peer id → how long we had been here when we greeted them
const unreachable = new Map() // peer id → timer forgetting it: found through signaling, but not connected
let clockOffset = 0 // ms to add to Date.now() to read the shared clock
let leaderId = selfId
let queue = [] // events waiting for their turn: { at: shared ms on session `from`'s grid, from, id, e }
let nextClick = null // shared time of the next metronome click to schedule
let lastClick = 0 // AudioContext time of the last click scheduled
let ctxBase = null // shared time (ms) at AudioContext time 0
const controls = {} // synth param → { input, value }: its control and where its value is shown
const groups = {} // synth panel fieldsets by group name
const dirty = new Set() // params changed since they were last sent

const now = () => Date.now() + clockOffset
const ms = s => s.bpi * 60000 / s.bpm // interval length
const latency = () => 1000 * (ctx.outputLatency || ctx.baseLatency || 0)
/** The session in effect at shared time T. */
const sessionAt = T => timeline.findLast(s => s.epoch <= T) ?? timeline[0]

/** Session s in effect at shared time T, and the index n of T's interval and offset o (ms) into it. */
function position(T) {
  const s = sessionAt(T)
  const n = Math.floor((T - s.epoch) / ms(s))
  return { s, n, o: T - s.epoch - n * ms(s) }
}

/**
 * Maps time `at` on session `from`'s grid onto the sessions after it. A tempo change starts on
 * a downbeat of the session it replaces, so a part carries on there beat for beat at the new
 * tempo. Notes that would spill past the first new interval (when Beats shrank) are dropped
 * (null); releases and sound changes (`keep`) still land, at the end of that interval.
 */
function retime(at, from, keep) {
  for (const s of timeline) {
    if (s.epoch <= from.epoch || s.epoch > at) continue
    at = s.epoch + (at - s.epoch) * from.bpm / s.bpm
    if (at >= s.epoch + ms(s)) {
      if (!keep) return null
      at = s.epoch + ms(s) - 1
    }
    from = s
  }
  return at
}

const save = (key, value) => {
  try { localStorage.setItem(`jam.${key}`, JSON.stringify(value)) } catch (err) { console.error(`could not save ${key}`, err) }
}
const load = key => {
  try { return JSON.parse(localStorage.getItem(`jam.${key}`)) } catch (err) { console.error(`could not load ${key}`, err) }
}

/** A display name from anyone: no control or bidi-override characters, at most 24 characters. */
const cleanName = name => [...(typeof name === 'string' ? name.slice(0, 100) : '')
  .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '').trim()].slice(0, 24).join('') || 'Player'

// ── Lobby ─────────────────────────────────────────────────────────────

const randomRoom = () => `jam-${Math.random().toString(36).slice(2, 7)}`
/** The room the link names; a malformed one is taken as written, so all who open it still meet. */
function hashRoom() {
  const raw = location.hash.slice(1)
  try { return decodeURIComponent(raw) } catch (err) {
    console.error(`malformed room in the link, taken as written: ${raw}`, err)
    return raw
  }
}

$('#name').value = load('name') ?? ''
$('#room').value = hashRoom() || randomRoom()
$('#lobby').onsubmit = e => {
  e.preventDefault()
  if (ctx) return // already joining
  save('name', $('#name').value.trim())
  join(cleanName($('#name').value), $('#room').value.trim() || randomRoom())
}

function join(name, roomId) {
  history.replaceState(null, '', `#${encodeURIComponent(roomId)}`)

  ctx = new AudioContext({ latencyHint: 'interactive' })
  if (navigator.audioSession) navigator.audioSession.type = 'playback' // ignore the iOS mute switch
  bus = new GainNode(ctx, { gain: 0.8 })
  bus.connect(new DynamicsCompressorNode(ctx, { threshold: -12, ratio: 12, attack: 0.003, release: 0.25 }))
    .connect(ctx.destination)
  hall = createReverb(ctx, bus)
  clickBus = new GainNode(ctx, { gain: 0.4 })
  clickBus.connect(ctx.destination)
  // Audio can get suspended (autoplay rules, iOS interruptions) until the next gesture; iOS only
  // counts the end of a touch as one
  for (const type of ['pointerdown', 'pointerup', 'keydown']) addEventListener(type, resume, true)
  resume()

  const since = Date.now()
  timeline = [{ bpm: 100, bpi: 16, epoch: since, rev: 0, since, solo: true }]
  me = addPlayer(selfId, name, since)
  me.synth.setPatch(load('patch'))
  // While you are alone, your part comes back an interval later, as the others will hear it
  echo = { on: false, color: `hsl(${me.hue} 35% 72%)`, li: me.li, synth: new Synth(ctx, me.gain, me.synth.patch, me.wet) }
  kb = createKeyboard($('#keys'), $('#octave'), {
    onNoteOn: (note, vel) => { me.synth.noteOn(note, vel); pulse(me); ribbon(note, me.color, now()); send(['on', note, vel]) },
    onNoteOff: note => { me.synth.noteOff(note); send(['off', note]) },
    onPedal: down => $('#sustain').setAttribute('aria-pressed', down),
  })
  $('#keys').style.setProperty('--me', me.color)
  buildSynthUI()

  const room = joinRoom({ appId: APP_ID, maxReceiveBytes: 1 << 16 }, roomId, { onJoinError }) // real messages are ~2 KB
  net = {
    hello: room.makeAction('hello'),
    session: room.makeAction('session'),
    ev: room.makeAction('ev'),
    clock: room.makeAction('clock', { kind: 'request', onRequest: () => now() }),
  }
  room.onPeerJoin = id => {
    if (unreachable.has(id)) forgetUnreachable(id)
    const cur = sessionAt(now()), next = timeline.at(-1), age = Date.now() - since
    told.set(id, age)
    net.hello.send({
      v: PROTOCOL, name, age, patch: me.synth.patch, session: cur, next: next === cur ? undefined : next,
    }, { target: id })
  }
  room.onPeerLeave = removePlayer
  net.hello.onMessage = onHello
  net.session.onMessage = onSession
  net.ev.onMessage = onEvent
  addEventListener('pagehide', () => room.leave())
  addEventListener('pageshow', e => e.persisted && location.reload()) // back from the bfcache, out of the room
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return kb.releaseAll()
    keepAwake()
    resume()
  })
  keepAwake()
  ctx.onstatechange = onAudioState
  onAudioState()

  $('#lobby').hidden = true
  $('#app').hidden = false
  $('#room-name').textContent = roomId
  showSession()
  updateStatus()
  setInterval(tick, TICK)
  setInterval(() => leaderId !== selfId && syncClock(leaderId), 60000) // clocks drift
  requestAnimationFrame(draw)
}

function resume() {
  if (ctx.state !== 'running') ctx.resume().catch(err => console.error('audio could not resume yet', err))
}

/** Shows when audio is paused; what was sounding stops, so nothing sticks or bursts on resume. */
function onAudioState() {
  const live = ctx.state === 'running' // WebKit also has 'interrupted'
  $('#resume').hidden = live
  if (!live) silenceOthers()
  ctxBase = null // its clock stood still: map it afresh
}

/** Stops what the other players (and the echo) are sounding, and clears their marks. */
function silenceOthers() {
  for (const p of [...players.values(), echo]) if (p !== me) p.synth.allOff()
  kb.unmarkAll()
}

/** Keeps a phone's screen on while you jam (released by the browser when the page is hidden). */
function keepAwake() {
  navigator.wakeLock?.request('screen').catch(err => console.error('screen may sleep', err))
}

// ── Players ───────────────────────────────────────────────────────────

/** Adds a player with their own synth and mixer strip (volume and mute are local only). */
function addPlayer(id, name, since) {
  const hue = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)
  const color = `hsl(${hue} 70% 62%)`
  const gain = new GainNode(ctx), wet = new GainNode(ctx) // the dry sound and the shared reverb's send
  gain.connect(bus)
  wet.connect(hall)
  const li = $('#players').appendChild(document.createElement('li'))
  li.style.setProperty('--color', color)
  li.innerHTML = `<span class="dot"></span><span class="name"></span>
    <button class="mute" aria-pressed="false">Mute</button>
    <input type="range" min="0" max="1.5" step="0.01" value="1" aria-label="Volume">`
  li.querySelector('.name').textContent = id === selfId ? `${name} (you)` : name
  const [mute, vol] = li.querySelectorAll('button, input')
  mute.ariaLabel = `Mute ${name}`
  vol.ariaLabel = `Volume of ${name}`
  const apply = () => {
    const level = mute.classList.contains('on') ? 0 : +vol.value
    for (const g of [gain, wet]) g.gain.setTargetAtTime(level, ctx.currentTime, 0.02)
  }
  vol.oninput = apply
  mute.onclick = () => {
    mute.setAttribute('aria-pressed', mute.classList.toggle('on'))
    apply()
  }
  const p = { id, name, since, hue, color, gain, wet, li, synth: new Synth(ctx, gain, undefined, wet) }
  players.set(id, p)
  return p
}

function removePlayer(id) {
  const p = players.get(id)
  if (!p || p === me) return
  players.delete(id)
  for (const g of [p.gain, p.wet]) g.gain.setTargetAtTime(0, ctx.currentTime, 0.01) // a hard cut would click
  setTimeout(() => {
    p.synth.dispose()
    p.gain.disconnect()
    p.wet.disconnect()
  }, 100)
  p.li.remove()
  kb.unmarkAll(id)
  queue = queue.filter(q => q.id !== id)
  toast(`${p.name} left`, p.color)
  electLeader()
  updateStatus()
}

/**
 * A peer introduces itself: protocol version, name, how long it has been here, synth patch and
 * its sessions. Both sides greet each other as the link comes up, so comparing the age it told us
 * with the one we told it ranks the two of us the same way on both ends, whatever the clocks say
 * and however long the greetings took.
 */
function onHello(msg, { peerId }) {
  const { v, name, age, patch, session, next } = msg ?? {}
  if (!Number.isFinite(age)) return
  let p = players.get(peerId)
  if (!p) {
    const ours = told.get(peerId) ?? Date.now() - me.since
    p = addPlayer(peerId, cleanName(name), me.since + ours - clamp(age, 0, 1e12))
    if (Date.now() - me.since > 5000) toast(`${p.name} joined`, p.color) // not everyone already here
    if (v > PROTOCOL) toast(`${p.name} has a newer Jam. Reload the page to hear them right.`, p.color)
  }
  p.synth.setPatch(patch)
  // If the room's sessions win over ours, our first word from it is taken as it is: our clock isn't
  // synced yet, so it can't tell which of them are already in effect
  const theirs = [session, next].map(cleanSession).filter(Boolean)
  if (!heard && theirs.length && wins(theirs.at(-1), timeline.at(-1))) restart(theirs)
  else theirs.forEach(s => adoptSession(s))
  heard = true
  electLeader()
  updateStatus()
}

/**
 * Trystero found a peer through signaling but couldn't connect to it, typically because a network
 * between us blocks direct connections. It retries about every minute; a peer that stops failing
 * for longer than that has left. Names only travel once connected, so these are counted, not named.
 */
function onJoinError({ peerId, error }) {
  console.error(error)
  if (!peerId) return
  if (!unreachable.has(peerId)) toast("Someone is trying to join, but can't connect", 'var(--danger)')
  clearTimeout(unreachable.get(peerId))
  unreachable.set(peerId, setTimeout(() => forgetUnreachable(peerId), 150000))
  updateStatus()
}

function forgetUnreachable(id) {
  clearTimeout(unreachable.get(id))
  unreachable.delete(id)
  updateStatus()
}

/** Shows how many are here (and can't connect); alone, you get the invite card and, unless switched off, your own echo. */
function updateStatus() {
  const alone = players.size === 1, n = unreachable.size
  $('#status').textContent = `${players.size} player${alone ? '' : 's'}`
  $('#unreachable').hidden = !n
  $('#unreachable').textContent = `${n === 1 ? 'Someone is' : `${n} people are`} in this room but can't connect to you: ` +
    'a network between you blocks direct connections. Trying again every minute.'
  $('#alone').hidden = !alone
  const on = alone && $('#echo').checked
  if (echo.on === on) return
  echo.on = on
  if (on) return echo.synth.setPatch(me.synth.patch)
  echo.synth.allOff()
  queue = queue.filter(q => q.id !== 'echo')
  kb.unmarkAll('echo')
}

function pulse(p) {
  if (!reducedMotion.matches) p.li.querySelector('.dot').animate([{ transform: 'scale(1.8)' }, { transform: 'none' }], 250)
}

/** A short-lived notice at the top of the screen. */
function toast(text, color = 'var(--accent)') {
  const el = $('#toasts').appendChild(document.createElement('div'))
  el.textContent = text
  el.style.setProperty('--color', color)
  setTimeout(() => el.remove(), 3500)
  while ($('#toasts').childElementCount > 3) $('#toasts').firstElementChild.remove()
  return el
}

// ── Shared clock ──────────────────────────────────────────────────────

/** The longest-present player (ties broken by id) is everyone's clock reference. */
function electLeader() {
  const leader = [...players.values()].reduce((a, b) =>
    b.since < a.since || (b.since === a.since && b.id < a.id) ? b : a)
  if (leader.id === leaderId) return
  leaderId = leader.id
  // A new leader keeps its offset, so the shared clock carries on from the previous leader's
  if (leader !== me) syncClock(leader.id)
}

/** NTP-style: query the leader's clock a few times and trust the fastest round trip. */
async function syncClock(id) {
  let best = Infinity, offset
  for (let i = 0; i < 8 && id === leaderId; i++) {
    try {
      const t0 = Date.now()
      const theirs = await net.clock.request(0, { target: id, timeoutMs: 2000 })
      const t1 = Date.now()
      if (Number.isFinite(theirs) && Math.abs(theirs - t1) < 1e12 && t1 - t0 < best) { // ~30 years: see cleanSession
        best = t1 - t0
        offset = theirs - (t0 + t1) / 2
      }
    } catch (err) {
      console.error(`clock request to ${id} failed`, err)
    }
  }
  if (id !== leaderId || offset === undefined) return
  if (Math.abs(offset - clockOffset) > 20) nextClick = null // small corrections must not double a click
  if (ctxBase !== null) ctxBase += offset - clockOffset // audio time maps onto the corrected clock at once
  clockOffset = offset
  console.info(`clock synced to ${id}: offset ${offset.toFixed(1)} ms, best round trip ${best} ms`)
}

// ── Sessions: tempo and interval length ───────────────────────────────

/** A session from anyone, validated and clamped, or null. */
function cleanSession(s) {
  if (![s?.bpm, s?.bpi, s?.epoch, s?.since].every(Number.isFinite) || !Number.isSafeInteger(s.rev)) return null
  if (Math.abs(s.epoch - now()) > 1e12) return null // ~30 years; further out, float maths stalls the scheduler
  const { bpm, bpi, epoch, rev, since, solo } = s
  return { bpm: clamp(bpm, 30, 300), bpi: Math.round(clamp(bpi, 1, 64)), epoch, rev, since, solo: solo === true }
}

/**
 * Whether session s supersedes t, the same way for everyone, so all converge. The room's sessions
 * beat those a newcomer made while alone; among solo ones, the earliest maker's wins. Otherwise a
 * newer revision wins, or the same revision set by an older member (simultaneous changes).
 */
function wins(s, t) {
  if (s.solo !== t.solo) return !s.solo
  if (s.solo && s.since !== t.since) return s.since < t.since
  return s.rev > t.rev || (s.rev === t.rev && s.since < t.since)
}

/**
 * Takes on session s if it supersedes the latest one we know. A change set for a future downbeat
 * waits in the timeline (replacing any other pending one); a session already in effect replaces
 * everything. Returns whether s was taken.
 */
function adoptSession(s) {
  s = cleanSession(s)
  if (!s || !wins(s, timeline.at(-1))) return false
  if (s.epoch > now()) {
    timeline = [...timeline.filter(x => x.epoch <= now()), s]
    showSession()
  } else restart([s])
  return true
}

/** Switches to (clean) sessions on an unrelated grid: what was queued or sounding on the old one stops. */
function restart(sessions) {
  timeline = sessions.sort((a, b) => a.epoch - b.epoch)
  queue = []
  nextClick = null
  silenceOthers()
  showSession()
}

/** A tempo change from a peer, credited to them. */
function onSession(s, { peerId }) {
  const p = players.get(peerId)
  if (!adoptSession(s) || !p) return
  const { bpm, bpi } = timeline.at(-1)
  p.tempoToast?.remove() // spinner clicks send one change each
  p.tempoToast = toast(`${p.name} set ${bpm} BPM, ${bpi} beats`, p.color)
}

/**
 * Tempo and Beats changes start on a downbeat at least a second away, so everyone gets them in
 * time. A pending change about to start can no longer be replaced everywhere, so a new one follows it.
 */
function changeSession(bpm = +$('#bpm').value, bpi = +$('#bpi').value) {
  const T = now(), cur = sessionAt(T), last = timeline.at(-1)
  bpm = clamp(bpm || last.bpm, 30, 300)
  bpi = Math.round(clamp(bpi || last.bpi, 1, 64))
  if (bpm === last.bpm && bpi === last.bpi) return showSession()
  if (last !== cur && last.epoch - T < 1000) return setTimeout(() => changeSession(bpm, bpi), last.epoch - T + 1)
  let epoch = last !== cur ? last.epoch : cur.epoch + (position(T).n + 1) * ms(cur)
  while (epoch - T < 1000) epoch += ms(cur)
  adoptSession({ bpm, bpi, epoch, rev: last.rev + 1, since: me.since, solo: !heard })
  net.session.send(timeline.at(-1))
}
$('#bpm').onchange = $('#bpi').onchange = () => changeSession()
$('#bpm').onkeydown = $('#bpi').onkeydown = e => { // Enter commits, and gives the piano its keys back
  if (e.key === 'Enter') e.target.blur()
}

/** Shows the latest session's settings (marked while waiting for their downbeat) and the grid in effect. */
function showSession() {
  const cur = sessionAt(now()), last = timeline.at(-1)
  for (const [input, value] of [[$('#bpm'), last.bpm], [$('#bpi'), last.bpi]]) {
    if (document.activeElement !== input) input.value = value
  }
  $('#transport').classList.toggle('pending', last !== cur)
  $('#progress').style.setProperty('--bpi', cur.bpi)
  $('#progress').style.setProperty('--group', [4, 3].find(g => cur.bpi % g === 0 && cur.bpi > g) ?? cur.bpi)
}

// ── Events and scheduling ─────────────────────────────────────────────

/** Broadcasts a local event, stamped with where in the current interval it happened. */
function send(e) {
  if (e[0] !== 'set') flush() // keeps parameter changes in order with notes
  const { s, n, o } = position(now())
  net.ev.send({ s: s.epoch, n, o, e })
  if (echo.on) queue.push({ at: s.epoch + (n + 1) * ms(s) + o, from: s, id: 'echo', e })
}

/** Sends the latest value of each parameter changed since the last call (sliders move faster than that). */
function flush() {
  for (const key of dirty) send(['set', key, me.synth.patch[key]])
  dirty.clear()
}

/** A remote event from the sender's interval n, offset o: due in our interval n + 1, same offset. */
function onEvent(msg, { peerId }) {
  const { s, n, o, e } = msg ?? {}
  if (!players.has(peerId) || !Array.isArray(e)) return
  const from = timeline.find(x => x.epoch === s)
  const at = from && Number.isInteger(n) && Number.isFinite(o) ? from.epoch + (n + 1) * ms(from) + o : null
  // On time give or take a couple of intervals (of the sender's grid), which also bounds the queue
  if (at && Math.abs(at - now()) < 2 * ms(from)) queue.push({ at, from, id: peerId, e })
  // Mistimed (clocks not synced yet, a tempo change crossing): releases and sound changes still apply, now
  else if (e[0] !== 'on') play({ id: peerId, e }, ctx.currentTime, 0)
}

/** Hands Web Audio everything due within LOOKAHEAD: metronome clicks and queued events. */
function tick() {
  const T = now()
  const t0 = ctx.currentTime
  const horizon = T + LOOKAHEAD
  // currentTime only moves once per audio callback, so T − currentTime overestimates where
  // AudioContext time 0 sits by up to a callback, differently every tick: the smallest value seen
  // is the truest. It may creep up (clock drift); jumps (suspension, clock re-sync) re-anchor it.
  const base = T - 1000 * t0
  ctxBase = ctxBase === null || Math.abs(base - ctxBase) > 50 ? base : Math.min(base, ctxBase + 0.05)
  const toCtx = at => Math.max(t0, (at - ctxBase) / 1000)
  // A suspended context would play everything handed to it at once on resume; sound changes still apply
  const live = ctx.state === 'running'
  // Not down to a pending session alone: before the first clock sync, T may be well ahead
  while (timeline.length > 2 && timeline[1].epoch + ms(timeline[1]) < T) timeline.shift()

  if (nextClick === null || nextClick < T - LATE) nextClick = nextBeat(T)
  for (; nextClick < horizon; nextClick = nextBeat(nextClick + 1)) {
    const { s, o } = position(nextClick)
    const t = toCtx(nextClick)
    // Beats are at least 200 ms apart: anything closer was already scheduled before a re-sync
    if (live && metronome.checked && t > lastClick + 0.1) click(lastClick = t, Math.round(o * s.bpm / 60000) % s.bpi === 0)
  }

  const due = []
  queue = queue.filter(q => {
    const at = retime(q.at, q.from, q.e[0] !== 'on')
    if (at !== null && at >= horizon) return true
    if (at !== null) due.push({ ...q, at })
    return false
  })
  for (const q of due.sort((a, b) => a.at - b.at)) {
    if (!live && q.e[0] === 'on') continue
    try {
      play(q, toCtx(q.at), q.at - T)
    } catch (err) {
      console.error('could not play', q, err)
    }
  }
}

/** Shared time of the first beat at or after T; a session's epoch is always one. */
function nextBeat(T) {
  const s = sessionAt(T), beat = 60000 / s.bpm
  const t = s.epoch + Math.ceil((T - s.epoch) / beat) * beat
  const next = timeline.find(x => x.epoch > T)
  return next && next.epoch < t ? next.epoch : t
}

/** Performs a remote player's (or the echo's) event at AudioContext time t, which is `inMs` from now. */
function play({ id, e: [type, a, b] }, t, inMs) {
  const p = id === 'echo' ? echo : players.get(id)
  if (!p) return
  if (type === 'set') return p.synth.set(a, b, t)
  if (type === 'patch') return p.synth.setPatch(a, t)
  if (!Number.isInteger(a) || a < 0 || a > 127) return
  const heard = inMs + latency()
  const still = () => (id === 'echo' ? echo.on : players.has(id)) && ctx.state === 'running'
  if (type === 'off') {
    p.synth.noteOff(a, t)
    setTimeout(() => kb.mark(a, id, null), heard)
  } else if (type === 'on' && inMs > -LATE) {
    p.synth.noteOn(a, clamp(+b || 0, 0, 1), t)
    setTimeout(() => {
      if (!still()) return
      kb.mark(a, id, p.color)
      pulse(p)
      ribbon(a, p.color)
    }, heard)
  }
}

function click(t, downbeat) {
  const osc = new OscillatorNode(ctx, { frequency: downbeat ? 1760 : 1320 })
  const env = new GainNode(ctx, { gain: 0 })
  env.gain.setValueAtTime(downbeat ? 1 : 0.5, t)
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
  osc.connect(env).connect(clickBus)
  osc.start(t)
  osc.stop(t + 0.05)
}

const metronome = $('#metronome')
const progress = $('#progress')
const fill = $('#fill')
const beatLabel = $('#beat')
let shown, beatKey

/** Animates the interval bar with what is heard (so behind the shared clock by the output latency). */
function draw() {
  requestAnimationFrame(draw)
  flush()
  const { s, n, o } = position(now() - latency())
  if (s !== shown) {
    shown = s
    showSession()
  }
  fill.style.transform = `scaleX(${Math.min(1, o / ms(s))})`
  const beat = Math.min(s.bpi, Math.floor(o * s.bpm / 60000) + 1)
  if (`${n}.${beat}` === beatKey) return
  beatKey = `${n}.${beat}`
  beatLabel.textContent = `${beat}/${s.bpi}`
  if (beat === 1 && !reducedMotion.matches) progress.animate([{ filter: 'brightness(1.8)' }, { filter: 'none' }], 350)
}

/** Marks a note heard at shared time T on the interval bar, in its player's color, fading over an interval. */
function ribbon(note, color, T = now() - latency()) {
  if (progress.childElementCount > 200) progress.querySelector('i').remove() // the oldest
  const { s, o } = position(T)
  const dot = progress.appendChild(document.createElement('i'))
  dot.style.cssText = `left: ${o / ms(s) * 100}%; top: ${85 - clamp((note - 36) / 60, 0, 1) * 70}%; background: ${color}`
  dot.animate([{ opacity: 1 }, { opacity: 0 }], ms(s)).onfinish = () => dot.remove()
}

// ── Sound panel ───────────────────────────────────────────────────────

// Sliders run 0..1; log-scaled parameters (frequencies, times) map exponentially
const toSlider = (p, v) => p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min)
function fromSlider(p, x) {
  const v = p.log ? p.min * (p.max / p.min) ** x : p.min + x * (p.max - p.min)
  return p.step ? Math.round(v / p.step) * p.step : v
}

/** A control per synth parameter, grouped into panels, plus the engine switch and the preset picker. */
function buildSynthUI() {
  for (const [key, p] of Object.entries(PARAMS)) {
    if (key === 'engine') continue // the switch in the heading
    const group = groups[p.group] ??= $('#params').appendChild(Object.assign(document.createElement('fieldset'), {
      innerHTML: `<legend>${p.group}</legend>`,
    }))
    group.dataset.engine ??= p.engine ?? '' // only the engine's own panels show
    if (key.startsWith('op')) group.dataset.op = key[2]
    if (key === 'fmAlg') {
      group.append(algorithmPicker())
      continue
    }
    const label = group.appendChild(document.createElement('label'))
    label.dataset.engine = p.engine ?? ''
    label.innerHTML = `<span>${p.label}</span>${p.options ? '' : '<span class="value" aria-hidden="true"></span>'}`
    const input = label.appendChild(document.createElement(p.options ? 'select' : 'input'))
    if (p.options) input.innerHTML = p.options.map(o => `<option value="${o}">${OPTION_LABELS[o]}</option>`).join('')
    else Object.assign(input, { type: 'range', min: 0, max: 1, step: p.step ? p.step / (p.max - p.min) : 'any' })
    input.oninput = () => setParam(key, p.options ? input.value : fromSlider(p, +input.value))
    input.onchange = () => save('patch', me.synth.patch)
    if (!p.options) input.ondblclick = () => { // back to the default
      setParam(key, p.def)
      showPatch()
      save('patch', me.synth.patch)
    }
    controls[key] = { input, value: label.querySelector('.value') }
  }

  // Phones show one operator at a time, picked with these tabs
  const tabs = Object.assign(document.createElement('nav'), { id: 'ops', ariaLabel: 'Operator' })
  tabs.innerHTML = [1, 2, 3, 4].map(n => `<button value="${n}"></button>`).join('')
  tabs.onclick = e => e.target.closest('button') && showOp(+e.target.closest('button').value)
  groups['Op 1'].before(tabs)
  showOp(1)

  $('#engine').onchange = e => {
    setParam('engine', e.target.value)
    save('patch', me.synth.patch)
    showPatch()
    audition()
  }

  const preset = $('#preset')
  const names = engine => Object.keys(PRESETS).filter(name => (PRESETS[name].engine ?? 'sub') === engine)
  preset.innerHTML = '<option value="" disabled>Custom</option>' + PARAMS.engine.options.map(engine =>
    `<optgroup label="${OPTION_LABELS[engine]}">${names(engine).map(name => `<option>${name}</option>`).join('')}</optgroup>`).join('')
  const saved = load('preset') ?? (load('patch') ? '' : 'Init')
  preset.value = Object.hasOwn(PRESETS, saved) ? saved : ''
  preset.onchange = () => choosePreset(preset.value)
  showPatch()
}

/** The algorithms as diagrams to pick from. */
function algorithmPicker() {
  const box = Object.assign(document.createElement('div'), { id: 'algs', role: 'radiogroup', ariaLabel: 'Algorithm' })
  box.innerHTML = ALGS.map((alg, i) => `<label title="Algorithm ${i + 1}: ${alg.name}">
    <input type="radio" name="fmAlg" value="${i + 1}">${algorithmSvg(alg)}<span>${i + 1} ${alg.name}</span></label>`).join('')
  box.onchange = e => {
    setParam('fmAlg', +e.target.value)
    save('patch', me.synth.patch)
    showRoles()
  }
  return box
}

/** An algorithm's diagram: each modulator above the operators it modulates, carriers (heard) at the bottom. */
function algorithmSvg({ mods, out }) {
  const ops = [1, 2, 3, 4]
  const depth = n => out.includes(n) ? 0 : 1 + Math.max(...mods.filter(([from]) => from === n).map(([, to]) => depth(to)))
  const xy = Object.fromEntries(ops.map(n => {
    const row = ops.filter(m => depth(m) === depth(n))
    return [n, [(row.indexOf(n) + 1) / (row.length + 1) * 60, 53 - depth(n) * 15]]
  }))
  const [x4, y4] = xy[4]
  return `<svg viewBox="0 0 60 60" aria-hidden="true">
    ${mods.map(([from, to]) => `<line x1="${xy[from][0]}" y1="${xy[from][1]}" x2="${xy[to][0]}" y2="${xy[to][1]}"/>`).join('')}
    <path d="M${x4 + 5} ${y4} h3 v-9 h-8 v4"/>
    ${ops.map(n => `<rect class="${out.includes(n) ? 'carrier' : ''}" x="${xy[n][0] - 5}" y="${xy[n][1] - 5}" width="10" height="10" rx="2"/>
      <text x="${xy[n][0]}" y="${xy[n][1] + 3}">${n}</text>`).join('')}
  </svg>`
}

/** Labels each operator with its role in the current algorithm: heard ("out") or what it modulates. */
function showRoles() {
  const { mods, out } = ALGS[me.synth.patch.fmAlg - 1]
  for (const n of [1, 2, 3, 4]) {
    const role = out.includes(n) ? 'out' : `→ ${mods.filter(([from]) => from === n).map(([, to]) => to).join(' ')}`
    const fb = n === 4 ? ' ⟲' : ''
    const legend = groups[`Op ${n}`].querySelector('legend'), tab = $(`#ops [value="${n}"]`)
    legend.textContent = `Op ${n} · ${role}${fb}`
    tab.textContent = `${n} ${role}${fb}`
    for (const el of [legend, tab]) el.classList.toggle('carrier', out.includes(n))
  }
}

function showOp(n) {
  for (const el of $$('#params fieldset[data-op]')) el.classList.toggle('off', +el.dataset.op !== n)
  for (const el of $$('#ops button')) el.setAttribute('aria-pressed', +el.value === n)
}

/**
 * Switches to a preset. The other engine's settings stay as they are, so flipping the engine
 * switch back brings that sound back.
 */
function choosePreset(name) {
  if (!Object.hasOwn(PRESETS, name)) return
  const engine = PRESETS[name].engine ?? 'sub'
  const other = Object.entries(me.synth.patch).filter(([key]) => PARAMS[key].engine && PARAMS[key].engine !== engine)
  me.synth.setPatch({ ...Object.fromEntries(other), ...PRESETS[name] })
  send(['patch', { ...me.synth.patch }]) // a copy: the echo replays it an interval later
  save('patch', me.synth.patch)
  save('preset', name)
  showPatch()
  audition()
}

/** Plays a new sound to you alone (not sent, not echoed), unless you are busy playing. */
function audition() {
  if (!kb.idle()) return
  const t = ctx.currentTime + 0.05, last = me.synth.lastFreq
  ;[60, 64, 67].forEach((note, i) => {
    me.synth.noteOn(note, 0.6, t + i * 0.12)
    me.synth.noteOff(note, t + i * 0.12 + 0.3)
  })
  me.synth.lastFreq = last // a glide must not start from the audition
}

/** Changes a parameter of my synth; others hear the change in step with my notes. */
function setParam(key, value) {
  me.synth.set(key, value)
  showValue(key)
  dirty.add(key)
  if ($('#preset').value) {
    $('#preset').value = '' // "Custom"
    save('preset', '')
  }
}

/** Shows a parameter's value on its control (the engine and the algorithm have their own). */
function showValue(key) {
  const { input, value } = controls[key] ?? {}
  if (!input) return
  const v = me.synth.patch[key]
  input.value = PARAMS[key].options ? v : toSlider(PARAMS[key], v)
  if (value) input.ariaValueText = value.textContent = fmt(key, v)
}

function showPatch() {
  const patch = me.synth.patch
  for (const key in controls) showValue(key)
  $(`#engine [value="${patch.engine}"]`).checked = true
  $(`#algs [value="${patch.fmAlg}"]`).checked = true
  $('#params').dataset.engine = patch.engine
  showRoles()
}

// ── Toolbar ───────────────────────────────────────────────────────────

/** Acts on pointerdown, so a button works while other fingers hold keys (they never produce a click). */
function onPress(button, fn) {
  button.onpointerdown = e => {
    if (e.button !== 0) return
    e.preventDefault() // and keep focus, so Space stays the sustain pedal
    fn()
  }
  button.onclick = e => e.detail || e.pointerType || fn() // keyboard activation only
}
onPress($('#oct-down'), () => kb.shift(-1))
onPress($('#oct-up'), () => kb.shift(1))
onPress($('#sustain'), () => kb.latch())

$('#midi').hidden = !navigator.requestMIDIAccess
$('#midi').onclick = async () => {
  try {
    const inputs = await kb.enableMidi()
    $('#midi').textContent = `MIDI: ${inputs} input${inputs === 1 ? '' : 's'}`
  } catch (err) {
    console.error('MIDI access failed', err)
    $('#midi').textContent = 'MIDI blocked'
  }
}

/** Copies this jam's link, confirming on the button. */
function copyLink(button) {
  button.dataset.label ??= button.textContent
  const copied = navigator.clipboard?.writeText(location.href) ?? Promise.reject(new Error('no clipboard (needs https)'))
  copied.then(() => {
    button.textContent = 'Copied!'
    setTimeout(() => { button.textContent = button.dataset.label }, 1500)
  }, err => {
    console.error('could not copy the link', err)
    toast('Could not copy. Share the address of this page.')
  })
}
$('#copy').onclick = () => copyLink($('#copy'))
$('#echo').checked = load('echo') ?? true
$('#echo').onchange = () => {
  save('echo', $('#echo').checked)
  updateStatus()
}
$('#share').onclick = () => navigator.share
  // The link alone: given text as well, iOS share targets (Copy among them) tend to keep only the text
  ? navigator.share({ title: 'Come jam with me', url: location.href }).catch(err => {
    console.error('not shared', err)
    if (err.name !== 'AbortError') copyLink($('#share')) // not just closed: offer the link another way
  })
  : copyLink($('#share'))
$('#resume').onclick = resume
