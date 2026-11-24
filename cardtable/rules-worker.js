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
//                  {type: 'fatal', message, engine}  (an uncaught error, or the script broke a rule between jobs:
//                   `engine` when the message is the engine's own words, never the script's)
//
// Before it evaluates anything, the Worker takes away what a rules script has
// no business with (spec §3f.7: defence in depth, not a sandbox — a script
// sees every hidden card and is trusted as such): the network, storage, other
// Workers and channels, its own postMessage and close; the timers and
// queueMicrotask throw, pointing at t.schedule; and the page APIs a script
// written for the page may still touch (document, alert, localStorage,
// sessionStorage) throw saying the rules now run here. Only the host's own
// messages are read (isTrusted): a script can't hand its Worker a job. Hooks
// must be synchronous: a facade call from a stray continuation throws
// (scriptHooks), and once every microtask a job queued has run (drain), the
// rules' state must be as the job committed it (T.guard), or the Worker
// reports it — `fatal`, and the host disables the rules.
import { MODULE_V as CORE_V, PROTO, createTable, scriptHooks } from './core.js?v=1';

/** This file's code version (see core.js MODULE_V): the host sends its own in `init`. */
export const MODULE_V = 1;

// What the Worker keeps for itself, taken before anything is removed or
// evaluated: a script shares this realm, and may redefine what it can reach.
const post = self.postMessage.bind(self);
const later = self.setTimeout.bind(self); // drain()'s real timer
const clock = performance.now.bind(performance);
const dataOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get; // (a script could redefine MessageEvent's `data`)
const Prom = Promise;

/** Reports a failure outside the job protocol to the host, which disables
 *  the rules. `message`: what the host shows its own player (the toast, the
 *  rules dialog); `engine`: it is the engine's own text (a broken rule of
 *  running, never the script's words), which the public log may carry too.
 *  `err`, if any, is logged here whole, its stack included. */
function fatal(message, engine = false, err) {
  console.error(`rules Worker: ${message}`, ...(err ? [err] : []));
  post({ type: 'fatal', message: String(message).slice(0, 500), engine });
}
const msgOf = (err) => String(err?.message ?? err ?? 'an error'); // (a message, never a stack: the host shows it to a person)
// The Worker's own listeners come first, in the capture phase: a script's
// listener can't stop them (stopImmediatePropagation), nor reach them.
self.addEventListener('error', (e) => { e.preventDefault(); fatal(msgOf(e.error ?? e.message), false, e.error); }, true);
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fatal(msgOf(e.reason), false, e.reason); }, true);
self.addEventListener('messageerror', () => fatal('a message from the host could not be read', true), true);

// Messages run one at a time, in order (a job awaits its drain before the
// next starts). Only the host's are taken: a MessageEvent a script makes and
// dispatches to its own Worker is not trusted (isTrusted can't be forged),
// and would run a job the host never asked for — the Worker reports it.
let chain = Prom.resolve();
self.addEventListener('message', (e) => {
  if (!e.isTrusted) { fatal('the script dispatched a message to its own Worker', true); return; }
  const m = dataOf.call(e);
  chain = chain.then(() => handle(m)).catch((err) => fatal(msgOf(err), false, err));
}, true);

// --- hardening (spec §3f.7) ----------------------------------------------------
/** Takes `k` away from `on` (the global scope by default) — deleted from it
 *  and from every prototype that has it (a script calling it then gets "k
 *  is not defined") — and, given `desc`, defines it anew there. A browser
 *  that refuses is said in the console: this is defence in depth, and the
 *  rules must still run there. */
function takeAway(k, desc, on = self) {
  try {
    for (let o = on; o; o = Object.getPrototypeOf(o)) if (Object.hasOwn(o, k)) delete o[k];
    if (desc) Object.defineProperty(on, k, desc);
  } catch (err) { console.error(`rules Worker: could not take ${k} away`, err); }
  if (!desc && k in on) console.error(`rules Worker: ${k} is still there`);
}
// The network (fonts load from URLs too), storage (OPFS and storage buckets
// are origin-wide, shared with every page of the site; so are Web Locks),
// other Workers and channels, and its own postMessage.
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts', 'FontFace', 'fonts',
  'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'indexedDB', 'caches', 'webkitRequestFileSystem', 'webkitRequestFileSystemSync',
  'webkitResolveLocalFileSystemURL', 'webkitResolveLocalFileSystemSyncURL', 'postMessage']) takeAway(k);
for (const k of ['storage', 'storageBuckets', 'locks']) takeAway(k, undefined, navigator);
/** The timers a script might reach for, as stubs that say what to use instead:
 *  the script's own parameters (scriptHooks) and the global ones alike. */
const STUBS = Object.fromEntries(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame'].map((k) => [k, () => {
  throw new Error(`${k} is not available to rules scripts — use t.schedule(seconds, tag)`);
}]));
for (const [k, f] of Object.entries(STUBS)) takeAway(k, { value: f });
// close() would end the Worker without a word (the host would wait out the watchdog).
takeAway('close', { value: () => { throw new Error('close is not available to rules scripts'); } });
// What the Worker's own code leans on stays as it is: a script can't hook a
// promise's `then` (the message chain), or an event's prototype.
for (const o of [Promise.prototype, Event.prototype, MessageEvent.prototype, EventTarget.prototype]) Object.freeze(o);
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
  if (r.fatal) return fatal(r.fatal, true);
  // drain(): every microtask the job's hooks queued runs before this timer;
  // one that called the facade, or wrote t.data, broke "hooks are synchronous".
  await new Prom((res) => later(res, 0));
  const why = T.guard();
  if (why) return fatal(why, true);
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
      patch: { ...r.patch, ...p, rules: { ...r.patch.rules, ...p.rules, data, public: pub, secret }, log: [...(r.patch.log || []), ...(p.log || [])] },
      out: { effects: [...r.out.effects, ...T.drain()], error: { hook: why.slice(0, k), message: why.slice(k + 2) } },
    });
  }
}
