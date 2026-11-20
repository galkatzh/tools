/**
 * Scripted instruments: on-screen instruments of your own, written in HTML, CSS and JavaScript and
 * played where the piano keys are. Jam comes with templates; yours are kept in this browser's
 * IndexedDB and never leave it. As with the piano, only the notes they play travel.
 *
 * An instrument runs in a sandboxed frame (sandbox="allow-scripts", and never allow-same-origin,
 * which would undo the sandbox). Its origin is opaque, so it can't reach this page, its storage or
 * that of the other tools on this site: pasting someone's instrument risks nothing here. It plays
 * through the `jam` object api() gives it, whose messages are checked here like a peer's.
 */

const TEMPLATES = { // name → file in instruments/
  Omnichord: 'omnichord', Guitar: 'guitar', 'Harmonic table': 'harmonic-table', 'XY pad': 'xy-pad', Sequencer: 'sequencer',
}
const STARTER = 'new' // where a new instrument starts from

/** Every instrument's base: Jam's colors (--me is the player's own), and no scrolling, selecting or zooming. */
const CSS = `
:root { color-scheme: dark; --bg: #0b0b10; --panel: #191922; --line: #2b2b38; --text: #e9e9f1; --dim: #8b8ba0; --accent: #8aa4ff }
*, *::before, *::after { box-sizing: border-box }
html, body { height: 100%; margin: 0; overflow: hidden }
body { background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, sans-serif; touch-action: none;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent }
button, select, input { font: inherit; color: inherit }`

/** The `jam` object an instrument plays through. Its source is inlined into the frame, ahead of the instrument. */
function api() {
  const post = (...msg) => parent.postMessage(msg, '*') // the frame has no origin to name
  window.jam = {
    noteOn: (note, velocity = 0.8) => post('on', note, velocity),
    noteOff: note => post('off', note),
    pedal: down => post('pedal', down),
    set: (param, value) => post('set', param, value),
    onbeat: null,
  }
  addEventListener('message', e => e.source === parent && e.data[0] === 'beat' && jam.onbeat?.(e.data[1]))
  addEventListener('error', e => post('error', e.message, e.lineno))
  addEventListener('unhandledrejection', e => post('error', `Uncaught (in promise) ${e.reason?.stack ?? e.reason}`))
  // Keys the instrument leaves alone (no preventDefault) go on to the page: the piano's, Space for
  // sustain, Escape. Checked once every listener has had its say; text fields keep their keys.
  const TYPING = 'input:not([type=range], [type=checkbox], [type=radio], [type=button]), textarea, [contenteditable]'
  for (const type of ['keydown', 'keyup']) addEventListener(type, e => setTimeout(() => {
    if (e.defaultPrevented || e.target.closest?.(TYPING)) return
    const { code, key, repeat, ctrlKey, metaKey, altKey, shiftKey } = e
    post('key', type, { code, key, repeat, ctrlKey, metaKey, altKey, shiftKey })
  }))
  addEventListener('blur', () => post('blur')) // the page lets go of the keys it was given
}

const db = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('jam', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('instruments', { keyPath: 'name' })
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

/**
 * @param {{select: HTMLSelectElement, edit: HTMLButtonElement, add: HTMLButtonElement, keys: HTMLElement,
 *   stage: HTMLElement, editor: HTMLElement}} els
 *   the instrument picker and its Edit and New buttons, the piano, where instruments play, and the code editor
 * @param {{press(note: number, vel: number): void, release(note: number): void, pedal(source: string, down: boolean): void,
 *   set(param: string, value: any): void, color: string, toast(text: string, color?: string): void,
 *   load(key: string): any, save(key: string, value: any): void, onShow(custom: boolean): void, onEdit(): void}} handlers
 *   how an instrument plays (the piano's own press, release and pedal), the player's color, and the app's helpers
 */
export function createInstruments({ select, edit, add, keys, stage, editor }, handlers) {
  const { press, release, pedal, set, color, toast, load, save, onShow, onEdit } = handlers
  const [name, code, run, remove, close, problem] =
    ['#inst-name', '#inst-code', '#inst-run', '#inst-delete', '#inst-close', '#inst-error'].map(s => editor.querySelector(s))
  const mine = new Map() // your instruments: name → code
  const templates = new Map() // file → promise of its code
  const held = new Map() // note → how many times the instrument holds it
  let current = '' // what plays: '' (the piano), 'template:<name>' or 'mine:<name>'
  let frame = null, lineOffset = 0 // the instrument's frame, and the lines Jam put ahead of its code
  let editing = null, saved = '' // your instrument the editor saves over (null: a new one), and the draft as last saved
  const opened = db()

  /** Runs fn on the instruments' store in one transaction; resolves to its request's result once committed. */
  async function store(mode, fn) {
    const tx = (await opened).transaction('instruments', mode)
    const req = fn(tx.objectStore('instruments'))
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req?.result)
      tx.onerror = tx.onabort = () => reject(tx.error)
    })
  }

  /** Reports a failure in the console, in a toast and, while it is open, in the editor. */
  function fail(text, err) {
    console.error(text, err ?? '')
    toast(text, 'var(--danger)')
    problem.textContent = text
  }

  const nameOf = value => value.slice(value.indexOf(':') + 1)
  function template(file) {
    if (!templates.has(file)) templates.set(file, fetch(new URL(`instruments/${file}.html`, import.meta.url)).then(r => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      return r.text()
    }).catch(err => {
      templates.delete(file) // try again next time
      throw err
    }))
    return templates.get(file)
  }
  const codeOf = value => value.startsWith('mine:') ? mine.get(nameOf(value)) : template(TEMPLATES[nameOf(value)])

  // ── The stage ──

  /** Starts an instrument in a fresh frame: the old one, with any message still on its way from it, is gone. */
  function start(source, title) {
    stop()
    const head = `<!doctype html><html style="--me: ${color}"><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style><script>(${api})()</script>`
    lineOffset = head.split('\n').length - 1 // the instrument's first line shares the head's last
    frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.title = title
    frame.srcdoc = head + source
    stage.replaceChildren(frame)
  }

  function stop() {
    releaseAll()
    frame?.remove()
    frame = null
  }

  /** Lets go of every note and the pedal the instrument holds (a later noteOff for one is ignored). */
  function releaseAll() {
    for (const [note, n] of held) for (let i = 0; i < n; i++) release(note)
    held.clear()
    pedal('instrument', false)
  }

  /** What an instrument may say. Anything else, or out of range, is reported: the instrument is being written. */
  const said = {
    on(note, velocity) {
      if (!Number.isInteger(note) || note < 0 || note > 127) throw new Error(`a note is a whole number 0–127, not ${note}`)
      if (!Number.isFinite(velocity)) throw new Error(`a velocity is a number 0–1, not ${velocity}`)
      held.set(note, (held.get(note) ?? 0) + 1)
      press(note, Math.min(1, Math.max(0, velocity)))
    },
    off(note) {
      const n = held.get(note)
      if (!n) return // never started, or let go of already (when the page was hidden)
      if (n > 1) held.set(note, n - 1)
      else held.delete(note)
      release(note)
    },
    pedal: down => pedal('instrument', !!down),
    set,
    // Synthetic events are untrusted: they reach the page's own handlers and nothing else
    key: (type, init) => /^key(down|up)$/.test(type) && dispatchEvent(new KeyboardEvent(type, init)),
    blur: () => dispatchEvent(new Event('blur')),
    error(message, line) {
      throw new Error(line > lineOffset ? `line ${line - lineOffset}: ${message}` : message)
    },
  }

  addEventListener('message', e => {
    if (!frame || e.source !== frame.contentWindow) return
    const [type, ...args] = Array.isArray(e.data) ? e.data : []
    try {
      if (!Object.hasOwn(said, type)) throw new Error(`Jam doesn't know “${type}”`)
      said[type](...args)
    } catch (err) {
      fail(`${frame.title}: ${err.message}`, err)
    }
  })

  // ── The picker ──

  /** Lists the piano, the templates and yours. */
  function list() {
    const group = (label, prefix, names) => {
      const g = document.createElement('optgroup')
      g.label = label
      g.append(...names.map(n => new Option(n, prefix + n)))
      return g
    }
    select.replaceChildren(new Option('Piano', ''), group('Templates', 'template:', Object.keys(TEMPLATES)))
    if (mine.size) select.append(group('Yours', 'mine:', [...mine.keys()].sort((a, b) => a.localeCompare(b))))
    select.value = current
  }

  /** The picker is locked while the editor is open; there is no piano code to edit. */
  function lock() {
    select.disabled = add.disabled = !editor.hidden
    edit.disabled = !editor.hidden || !current
  }

  /** Plays an instrument (value as in the picker), or the piano. */
  async function choose(value) {
    stop()
    current = select.value = value
    save('instrument', value)
    lock()
    keys.hidden = !!value
    stage.hidden = !value
    onShow(!!value)
    if (!value) return
    try {
      const source = await codeOf(value)
      if (current === value) start(source, nameOf(value))
    } catch (err) {
      fail(`Could not load ${nameOf(value)}: ${err.message}`, err)
      if (current === value) choose('')
    }
  }
  select.onchange = () => choose(select.value)

  // ── The editor ──

  const draft = () => `${name.value}\n${code.value}`

  function open(source, title, own) {
    editing = own
    name.value = title
    code.value = source
    saved = draft()
    problem.textContent = ''
    remove.hidden = !own
    editor.hidden = false
    lock()
    onEdit()
    code.scrollTop = 0 // not focused: a phone's keyboard would cover the instrument
  }

  function shut() {
    editor.hidden = true
    editing = null
    lock()
  }

  /** Saves the draft as yours (renaming it, if the name changed) and plays it. */
  async function commit() {
    const title = name.value.trim()
    if (!title) {
      problem.textContent = 'Name your instrument'
      return name.focus()
    }
    if (title !== editing && mine.has(title) && !confirm(`Replace your “${title}”?`)) return
    const source = code.value
    await store('readwrite', s => {
      if (editing && editing !== title) s.delete(editing)
      s.put({ name: title, code: source })
    })
    mine.delete(editing)
    mine.set(title, source)
    editing = title
    saved = draft()
    problem.textContent = ''
    remove.hidden = false
    list()
    await choose(`mine:${title}`)
  }

  edit.onclick = async () => {
    const value = current
    try {
      open(await codeOf(value), nameOf(value), value.startsWith('mine:') ? nameOf(value) : null)
    } catch (err) {
      fail(`Could not load ${nameOf(value)}: ${err.message}`, err)
    }
  }
  add.onclick = async () => {
    let title = 'My instrument'
    for (let i = 2; mine.has(title); i++) title = `My instrument ${i}`
    try {
      open(await template(STARTER), title, null)
    } catch (err) {
      fail(`Could not load the starter: ${err.message}`, err)
    }
  }
  run.onclick = () => commit().catch(err => fail(`Could not save: ${err.message}`, err))
  remove.onclick = async () => {
    if (!confirm(`Delete “${editing}”? This can't be undone.`)) return
    try {
      await store('readwrite', s => s.delete(editing))
      mine.delete(editing)
      shut()
      list()
      choose('')
    } catch (err) {
      fail(`Could not delete: ${err.message}`, err)
    }
  }
  close.onclick = () => (draft() === saved || confirm('Close without saving your changes?')) && shut()
  editor.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's')) {
      e.preventDefault()
      run.click()
    }
  })
  code.addEventListener('keydown', e => { // Tab indents (Shift+Tab still leaves)
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    // insertText keeps undo working; setRangeText for a browser without it
    if (!document.execCommand('insertText', false, '  ')) code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end')
  })

  // Yours load from IndexedDB, then the instrument played last comes back
  list()
  lock()
  store('readonly', s => s.getAll()).then(all => {
    for (const { name, code } of all) mine.set(name, code)
  }, err => fail(`Could not read your instruments: ${err.message}`, err)).finally(() => {
    list()
    select.value = load('instrument') ?? ''
    choose(select.value) // the piano if it's gone
  })

  return {
    releaseAll,
    /** Tells the instrument of a beat `inMs` from now, at that moment. */
    beat(info, inMs) {
      const f = frame
      if (f) setTimeout(() => f === frame && f.contentWindow.postMessage(['beat', info], '*'), inMs)
    },
  }
}
