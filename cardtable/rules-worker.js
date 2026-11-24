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
//                  {type: 'fatal', message}  (an uncaught error, or the script broke a rule between jobs)
//
// Before it evaluates anything, the Worker takes away what a rules script has
// no business with (spec §3f.7: defence in depth, not a sandbox — a script
// sees every hidden card and is trusted as such): the network, storage, other
// Workers and channels, its own postMessage; the timers and queueMicrotask
// throw, pointing at t.schedule; and the page APIs a script written for the
// page may still touch (document, alert, localStorage, sessionStorage) throw
// saying the rules now run here. Hooks must be synchronous: a facade call from
// a stray continuation throws (scriptHooks), and once every microtask a job
// queued has run (drain), the rules' state must be as the job committed it
// (T.guard), or the Worker reports it — `fatal`, and the host disables the rules.
import { MODULE_V as CORE_V, PROTO, createTable, scriptHooks } from './core.js?v=1';

/** This file's code version (see core.js MODULE_V): the host sends its own in `init`. */
export const MODULE_V = 1;

// What the Worker keeps for itself, taken before anything is removed.
const post = self.postMessage.bind(self);
const later = self.setTimeout.bind(self); // drain()'s real timer
const clock = performance.now.bind(performance);

/** Reports a failure outside the job protocol to the host, which disables the rules. */
function fatal(message) {
  console.error(`rules Worker: ${message}`);
  post({ type: 'fatal', message: String(message).slice(0, 500) });
}
self.addEventListener('error', (e) => { e.preventDefault(); fatal(e.error?.message || e.message || 'an error'); });
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fatal(e.reason?.message || String(e.reason)); });
self.addEventListener('messageerror', () => fatal('a message from the host could not be read'));

// Messages run one at a time, in order (a job awaits its drain before the next starts).
let chain = Promise.resolve();
self.addEventListener('message', (e) => {
  chain = chain.then(() => handle(e.data)).catch((err) => fatal(err?.stack || err?.message || String(err)));
});

// --- hardening (spec §3f.7) ----------------------------------------------------
/** Takes global `k` away — deleted from the global scope and from every
 *  prototype that has it (a script calling it then gets "k is not
 *  defined") — and, given `desc`, defines it anew on the global scope. A
 *  browser that refuses is said in the console: this is defence in depth,
 *  and the rules must still run there. */
function takeAway(k, desc) {
  try {
    for (let o = self; o; o = Object.getPrototypeOf(o)) if (Object.hasOwn(o, k)) delete o[k];
    if (desc) Object.defineProperty(self, k, desc);
  } catch (err) { console.error(`rules Worker: could not take ${k} away`, err); }
  if (!desc && k in self) console.error(`rules Worker: ${k} is still there`);
}
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker',
  'BroadcastChannel', 'MessageChannel', 'indexedDB', 'caches', 'WebTransport', 'postMessage']) takeAway(k);
/** The timers a script might reach for, as stubs that say what to use instead:
 *  the script's own parameters (scriptHooks) and the global ones alike. */
const STUBS = Object.fromEntries(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame'].map((k) => [k, () => {
  throw new Error(`${k} is not available to rules scripts — use t.schedule(seconds, tag)`);
}]));
for (const [k, f] of Object.entries(STUBS)) takeAway(k, { value: f });
// Page APIs a saved script written for the page may touch: say why they are gone.
for (const k of ['document', 'alert', 'localStorage', 'sessionStorage']) {
  takeAway(k, { get() { throw new Error(`${k} is not available: rules now run in a Worker, away from the page (see ENGINE.md, 'Running in a Worker')`); } });
}
self.window = self; // (window.CAH_CARDS and friends: the globals `init` brings)

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
  if (r.fatal) return fatal(r.fatal);
  // drain(): every microtask the job's hooks queued runs before this timer;
  // one that called the facade, or wrote t.data, broke "hooks are synchronous".
  await new Promise((res) => later(res, 0));
  const why = T.guard();
  if (why) return fatal(why);
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
    return post({ type: 'evalError', message: err?.message || String(err) });
  }
  now = m.now;
  T = createTable({ ...m.state, decks: m.decks, boxes: m.boxes, boxSrc: m.boxSrc }, { pid: m.hostId, now: () => now, hooks });
  post({ type: 'ready', name, wants: hooks.has('onSelect') ? ['select'] : [], strict: hooks.flag('strict') === true });
}

/** Posts job `id`'s result (T.job's `r`; `ms`: its time here). A patch the
 *  host can't be sent (DataCloneError: t.data or t.public holds a function,
 *  which JSON — and so the engine's gates — skips) is the script's failure,
 *  as a save that can't copy them was on the page: the rules disable,
 *  keeping the JSON part of both (core.js unsaveable), all in this one done. */
function send(id, r, ms) {
  try {
    post({ type: 'done', id, patch: r.patch, out: r.out, ms });
    return;
  } catch (err) {
    if (err?.name !== 'DataCloneError') throw err;
    console.error('rules: the job\'s patch could not be sent', err);
    T.begin();
    T.unsaveable(err.message);
    const p = T.commit(), { data, public: pub } = T.state.rules, why = T.rulesError, k = why.indexOf(': ');
    post({
      type: 'done', id, ms,
      patch: { ...r.patch, ...p, rules: { ...r.patch.rules, ...p.rules, data, public: pub }, log: [...(r.patch.log || []), ...(p.log || [])] },
      out: { effects: [...r.out.effects, ...T.drain()], error: { hook: why.slice(0, k), message: why.slice(k + 2) } },
    });
  }
}
