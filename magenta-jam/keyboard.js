/**
 * keyboard.js — an on-screen + computer-keyboard piano widget.
 *
 * Renders a row of white keys with black keys overlaid between them,
 * and exposes a small imperative API (`noteOn`/`noteOff`) that callers
 * (app.js) hook up to the audio/model layer.
 *
 * Input is handled two ways:
 *   1. Pointer Events (mouse, touch, pen) directly on the rendered keys,
 *      supporting multi-touch chords and glissando (dragging across keys).
 *   2. The physical computer keyboard, mapped like a one-octave-plus-one
 *      musical typing keyboard (A W S E D F T G Y H U J K), with Z/X to
 *      shift which octave that mapping starts at.
 */

// Pitch classes (semitones from C) of the seven white keys, in order.
const WHITE_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
// Semitone distance from each white key above to the *next* white key.
// A distance of 1 (E->F, B->C) means there is no black key between them.
const WHITE_STEPS = [2, 2, 1, 2, 2, 2, 1];

// Black keys occupy this fraction of a white key's width, centered on the
// boundary between the two white keys that flank them.
const BLACK_WIDTH_FRAC = 0.6;
// Minimum rendered width of a white key, in px. Must match the `.key.white`
// flex-basis in style.css — see the comment on `.keys-track` there for why.
const MIN_WHITE_PX = 44;

// event.code -> semitone offset from the current `baseOctaveNote`, for the
// "musical typing keyboard" row A..K (13 semitones, C up to the next C).
const KEY_OFFSETS = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12,
};
// Reverse of KEY_OFFSETS, for labelling keys with their computer-key letter.
const OFFSET_TO_LETTER = Object.fromEntries(
  Object.entries(KEY_OFFSETS).map(([code, offset]) => [offset, code.slice(3)])
);

/** True if `target` is a form field that should swallow keyboard shortcuts. */
function isFormField(target) {
  if (!(target instanceof Element)) return false;
  return target.matches('input, textarea, select') || target.isContentEditable;
}

export class Keyboard {
  /**
   * @param {Element} container - element to render the keyboard into.
   * @param {object} opts
   * @param {(pitch: number) => void} opts.onNoteOn - called on a real note-on transition.
   * @param {(pitch: number) => void} opts.onNoteOff - called on a real note-off transition.
   * @param {number} [opts.lowNote=48] - MIDI pitch of the first (leftmost) white key. Must be a white key (e.g. any C).
   * @param {number} [opts.numWhite=15] - number of white keys to render.
   * @param {number} [opts.baseOctaveNote=48] - MIDI pitch that computer key "A" currently plays.
   */
  constructor(container, { onNoteOn, onNoteOff, lowNote = 48, numWhite = 15, baseOctaveNote = 48 } = {}) {
    if (!(container instanceof Element)) {
      throw new TypeError('Keyboard: container must be a DOM Element');
    }
    if (typeof onNoteOn !== 'function' || typeof onNoteOff !== 'function') {
      throw new TypeError('Keyboard: onNoteOn and onNoteOff callbacks are required');
    }
    if (!Number.isInteger(lowNote)) throw new TypeError('Keyboard: lowNote must be an integer MIDI pitch');
    if (!Number.isInteger(numWhite) || numWhite < 8) {
      throw new RangeError('Keyboard: numWhite must be an integer >= 8');
    }
    if (!Number.isInteger(baseOctaveNote)) {
      throw new TypeError('Keyboard: baseOctaveNote must be an integer MIDI pitch');
    }

    this.container = container;
    this.onNoteOn = onNoteOn;
    this.onNoteOff = onNoteOff;
    this.lowNote = lowNote;

    /** @type {Set<number>} currently sounding pitches */
    this._active = new Set();
    /** @type {Map<number, Element>} pitch -> key element, for fast lookup/labelling */
    this._keyEls = new Map();
    /** @type {Map<number, number>} pointerId -> pitch currently held by that pointer */
    this._pointerNotes = new Map();
    /** @type {Map<string, number>} event.code -> pitch that key press is sounding
     *  (captured at press time so an octave shift mid-hold still releases the right pitch) */
    this._kbdNotes = new Map();

    this._render(numWhite);

    if (baseOctaveNote < this.lowNote || baseOctaveNote + 12 > this.highNote) {
      throw new RangeError('Keyboard: baseOctaveNote + one octave must fit within the rendered range');
    }
    this._baseOctaveNote = baseOctaveNote;
    this._relabelKeys();

    // Bind once so the same reference can be removed in destroy().
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onVisibilityOrBlur = this.releaseAll.bind(this);

    this.container.addEventListener('pointerdown', this._onPointerDown);
    // move/up/cancel/lostpointercapture are attached to the container too: once
    // setPointerCapture() is called on it in _onPointerDown, the browser routes
    // all further events for that pointerId to the container regardless of
    // where the pointer physically is, which is exactly why _onPointerMove
    // below re-hit-tests with document.elementFromPoint instead of trusting
    // event.target.
    this.container.addEventListener('pointermove', this._onPointerMove);
    this.container.addEventListener('pointerup', this._onPointerUp);
    this.container.addEventListener('pointercancel', this._onPointerUp);
    this.container.addEventListener('lostpointercapture', this._onPointerUp);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    // Belt-and-suspenders against stuck notes: if the tab is hidden or the
    // window loses focus mid-note (alt-tab, phone lock, drag off-screen),
    // there may be no further pointerup/keyup to release it.
    document.addEventListener('visibilitychange', this._onVisibilityOrBlur);
    window.addEventListener('blur', this._onVisibilityOrBlur);
  }

  /** Compute the MIDI pitches of the white keys, walking the white-key step pattern from lowNote. */
  _computeWhiteNotes(lowNote, numWhite) {
    const pitchClass = ((lowNote % 12) + 12) % 12;
    const startIdx = WHITE_PITCH_CLASSES.indexOf(pitchClass);
    if (startIdx === -1) {
      throw new RangeError(`Keyboard: lowNote ${lowNote} is not a white key`);
    }
    const notes = [lowNote];
    let cur = lowNote;
    for (let i = 1, stepIdx = startIdx; i < numWhite; i++, stepIdx++) {
      cur += WHITE_STEPS[stepIdx % 7];
      notes.push(cur);
    }
    return notes;
  }

  _createKeyElement(note, isBlack) {
    const el = document.createElement('div');
    el.className = `key ${isBlack ? 'black' : 'white'}`;
    el.dataset.note = String(note);
    const label = document.createElement('span');
    label.className = 'label';
    el.appendChild(label);
    return el;
  }

  /**
   * Build the DOM: white keys flow left-to-right inside `.keys-track`, black
   * keys are absolutely positioned over the gaps between them.
   *
   * `.keys-track` (not `#keyboard` itself) is the flex row and the
   * positioning context for the black keys' percentage left/width, and its
   * width is forced to `max(100%, numWhite * MIN_WHITE_PX)`. That matters on
   * narrow screens: `#keyboard` scrolls horizontally when the keys don't
   * fit, but a plain flex container's own box stays at the *available*
   * width even while its children overflow it — so black-key percentages
   * computed against the container would drift from the white keys under
   * them. Forcing the track's width to the content's own min width (via the
   * same 44px used as each white key's flex-basis) keeps container width
   * and content width identical in both the "fits" and "scrolls" cases,
   * without any resize listener: `max()` recomputes on every reflow.
   */
  _render(numWhite) {
    this.container.textContent = '';
    this._keyEls.clear();

    const whiteNotes = this._computeWhiteNotes(this.lowNote, numWhite);
    this.highNote = whiteNotes[whiteNotes.length - 1];

    const track = document.createElement('div');
    track.className = 'keys-track';
    track.style.width = `max(100%, ${numWhite * MIN_WHITE_PX}px)`;
    this.container.appendChild(track);
    this._track = track;

    for (const note of whiteNotes) {
      const el = this._createKeyElement(note, false);
      track.appendChild(el);
      this._keyEls.set(note, el);
    }

    for (let i = 0; i < whiteNotes.length - 1; i++) {
      const gap = whiteNotes[i + 1] - whiteNotes[i];
      if (gap === 1) continue; // E-F or B-C: no black key in between
      if (gap !== 2) {
        // Should be unreachable given _computeWhiteNotes, but fail loudly rather
        // than silently drawing a malformed keyboard.
        throw new Error(`Keyboard: unexpected ${gap}-semitone gap between white keys`);
      }
      const note = whiteNotes[i] + 1;
      const el = this._createKeyElement(note, true);
      // The boundary between white key i and i+1 sits at (i+1)/numWhite of
      // the track's width; center the black key on it.
      const leftFrac = (i + 1 - BLACK_WIDTH_FRAC / 2) / numWhite;
      el.style.left = `${leftFrac * 100}%`;
      el.style.width = `${(BLACK_WIDTH_FRAC / numWhite) * 100}%`;
      track.appendChild(el);
      this._keyEls.set(note, el);
    }
  }

  /** Re-label every key: computer-key letter if mapped at the current octave, else "C<n>" for C keys, else blank. */
  _relabelKeys() {
    for (const [note, el] of this._keyEls) {
      const offset = note - this._baseOctaveNote;
      const letter = OFFSET_TO_LETTER[offset];
      let text = '';
      if (letter !== undefined) {
        text = letter;
      } else if (((note % 12) + 12) % 12 === 0) {
        text = `C${Math.floor(note / 12) - 1}`; // MIDI 60 = C4
      }
      el.querySelector('.label').textContent = text;
    }
  }

  /** Find the `.key` element (if any) under viewport coordinates (x, y). */
  _keyElementAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.key') : null;
  }

  _onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return; // ignore right/middle click
    const keyEl = event.target.closest('.key');
    if (!keyEl) return;
    event.preventDefault();
    // Capture so we keep receiving move/up events for this pointer even if it
    // leaves the container's bounds (common when dragging fast, or on touch
    // devices that otherwise stop sending events past the initial target).
    try {
      this.container.setPointerCapture(event.pointerId);
    } catch (err) {
      console.error('Keyboard: setPointerCapture failed', err);
    }
    const note = Number(keyEl.dataset.note);
    this._pointerNotes.set(event.pointerId, note);
    this.noteOn(note);
  }

  _onPointerMove(event) {
    if (!this._pointerNotes.has(event.pointerId)) return; // not one of our active pointers
    const prevNote = this._pointerNotes.get(event.pointerId);
    const keyEl = this._keyElementAt(event.clientX, event.clientY);
    const nextNote = keyEl && keyEl.parentElement === this._track ? Number(keyEl.dataset.note) : null;
    if (nextNote === prevNote) return;
    this.noteOff(prevNote);
    if (nextNote === null) {
      this._pointerNotes.delete(event.pointerId);
    } else {
      this._pointerNotes.set(event.pointerId, nextNote);
      this.noteOn(nextNote);
    }
  }

  _onPointerUp(event) {
    const note = this._pointerNotes.get(event.pointerId);
    if (note === undefined) return;
    this._pointerNotes.delete(event.pointerId);
    this.noteOff(note);
  }

  _onKeyDown(event) {
    if (event.repeat || isFormField(event.target)) return;
    if (event.code === 'KeyZ') { this._shiftOctave(-12); return; }
    if (event.code === 'KeyX') { this._shiftOctave(12); return; }
    const offset = KEY_OFFSETS[event.code];
    if (offset === undefined || this._kbdNotes.has(event.code)) return;
    const note = this._baseOctaveNote + offset;
    this._kbdNotes.set(event.code, note);
    this.noteOn(note);
  }

  _onKeyUp(event) {
    if (isFormField(event.target)) return;
    const note = this._kbdNotes.get(event.code);
    if (note === undefined) return;
    this._kbdNotes.delete(event.code);
    this.noteOff(note);
  }

  /** Shift baseOctaveNote by +-12 semitones, clamped to stay within the rendered range. */
  _shiftOctave(delta) {
    const next = this._baseOctaveNote + delta;
    if (next < this.lowNote || next + 12 > this.highNote) return; // at the edge: no-op
    this.setBaseOctaveNote(next);
  }

  /** Press `pitch`. No-op (and no callback) if it's already sounding. */
  noteOn(pitch) {
    if (!Number.isInteger(pitch)) throw new TypeError('Keyboard.noteOn: pitch must be an integer MIDI note');
    if (this._active.has(pitch)) return;
    this._active.add(pitch);
    const el = this._keyEls.get(pitch);
    if (el) el.classList.add('active');
    this.onNoteOn(pitch);
  }

  /** Release `pitch`. No-op (and no callback) if it isn't currently sounding. */
  noteOff(pitch) {
    if (!Number.isInteger(pitch)) throw new TypeError('Keyboard.noteOff: pitch must be an integer MIDI note');
    if (!this._active.has(pitch)) return;
    this._active.delete(pitch);
    const el = this._keyEls.get(pitch);
    if (el) el.classList.remove('active');
    this.onNoteOff(pitch);
  }

  /** Release every currently-sounding pitch (does not clear held-key tracking maps beyond that). */
  releaseAll() {
    for (const pitch of [...this._active]) this.noteOff(pitch);
  }

  /** Sorted array of currently-sounding MIDI pitches. */
  get activeNotes() {
    return [...this._active].sort((a, b) => a - b);
  }

  get baseOctaveNote() {
    return this._baseOctaveNote;
  }

  /** Move which pitch computer-key "A" plays. Throws if the resulting mapped range doesn't fit on the keyboard. */
  setBaseOctaveNote(n) {
    if (!Number.isInteger(n)) throw new TypeError('Keyboard.setBaseOctaveNote: n must be an integer MIDI note');
    if (n < this.lowNote || n + 12 > this.highNote) {
      throw new RangeError('Keyboard.setBaseOctaveNote: mapped range must fit within the rendered keyboard');
    }
    this._baseOctaveNote = n;
    this._relabelKeys();
  }

  /** Release all notes and remove every listener this instance attached. Safe to call once, at teardown. */
  destroy() {
    this.releaseAll();
    this.container.removeEventListener('pointerdown', this._onPointerDown);
    this.container.removeEventListener('pointermove', this._onPointerMove);
    this.container.removeEventListener('pointerup', this._onPointerUp);
    this.container.removeEventListener('pointercancel', this._onPointerUp);
    this.container.removeEventListener('lostpointercapture', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('visibilitychange', this._onVisibilityOrBlur);
    window.removeEventListener('blur', this._onVisibilityOrBlur);
  }
}
