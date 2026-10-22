/**
 * Piano input from three sources: the on-screen keys (multi-touch, and sliding a finger across
 * keys plays them), the computer keyboard, and Web MIDI devices. Presses are reference-counted
 * per note, so a note held by two sources at once only starts and stops once.
 *
 * The on-screen keys are a whole piano seen through a window. It fits the width by default; a
 * navigator strip, the piano in miniature with a box around the keys on screen, moves the window
 * and sets the key size.
 *
 * Computer keys use physical positions (KeyboardEvent.code), so they work on any layout:
 *   white  A S D F G H J K L ; '   →  C D E F G A B C D E F
 *   black  W E   T Y U   O P       →  C# D#  F# G# A#  C# D#
 *   Z / X  octave down / up
 *   Space  sustain pedal (as are MIDI CC 64 and the on-screen latch)
 */

const KEYMAP = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
}
const LABELS = Object.fromEntries(Object.entries(KEYMAP).map(([code, i]) =>
  [i, { Semicolon: ';', Quote: "'" }[code] ?? code.slice(3)]))
const BLACK = new Set([1, 3, 6, 8, 10])
const NOTES = Array.from({ length: 88 }, (_, i) => 21 + i) // A0 to C8
const WHITE_NOTES = NOTES.filter(n => !BLACK.has(n % 12))
const WHITES = WHITE_NOTES.length // 52
/** How many white keys lie below note n: where its key starts (or, for a black key, its middle). */
const whitesBelow = n => WHITE_NOTES.filter(w => w < n).length
const noteName = n => `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][n % 12]}${Math.floor(n / 12) - 1}`
const MIN_WHITES = 5 // white keys on screen when zoomed in all the way
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
// Fields that need letter keys; selects, sliders and checkboxes leave them to the piano
const TYPING = 'input:not([type=range], [type=checkbox], [type=radio]), textarea'

/**
 * @param {{keys: HTMLElement, octave: HTMLElement, nav?: HTMLElement, view?: {zoom: number, center: number}}} els
 *   the container for the keys, the label showing the octave the computer keys play, the container
 *   for the navigator strip, and a view the strip set before (from onView)
 * @param {{onNoteOn(note: number, vel: number): void, onNoteOff(note: number): void,
 *   onPedal(down: boolean): void, onView?(view: {zoom: number, center: number}): void}} handlers
 */
export function createKeyboard({ keys: el, octave: octaveLabel, nav, view }, { onNoteOn, onNoteOff, onPedal, onView }) {
  let octave = 4
  const held = new Map() // note → number of sources holding it
  const sustained = new Set() // notes let go of while the pedal is down, still sounding
  const pedal = new Set() // what holds the pedal down: 'space', 'latch', 'midi'
  const marks = new Map() // note → Map(player id → color) of other players' sounding notes
  const codes = new Map() // KeyboardEvent.code → note it started
  const pointers = new Map() // pointerId → { note under it (or null between keys), x, y where it took it }
  const miniKeys = new Map() // note → its key on the strip
  const base = () => 12 * (octave + 1) // MIDI note the A key plays
  // The window, in white keys: `count` of them around `center`. Until the strip sets a key width
  // (zoom, in px), as many keys fit as are comfortable to hit, around the computer keys.
  let zoom = Number.isFinite(view?.zoom) && view.zoom > 0 ? view.zoom : null
  let center = Number.isFinite(view?.center) ? view.center : 0, count = 0
  const minKeyWidth = matchMedia('(pointer: coarse)').matches ? 48 : 34 // px of a white key when fitting
  const fitting = () => zoom === null || !nav?.clientWidth // a chosen key size applies only where the strip is

  const press = (note, vel) => {
    const n = held.get(note) ?? 0
    held.set(note, n + 1)
    if (n) return
    sustained.delete(note) // striking a sustained note again restarts it
    onNoteOn(note, vel)
    paint(note)
  }
  const release = note => {
    const n = held.get(note)
    if (n > 1) return held.set(note, n - 1)
    if (!n) return
    held.delete(note)
    if (pedal.size) sustained.add(note)
    else onNoteOff(note)
    paint(note)
  }

  /** Presses or lifts the sustain pedal on behalf of one source; it is down while any holds it. */
  function setPedal(source, down) {
    const was = pedal.size > 0
    if (down) pedal.add(source)
    else pedal.delete(source)
    if (was === pedal.size > 0) return
    if (!pedal.size) {
      const notes = [...sustained]
      sustained.clear()
      for (const note of notes) {
        onNoteOff(note)
        paint(note)
      }
    }
    onPedal(pedal.size > 0)
  }

  function paint(note) {
    const key = el.querySelector(`[data-note="${note}"]`)
    if (!key) return
    const colors = [...(marks.get(note)?.values() ?? [])]
    key.classList.toggle('down', held.has(note))
    key.classList.toggle('sus', sustained.has(note))
    key.classList.toggle('mark', colors.length > 0)
    if (colors.length) key.style.setProperty('--mark', colors.at(-1))
    // The strip shows the same, so notes off screen are seen too: yours first, else the latest player's
    const mini = miniKeys.get(note)
    if (mini) mini.style.fill = held.has(note) || sustained.has(note) ? 'var(--me)' : colors.at(-1) ?? ''
  }

  // Every key of the piano, once; place() slides and scales the row to show the window
  const row = el.appendChild(document.createElement('div'))
  row.className = 'row'
  row.style.setProperty('--whites', WHITES)
  for (const note of NOTES) {
    const black = BLACK.has(note % 12)
    const key = row.appendChild(document.createElement('div'))
    key.className = `key ${black ? 'black' : 'white'}`
    key.dataset.note = note
    if (black) key.style.left = `${whitesBelow(note) / WHITES * 100}%`
    if (note % 12 === 0) key.insertAdjacentHTML('beforeend', `<span class="note">C${note / 12 - 1}</span>`)
  }
  const blacks = [...row.querySelectorAll('.black')].map(key => [key, whitesBelow(+key.dataset.note)]) // [key, where its middle is]

  /** Labels the keys the computer keys play. */
  function label() {
    for (const span of row.querySelectorAll('.label')) span.remove()
    for (const [i, text] of Object.entries(LABELS)) {
      row.querySelector(`[data-note="${base() + +i}"]`)?.insertAdjacentHTML('afterbegin', `<span class="label">${text}</span>`)
    }
    octaveLabel.textContent = `C${octave}`
  }

  /** Shows the window: slides and scales the row of keys, and moves the strip's box to match. */
  function place() {
    const width = el.clientWidth
    if (!width) return // not shown yet
    const fitted = fitting()
    let keyWidth
    if (fitted) {
      count = clamp(Math.floor(width / minKeyWidth), MIN_WHITES, 36)
      keyWidth = width / count
      const spareOctaves = Math.max(0, Math.floor((count - 11) / 7)) // 11 white keys are mapped
      center = whitesBelow(base() - 12 * Math.round(spareOctaves / 2)) + count / 2
    } else {
      keyWidth = clamp(zoom, width / WHITES, width / MIN_WHITES)
      count = width / keyWidth
    }
    center = clamp(center, count / 2, WHITES - count / 2)
    const first = center - count / 2
    row.style.width = `${WHITES * keyWidth}px`
    row.style.transform = `translateX(${-first * keyWidth}px)`
    // Fitted, the window ends on white keys' edges, which a black key mustn't straddle half shown
    for (const [key, at] of blacks) key.hidden = fitted && (at <= first || at >= first + count)
    if (!nav) return
    box.style.left = `${first / WHITES * 100}%`
    box.style.width = `${count / WHITES * 100}%`
    nav.ariaLabel = `Keys shown: ${noteName(WHITE_NOTES[Math.round(first)])} to ${noteName(WHITE_NOTES[Math.round(first + count) - 1])}`
  }

  function shift(d) {
    if (octave + d < 1 || octave + d > 6) return // every computer key stays on the piano
    octave += d
    label()
    if (!fitting()) center = whitesBelow(base()) + 5.5 // a chosen key size stays; the window centres on the computer keys
    place()
  }

  // The navigator strip. Drag the box to move the window, drag its edges or pinch it to resize it
  // (fewer keys on screen are bigger), or tap beside it to jump there. Positions are in white keys.
  let box
  if (nav) {
    const rects = [...WHITE_NOTES, ...NOTES.filter(n => BLACK.has(n % 12))].map(n => BLACK.has(n % 12)
      ? `<rect class="b" x="${whitesBelow(n) - 0.3}" width="0.6" height="0.6" data-note="${n}"/>`
      : `<rect class="w${n === 60 ? ' c4' : ''}" x="${whitesBelow(n)}" width="1" height="1" data-note="${n}"/>`)
    nav.innerHTML = `<svg viewBox="0 0 ${WHITES} 1" preserveAspectRatio="none">${rects.join('')}</svg><div class="box"></div>`
    for (const rect of nav.querySelectorAll('rect')) miniKeys.set(+rect.dataset.note, rect)
    box = nav.querySelector('.box')

    const fingers = new Map() // pointerId → clientX
    let gesture = null
    const at = x => {
      const r = nav.getBoundingClientRect()
      return (x - r.left) / r.width * WHITES
    }
    /** Starts a gesture from the fingers now down; `fresh` when the first lands, deciding what it grabs. */
    const begin = fresh => {
      zoom ??= Math.max(el.clientWidth / count, minKeyWidth) // the strip sets the key size from now on, starting from the one shown
      const [a, b] = [...fingers.values()].map(at)
      const first = center - count / 2, last = first + count
      // An edge can be grabbed from a fingertip outside it to `grip` inside it; a small box keeps its
      // middle for moving it
      const reach = 14 / nav.clientWidth * WHITES, grip = clamp(count / 2 - reach, 0, reach)
      if (b !== undefined) gesture = { kind: 'pinch', span: Math.max(1, Math.abs(a - b)), mid: (a + b) / 2, count, center }
      else if (fresh && a > first - reach && a < first + grip) gesture = { kind: 'resize', fixed: last, side: -1 }
      else if (fresh && a > last - grip && a < last + reach) gesture = { kind: 'resize', fixed: first, side: 1 }
      else {
        if (fresh && (a < first || a > last)) center = a
        gesture = { kind: 'pan', from: a, center }
      }
      place()
    }
    const move = () => {
      const [a, b] = [...fingers.values()].map(at), g = gesture
      if (g.kind === 'pinch') {
        count = clamp(g.count * Math.abs(a - b) / g.span, MIN_WHITES, WHITES)
        center = g.center + (a + b) / 2 - g.mid
      } else if (g.kind === 'resize') {
        count = clamp((a - g.fixed) * g.side, MIN_WHITES, g.side > 0 ? WHITES - g.fixed : g.fixed) // up to the piano's end
        center = g.fixed + g.side * count / 2
      } else center = g.center + a - g.from
      if (g.kind !== 'pan') zoom = el.clientWidth / count // a pan keeps the key size, even while a pane caps it
      place()
    }
    nav.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      e.preventDefault()
      nav.setPointerCapture(e.pointerId)
      fingers.set(e.pointerId, e.clientX)
      begin(fingers.size === 1)
    })
    nav.addEventListener('pointermove', e => {
      if (!fingers.has(e.pointerId)) return
      fingers.set(e.pointerId, e.clientX)
      move()
    })
    const lift = e => {
      if (!fingers.delete(e.pointerId)) return
      if (fingers.size) begin(false) // the fingers left carry on
      else onView?.({ zoom, center })
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) nav.addEventListener(type, lift)
  }

  label()
  place()

  // On-screen keys. Each pointer is captured by the keyboard, so it keeps reporting wherever it
  // goes, and the key under a moving finger is found by position.
  const keyAt = e => {
    const key = document.elementFromPoint(e.clientX, e.clientY)?.closest('.key')
    return el.contains(key) ? key : null
  }
  const velocity = (e, key) => { // louder towards the front edge of the key, like reaching in
    const r = key.getBoundingClientRect()
    return 0.35 + 0.65 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
  }
  el.addEventListener('pointerdown', e => {
    const key = e.target.closest('.key')
    if (!key || e.button !== 0) return
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    pointers.set(e.pointerId, { note: +key.dataset.note, x: e.clientX, y: e.clientY })
    press(+key.dataset.note, velocity(e, key))
  })
  el.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId)
    // A resting finger trembles, and the strip may slide the keys under it: only moving on changes notes
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return
    const key = keyAt(e)
    const note = key ? +key.dataset.note : null
    if (note === p.note) return Object.assign(p, { x: e.clientX, y: e.clientY })
    if (p.note !== null) release(p.note)
    pointers.set(e.pointerId, { note, x: e.clientX, y: e.clientY })
    if (key) press(note, velocity(e, key))
  })
  const lift = e => {
    const p = pointers.get(e.pointerId)
    if (!p) return
    pointers.delete(e.pointerId)
    if (p.note !== null) release(p.note)
  }
  el.addEventListener('pointerup', lift)
  el.addEventListener('pointercancel', lift)
  el.addEventListener('lostpointercapture', lift)
  el.addEventListener('contextmenu', e => e.preventDefault()) // long-press menu on mobile

  // Computer keyboard. Space and letters belong to the piano, except on a control reached with the
  // keyboard (Tab), whose own they are. (:focus-visible can't tell: Chrome and Safari set it on a
  // clicked select, and on any focused control once a key is down.) The control is remembered
  // rather than flagged, as focus can fall back to the page without a focusout.
  let byKey = false, keyTarget = null // the control the keyboard last moved the focus to
  addEventListener('pointerdown', () => { byKey = false }, true)
  addEventListener('focusin', e => { keyTarget = byKey ? e.target : null })
  addEventListener('keydown', e => {
    byKey = true
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.(TYPING)) return
    const keyFocus = e.target === keyTarget
    if (!keyFocus && e.key.length === 1) e.preventDefault() // no select type-ahead, toggling or scrolling
    if (e.code === 'Space' && !keyFocus) return setPedal('space', true)
    if (!(e.code in KEYMAP) && e.code !== 'KeyX' && e.code !== 'KeyZ') return
    e.preventDefault()
    if (e.repeat) return
    if (e.code === 'KeyX' || e.code === 'KeyZ') return shift(e.code === 'KeyX' ? 1 : -1)
    if (codes.has(e.code)) return
    const note = base() + KEYMAP[e.code]
    codes.set(e.code, note)
    press(note, 0.8)
  })
  addEventListener('keyup', e => {
    if (e.code === 'Space') setPedal('space', false)
    if (!codes.has(e.code)) return
    release(codes.get(e.code))
    codes.delete(e.code)
  })
  const releaseKeys = () => {
    codes.forEach(release)
    codes.clear()
    setPedal('space', false)
  }
  addEventListener('blur', () => {
    // Focus returns to the same control with the window: it was reached the way it was. (Alt+Tab
    // and the keys just played would otherwise make a clicked control look keyboard-reached.)
    byKey = keyTarget === document.activeElement
    releaseKeys() // key-ups are lost while the window is unfocused
  })

  new ResizeObserver(place).observe(el)

  return {
    shift,

    /** Toggles the on-screen sustain latch. */
    latch: () => setPedal('latch', !pedal.has('latch')),

    /**
     * Lets go of everything a hidden page can't hear being released: keys, fingers, the Space
     * pedal and the latch. MIDI stays, as the instrument still sends its note-offs.
     */
    releaseAll() {
      releaseKeys()
      pointers.forEach(p => p.note !== null && release(p.note))
      pointers.clear()
      setPedal('latch', false)
    },

    /** Whether nothing is held or sustained. */
    idle: () => !held.size && !sustained.size,

    /** Shows (color) or clears (null) another player's note on the keys. */
    mark(note, id, color) {
      const m = marks.get(note) ?? new Map()
      if (color) m.set(id, color)
      else m.delete(id)
      if (m.size) marks.set(note, m)
      else marks.delete(note)
      paint(note)
    },

    /** Clears all of one player's marks, or everyone's. */
    unmarkAll(id) {
      for (const [note, m] of marks) {
        if (id === undefined) m.clear()
        else if (!m.delete(id)) continue
        if (!m.size) marks.delete(note)
        paint(note)
      }
    },

    /** Plays from every connected MIDI input (and ones plugged in later); resolves to their count. */
    async enableMidi() {
      const access = await navigator.requestMIDIAccess()
      const bind = () => access.inputs.forEach(input => {
        input.onmidimessage = ({ data: [status, a, b] }) => {
          const cmd = status & 0xf0
          if (cmd === 0x90 && b) press(a, b / 127)
          else if (cmd === 0x80 || cmd === 0x90) release(a)
          else if (cmd === 0xb0 && a === 64) setPedal('midi', b >= 64)
        }
      })
      bind()
      access.onstatechange = bind
      return access.inputs.size
    },
  }
}
