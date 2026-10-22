/**
 * Piano input from three sources: the on-screen keys (multi-touch, and sliding a finger across
 * keys plays them), the computer keyboard, and Web MIDI devices. Presses are reference-counted
 * per note, so a note held by two sources at once only starts and stops once.
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
const MIN_KEY_WIDTH = 34 // px of a white key; decides how many octaves fit
// Fields that need letter keys; selects, sliders and checkboxes leave them to the piano
const TYPING = 'input:not([type=range], [type=checkbox], [type=radio]), textarea'

/**
 * @param {HTMLElement} el container for the keys
 * @param {HTMLElement} octaveLabel shows the octave the computer keys play
 * @param {{onNoteOn(note: number, vel: number): void, onNoteOff(note: number): void, onPedal(down: boolean): void}} handlers
 */
export function createKeyboard(el, octaveLabel, { onNoteOn, onNoteOff, onPedal }) {
  let octave = 4
  const held = new Map() // note → number of sources holding it
  const sustained = new Set() // notes let go of while the pedal is down, still sounding
  const pedal = new Set() // what holds the pedal down: 'space', 'latch', 'midi'
  const marks = new Map() // note → Map(player id → color) of other players' sounding notes
  const codes = new Map() // KeyboardEvent.code → note it started
  const pointers = new Map() // pointerId → note under it (or null between keys)
  const base = () => 12 * (octave + 1) // MIDI note the A key plays

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
  }

  /** Rebuilds the keys to fill the width, keeping the computer-key octaves roughly centered. */
  function render() {
    const whites = Math.max(7, Math.min(36, Math.floor(el.clientWidth / MIN_KEY_WIDTH)))
    const spareOctaves = Math.max(0, Math.floor((whites - 11) / 7)) // 11 white keys are mapped
    el.style.setProperty('--whites', whites)
    el.replaceChildren()
    for (let note = base() - 12 * Math.round(spareOctaves / 2), w = 0; w < whites; note++) {
      const black = BLACK.has(note % 12)
      const key = el.appendChild(document.createElement('div'))
      key.className = `key ${black ? 'black' : 'white'}`
      key.dataset.note = note
      if (black) key.style.left = `${(w / whites) * 100}%`
      else w++
      const label = LABELS[note - base()]
      if (label) key.insertAdjacentHTML('beforeend', `<span class="label">${label}</span>`)
      if (note % 12 === 0) key.insertAdjacentHTML('beforeend', `<span class="note">C${note / 12 - 1}</span>`)
      paint(note)
    }
    octaveLabel.textContent = `C${octave}`
  }

  function shift(d) {
    octave = Math.max(0, Math.min(8, octave + d))
    render()
  }

  // On-screen keys. Each pointer is captured by the keyboard, so it keeps reporting even when a
  // re-render replaces the key under it, and the key under a moving finger is found by position.
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
    pointers.set(e.pointerId, +key.dataset.note)
    press(+key.dataset.note, velocity(e, key))
  })
  el.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return
    const key = keyAt(e)
    const note = key ? +key.dataset.note : null
    const prev = pointers.get(e.pointerId)
    if (note === prev) return
    if (prev !== null) release(prev)
    pointers.set(e.pointerId, note)
    if (key) press(note, velocity(e, key))
  })
  const lift = e => {
    if (!pointers.has(e.pointerId)) return
    const note = pointers.get(e.pointerId)
    pointers.delete(e.pointerId)
    if (note !== null) release(note)
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

  let width
  new ResizeObserver(() => {
    if (el.clientWidth === width) return
    width = el.clientWidth
    render()
  }).observe(el)

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
      pointers.forEach(note => note !== null && release(note))
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
