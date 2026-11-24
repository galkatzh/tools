// Card Table's rules Worker (spec §3f): a host's rules script runs here,
// away from the page — never on it. The host spawns one per enabled script
// (app.js startWorker) and sends it, once, a copy of its whole state but the
// seat keys (`init`); this module builds a core.js table over that copy (the
// MIRROR), evaluates the script, and then runs every state-changing job the
// host's queue hands it (`act`), one at a time, in order: each job's
// StatePatch goes back (`done`), and the host applies it (applyStatePatch).
// The mirror is the only writer while the rules are on, so it and the host's
// state agree by construction (T.digest proves it: `digest`).
//
//   host → Worker  {type: 'init', proto, mv, hostId, code, globals, state, decks, boxes, boxSrc, now}
//                  {type: 'act', id, p, a, now}     {type: 'digest', id}
//   Worker → host  {type: 'ready', name, wants, strict}   {type: 'evalError', message}
//                  {type: 'done', id, patch, out, ms}      {type: 'digest', id, digest}
//                  {type: 'fatal', message, engine, detail?}  (an uncaught error, or the script broke a rule between
//                   jobs: `engine` when `message` is the engine's own fixed words, never the script's — `detail`, what
//                   only the host is told, may name the script's own keys)
//
// Before it evaluates anything, the Worker takes away what a rules script has
// no business with (spec §3f.7: defence in depth, not a sandbox — a script
// sees every hidden card and is trusted as such): every global but the
// language's and a reviewed few (the network, storage, other Workers and
// channels, its own postMessage, devices, the site's service workers…); close,
// the timers and queueMicrotask throw, pointing at t.schedule; the page APIs a
// script written for the page may still touch (document, alert, localStorage,
// sessionStorage) throw saying the rules now run here. It then freezes the
// built-ins the engine shares with the script (the lockdown, D145). Only the
// host's own messages are read (isTrusted): a script can't hand its Worker a job. Hooks
// must be synchronous: a facade call from a stray continuation throws
// (scriptHooks), and once every microtask a job queued has run (drain), the
// rules' state must be as the job committed it (T.guard), or the Worker
// reports it — `fatal`, and the host disables the rules.
import { MODULE_V as CORE_V, PROTO, createTable, scriptHooks, trimLog } from './core.js?v=1';

/** This file's code version (see core.js MODULE_V): the host sends its own in `init`. */
export const MODULE_V = 1;

// What the Worker keeps for itself, taken before anything is removed or
// evaluated. A message's data is read with the getter and the call taken
// here; the engine (core.js) runs on this realm's built-ins, which the
// lockdown below freezes before any script runs — and what it writes is
// checked again on the host, in the host's realm (applyStatePatch).
const post = self.postMessage.bind(self);
const later = self.setTimeout.bind(self); // drain()'s real timer
const clock = performance.now.bind(performance);
const call = Reflect.apply;
const dataOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
const Prom = Promise;

/** Reports a failure outside the job protocol to the host, which disables
 *  the rules. `message`: what the host shows its own player (the toast, the
 *  rules dialog); `o.engine`: it is the engine's own fixed text (a broken
 *  rule of running, never the script's words, nor a key of its state), which
 *  the public log may carry too; `o.detail`: more for the host alone (which
 *  value, under which of the script's keys); `o.err`, if any, is logged here
 *  whole, its stack included. */
function fatal(message, o = {}) {
  console.error(`rules Worker: ${message}${o.detail ? ` (${o.detail})` : ''}`, ...(o.err ? [o.err] : []));
  post({ type: 'fatal', message: String(message).slice(0, 500), engine: !!o.engine, ...(o.detail && { detail: String(o.detail).slice(0, 500) }) });
}
const msgOf = (err) => String(err?.message ?? err ?? 'an error'); // (a message, never a stack: the host shows it to a person)
// The Worker's own listeners come first, in the capture phase: a script's
// listener can't stop them (stopImmediatePropagation), nor reach them.
self.addEventListener('error', (e) => { e.preventDefault(); fatal(msgOf(e.error ?? e.message), { err: e.error }); }, true);
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fatal(msgOf(e.reason), { err: e.reason }); }, true);
self.addEventListener('messageerror', () => fatal('a message from the host could not be read', { engine: true }), true);

// Messages run one at a time, in order (a job awaits its drain before the
// next starts). Only the host's are taken: a MessageEvent a script makes and
// dispatches to its own Worker is not trusted (isTrusted can't be forged),
// and would run a job the host never asked for — the Worker reports it.
let chain = Prom.resolve();
self.addEventListener('message', (e) => {
  if (!e.isTrusted) { fatal('the script dispatched a message to its own Worker', { engine: true }); return; }
  const m = call(dataOf, e, []);
  chain = chain.then(() => handle(m)).catch((err) => fatal(msgOf(err), { err }));
}, true);

// --- hardening (spec §3f.7) ----------------------------------------------------
// An allowlist, not a list of what goes: every name on the global scope (and
// on its prototypes) that isn't the language's (BUILTINS) or one of the few
// platform ones reviewed here (PLATFORM) is taken away — the network, storage
// (OPFS, storage buckets, Web Locks and the site's service workers are
// origin-wide, shared with every page of the site), other Workers and
// channels, its own postMessage, notifications, devices, a real timer
// (scheduler), and whatever a browser adds next.
/** The language's built-ins (those a browser has), and the platform objects the engine calls (console, crypto, structuredClone). */
const BUILTINS = ['Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Promise', 'Proxy', 'Reflect', 'JSON', 'Math',
  'Intl', 'Atomics', 'Temporal', 'WebAssembly', 'Iterator', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'DisposableStack', 'AsyncDisposableStack',
  'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'SuppressedError',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape', 'unescape', 'console', 'crypto', 'structuredClone',
  'Event', 'EventTarget', 'MessageEvent'].filter((k) => k in self);
/** The platform names a script may still use: none reaches outside the Worker. */
const PLATFORM = ['globalThis', 'self', 'undefined', 'NaN', 'Infinity', 'constructor', 'location', 'origin', 'name', 'isSecureContext', 'crossOriginIsolated',
  'performance', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'atob', 'btoa', 'DOMException', 'AbortController', 'AbortSignal', 'ErrorEvent',
  'PromiseRejectionEvent', 'TEMPORARY', 'PERSISTENT' /* (Chromium's file-system constants: numbers, not deletable) */, 'addEventListener', 'removeEventListener', 'dispatchEvent', 'onmessage', 'onmessageerror', 'onerror', 'onunhandledrejection', 'onrejectionhandled'];
const nav = navigator, NAV = Object.freeze({ userAgent: nav.userAgent, language: nav.language, languages: Object.freeze([...nav.languages]), hardwareConcurrency: nav.hardwareConcurrency, onLine: nav.onLine });
{
  const keep = new Set([...BUILTINS, ...PLATFORM]);
  for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (keep.has(k)) continue;
      try { delete o[k]; } catch (err) { console.error(`rules Worker: could not take ${k} away`, err); } // (D131: said, and the Worker goes on)
    }
  }
}
/** A timer `k` a script might reach for, as a stub that says what to use instead. */
const stub = (k) => () => { throw new Error(`${k} is not available to rules scripts — use t.schedule(seconds, tag)`); };
/** The timers: the script's own parameters (scriptHooks) and the global ones alike. */
const STUBS = Object.fromEntries(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame'].map((k) => [k, stub(k)]));
/** What the global scope gets back (each fixed: neither writable nor configurable). */
const DEFS = {
  ...Object.fromEntries(Object.entries(STUBS).map(([k, f]) => [k, { value: f }])),
  scheduler: { value: Object.freeze({ postTask: stub('scheduler.postTask'), yield: stub('scheduler.yield') }) },
  // close() would end the Worker without a word (the host would wait out the watchdog).
  close: { value: () => { throw new Error('close is not available to rules scripts'); } },
  navigator: { value: NAV }, // (what a script may want to know of the browser, and nothing it can call)
  window: { value: self }, // (window.CAH_CARDS and friends: the globals `init` brings)
  // Page APIs a saved script written for the page may touch: any use of one
  // says why it is gone. (A value, never a getter that throws: WebKit's
  // inspector reads `document` off the global scope, and a throw there
  // takes the page down.)
  ...Object.fromEntries(['document', 'alert', 'localStorage', 'sessionStorage'].map((k) => {
    const gone = () => { throw new Error(`${k} is not available: rules now run in a Worker, away from the page (see ENGINE.md, 'Running in a Worker')`); };
    return [k, { value: new Proxy(gone, { get: gone, set: gone, apply: gone }) }];
  })),
};
for (const [k, d] of Object.entries(DEFS)) {
  try { Object.defineProperty(self, k, d); } catch (err) { console.error(`rules Worker: could not define ${k}`, err); }
}

// The lockdown: a script shares this realm with the engine (core.js), so a
// built-in it replaced (Array.prototype.push, Function.prototype.call,
// Object.entries, an Object.prototype getter or setter, an iterator's next)
// would rewrite what the engine writes — a log line, a player, the patch
// itself. Before any script runs, every built-in is frozen, all the way
// down (the prototypes the syntax reaches too: iterators, generators), and
// the global names that hold them can't be rebound. The methods a script
// commonly assigns on its own objects (toString, constructor, an error's
// name and message, a function's call) become accessors that define the
// script's own property — the override mistake, worked around as SES does.
// The host checks every patch again all the same (applyStatePatch).
const ERRORS = ['Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'SuppressedError'].filter((k) => k in self);
/** [object, keys]: data properties a script may still set on its own objects that inherit them. */
const OVERRIDABLE = [
  [Object.prototype, ['constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable']],
  [Function.prototype, ['constructor', 'toString', 'call', 'apply', 'bind']],
  [Array.prototype, ['toString', 'toLocaleString']],
  [Promise.prototype, ['constructor']],
  ...ERRORS.map((k) => [self[k].prototype, ['constructor', 'name', 'message', 'toString']]),
];
/** Turns data property `k` of `o` into an accessor that reads as before
 *  and, set on an object that inherits it, defines that object's own. */
function overridable(o, k) {
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (!d || !('value' in d) || !d.configurable) return;
  const { value } = d;
  Object.defineProperty(o, k, {
    get() { return value; },
    set(v) {
      if (this === o) throw new TypeError(`${String(k)} is a built-in's: it can't be changed`);
      Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true });
    },
    enumerable: d.enumerable, configurable: true,
  });
}
/** Freezes `roots` and everything reachable from them: prototypes, property
 *  values, getters and setters (never called). */
function harden(roots) {
  const todo = [...roots], seen = new Set();
  while (todo.length) {
    const o = todo.pop();
    if (o === null || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o)) continue;
    seen.add(o);
    try { Object.freeze(o); } catch (err) { console.error('rules Worker: could not freeze a built-in', o, err); }
    todo.push(Object.getPrototypeOf(o));
    for (const k of Reflect.ownKeys(o)) {
      const d = Reflect.getOwnPropertyDescriptor(o, k);
      todo.push(d.value, d.get, d.set);
    }
  }
}
{
  for (const [o, keys] of OVERRIDABLE) for (const k of keys) overridable(o, k);
  // the built-ins the syntax reaches without a global name: iterators (for…of,
  // spread), generators (the engine's own function*), async functions, %TypedArray%
  const hidden = [function* () {}, async function () {}, async function* () {}, (async function* () {})(), [].values(), new Map().values(), new Set().values(),
    ''[Symbol.iterator](), /x/g[Symbol.matchAll](''), Object.getPrototypeOf(Int8Array), globalThis.Iterator?.from?.({ next: () => ({ done: true }) }), [].values().map?.((x) => x)];
  harden([...BUILTINS.map((k) => self[k]), ...hidden]);
  for (const k of BUILTINS) { // (a name the engine reads can't be bound to something else)
    try { Object.defineProperty(self, k, { value: self[k], writable: false, configurable: false }); } catch (err) { console.error(`rules Worker: could not pin ${k}`, err); }
  }
}

// --- the protocol ------------------------------------------------------------
let T = null, hooks = null;
let now = 0; // the table's clock: the current message's `now` (the host's)

/** One message from the host (see the top of this file). */
async function handle(m) {
  if (m?.type === 'init') return init(m);
  if (!T) throw new Error(`${m?.type} before init`);
  if (m.type === 'digest') return post({ type: 'digest', id: m.id, digest: T.digest() });
  if (m.type !== 'act') throw new Error(`unknown message ${m?.type}`);
  now = m.now;
  const t0 = clock(), r = T.job(m.p, m.a);
  if (r.fatal) return fatal(r.fatal, { engine: true, detail: r.detail });
  // drain(): every microtask the job's hooks queued runs before this timer;
  // one that called the facade, or wrote t.data, broke "hooks are synchronous".
  await new Prom((res) => later(res, 0));
  const broke = T.guard();
  if (broke) return fatal(broke.why, { engine: true, detail: broke.detail });
  send(m.id, r, clock() - t0);
}

/** `init`: checks the versions, builds the mirror, evaluates the script. */
function init(m) {
  if (T) throw new Error('init twice');
  if (m.proto !== PROTO || m.mv !== MODULE_V || CORE_V !== MODULE_V) {
    console.error(`rules Worker: version mismatch (host wire ${m.proto}, modules v${m.mv}; here wire ${PROTO}, rules-worker v${MODULE_V}, core v${CORE_V})`);
    return post({ type: 'evalError', message: 'version mismatch — reload this page' });
  }
  Object.assign(self, m.globals);
  hooks = scriptHooks(STUBS);
  let name;
  try { name = hooks.load(m.code); } catch (err) {
    console.error('rules script failed to load', err);
    return post({ type: 'evalError', message: msgOf(err) });
  }
  // The Enable's setRules job, next, loads the same code: it was evaluated
  // just now, under the start's budget — once is enough (a fresh Worker per
  // Enable, so the script object is fresh too).
  const load = hooks.load;
  hooks.load = (code) => (code === m.code ? name : load(code));
  now = m.now;
  T = createTable({ ...m.state, decks: m.decks, boxes: m.boxes, boxSrc: m.boxSrc }, { pid: m.hostId, now: () => now, hooks, mirror: true }); // (mirror: equal to the host's, hints and all)
  post({ type: 'ready', name, wants: hooks.has('onSelect') ? ['select'] : [], strict: hooks.flag('strict') === true });
}

/** Posts job `id`'s result (T.job's `r`; `ms`: its time here). A patch the
 *  host can't be sent (DataCloneError: t.data or t.public holds a function,
 *  which JSON skips — D129) is the script's failure, as a save that can't
 *  copy them was on the page: the rules disable, keeping the JSON part of
 *  the rules' state (core.js unsaveable), all in this one done. */
function send(id, r, ms) {
  try {
    post({ type: 'done', id, patch: r.patch, out: r.out, ms });
    return;
  } catch (err) {
    if (err?.name !== 'DataCloneError') throw err;
    console.error('rules: the job\'s patch could not be sent', err);
    T.begin();
    T.unsaveable(err.message);
    const p = T.commit(), { data, public: pub, secret } = T.state.rules, why = T.rulesError, k = why.indexOf(': ');
    post({
      type: 'done', id, ms,
      patch: { ...r.patch, ...p, rules: { ...r.patch.rules, ...p.rules, data, public: pub, secret }, log: trimLog([...(r.patch.log || []), ...(p.log || [])]) }, // (no more than the log keeps: the host refuses more)
      out: { effects: [...r.out.effects, ...T.drain()], error: { hook: why.slice(0, k), message: why.slice(k + 2) } },
    });
  }
}
