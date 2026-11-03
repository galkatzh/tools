// Find a time — Doodle-style scheduling polls, end-to-end encrypted on public Nostr relays.
//
// A poll link is `#<token>`, token = base64url(orgPub ‖ secret [‖ sk]):
//   orgPub 32 B  the organizer's Nostr pubkey: only their poll event is trusted.
//   secret 16 B  HKDF → the poll's NIP-44 key and the two opaque `d` tags relays filter on.
//   sk     32 B  optional ("private link"): your signing key, to answer as yourself from
//                another device. The organizer's sk also unlocks editing the poll.
// The fragment never leaves the browser, so relays only ever see ciphertext, opaque tags,
// random per-poll pubkeys and timestamps.
//
// Events use a dedicated addressable kind (NIP-01: relays keep only the latest event per
// kind, pubkey and d): the organizer's poll under dPoll and one answer per participant under
// dVote, so editing an answer replaces it. Not NIP-78's kind 30078: that one is for data
// private to its author, which relays may serve to the author alone.
// An optional NIP-40 `expiration` tag on every event makes relays delete the whole poll.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'https://cdn.jsdelivr.net/npm/nostr-tools@2.25.2/pure/+esm';
import { SimplePool } from 'https://cdn.jsdelivr.net/npm/nostr-tools@2.25.2/pool/+esm';
import * as nip44 from 'https://cdn.jsdelivr.net/npm/nostr-tools@2.25.2/nip44/+esm';

// window.SCHEDULE_RELAYS overrides the public relays (tests, self-hosting).
const RELAYS = window.SCHEDULE_RELAYS || ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net',
  'wss://nostr.mom', 'wss://offchain.pub', 'wss://relay.nostr.net'];
const KIND = 30827; // unregistered addressable kind (30000–39999) for this app's encrypted poll data
const EXPIRE = [0, 1, 7, 30]; // auto-delete options: days after the last time (0 = never)
const MIN = 60e3;
const HH = 48; // calendar pixels per hour (exported to CSS as --hh)
const STORE = 'schedule:', NAME = 'schedule.name', BUSY = 'schedule.busy'; // localStorage: one entry per poll opened; last name used; imported calendars
const NEXT = { '': 'y', y: 'm', m: 'n', n: 'y' }; // what a tap on an answer turns it into
const MARK = { '': '', y: '✓', m: '(✓)', n: '✗' };
const ID = /^\w{1,16}$/;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale); // navigator.language can be invalid
const FIRST_DAY = ((locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 1) % 7; // as Date#getDay()

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cal = $('#cal'), list = $('#list');
document.documentElement.style.setProperty('--hh', `${HH}px`);

// --- bytes & time -------------------------------------------------------------------------

const te = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const b64u = (b) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const newId = () => Math.random().toString(36).slice(2, 10);

const fmt = (o) => new Intl.DateTimeFormat(undefined, o);
const fTime = fmt({ hour: 'numeric', minute: '2-digit' }), fHour = fmt({ hour: 'numeric' });
const fHead = fmt({ weekday: 'short', day: 'numeric' }), fDay = fmt({ weekday: 'long', month: 'long', day: 'numeric' });
const fRange = fmt({ month: 'short', day: 'numeric', year: 'numeric' }), fDate = fmt({ month: 'short', day: 'numeric' });
const fFull = fmt({ weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fWd = fmt({ weekday: 'short' }), fWeekday = fmt({ weekday: 'long' }); // for weekly polls: no dates
const dayOf = (t) => new Date(t).setHours(0, 0, 0, 0);
const shift = (t, days) => { const d = new Date(t); return d.setDate(d.getDate() + days); }; // same wall-clock time
const weekOf = (t) => dayOf(shift(t, -((new Date(t).getDay() - FIRST_DAY + 7) % 7)));
/** t moved by whole weeks (same wall-clock time) into the 7 days from day w. */
const into = (t, w) => shift(t, -7 * Math.floor(Math.round((dayOf(t) - w) / 864e5) / 7));
const iso = (t) => new Date(t - new Date(t).getTimezoneOffset() * MIN).toISOString(); // local, for <input> values
const utc = (t) => new Date(t).toISOString().replace(/[-:]|\.\d+/g, ''); // iCalendar / Google Calendar format
// Calendar geometry is by wall-clock time, so DST-change days still line up with the hour labels.
/** Y offset of time t inside its day column; `next` is the following midnight (→ bottom edge). */
const yOf = (t, next) => (t >= next ? 24 * HH : ((d) => (d.getHours() + d.getMinutes() / 60) * HH)(new Date(t)));
/** Time at y px into `day`, rounded to `step` minutes. */
const tAt = (day, y, step, round = Math.round) =>
  new Date(day).setHours(0, round((Math.max(0, Math.min(24 * HH, y)) / HH) * 60 / step) * step);
const days = () => (matchMedia('(max-width: 640px)').matches ? 3 : 7);

// --- storage, errors ----------------------------------------------------------------------

function load(key, fallback = {}) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (err) { console.error('localStorage read failed', err); return fallback; }
}
function store(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (err) {
    console.error('localStorage write failed', err);
    toast(`Couldn't save to this browser's storage: ${err.message}`, true);
  }
}
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), isError ? 8000 : Math.max(2500, msg.length * 50));
}
addEventListener('error', (e) => { console.error(e.error ?? e.message); toast(`Error: ${e.message}`, true); });
addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast(`Error: ${e.reason?.message ?? e.reason}`, true); });
addEventListener('beforeunload', (e) => P?.dirty && e.preventDefault());

// --- crypto -------------------------------------------------------------------------------

/** Derive the poll's NIP-44 conversation key and its two relay tags from the link secret. */
async function derive(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = async (info) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(`schedule/${info}`) }, base, 256));
  // NIP-44 v2 to the poll's own keypair, the way NIP-51 encrypts private items to oneself
  const pollSk = await bits('key');
  return { conv: nip44.getConversationKey(pollSk, getPublicKey(pollSk)), dPoll: hex(await bits('poll')), dVote: hex(await bits('vote')) };
}

// NIP-44 has no associated data, so the author's pubkey travels inside the plaintext and must
// match the signer: nobody can re-sign someone else's ciphertext as their own answer.
const seal = (p, obj) => nip44.encrypt(JSON.stringify({ ...obj, by: p.me }), p.conv);
function unseal(p, ev) {
  if (ev.content.length > 256e3) throw new Error('payload too large'); // nip44.decrypt leaves size checks to callers
  const x = JSON.parse(nip44.decrypt(ev.content, p.conv));
  if (x.by !== ev.pubkey) throw new Error('payload was sealed by a different key than the one that signed it');
  return x;
}

// Decrypted payloads come from anyone holding the link: keep only well-formed fields.
// A poll is `kind` 'vote' (answer each time ✓ / (✓) / ✗) or 'grid' (paint free time inside its
// windows, in cells of `step` minutes); `weekly` ones are about weekdays, not dates (see wrap).
function cleanPoll(x) {
  const slots = (Array.isArray(x.slots) ? x.slots : [])
    .filter((s) => typeof s?.id === 'string' && ID.test(s.id) && Number.isFinite(s.s) && Number.isFinite(s.e) && s.s < s.e)
    .slice(0, 500).map(({ id, s, e }) => ({ id, s, e }));
  if (!slots.length) throw new Error('poll has no valid times');
  const kind = x.kind === 'grid' ? 'grid' : 'vote', f = x.final, tz = String(x.tz ?? '').slice(0, 64);
  return { title: String(x.title ?? '').slice(0, 120), notes: String(x.notes ?? '').slice(0, 2000),
    tz: tz && knownZone(tz) ? tz : '', kind, weekly: x.weekly === true, step: [15, 30, 60].includes(x.step) ? x.step : 30, slots,
    final: kind === 'grid' ? (Number.isFinite(f?.s) && Number.isFinite(f?.e) && f.s < f.e ? { s: f.s, e: f.e } : null)
      : slots.some((s) => s.id === f) ? f : null, // a grid poll's final time is a range, a vote's one of its times
    expire: EXPIRE.includes(x.expire) ? x.expire : 0 };
}
function knownZone(tz) {
  try { return !!new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (err) { console.error(`ignoring the poll's unknown time zone ${tz}`, err); return false; }
}
function cleanVote(x) {
  return { name: String(x.name ?? '').slice(0, 60) || 'Anonymous',
    votes: Object.fromEntries(Object.entries(x.votes ?? {}).filter(([id, v]) => ID.test(id) && /^[ymn]$/.test(v))),
    avail: (Array.isArray(x.avail) ? x.avail : []) // grid polls: [[start, end], …] of free time
      .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] < r[1]).slice(0, 2000).map(([a, b]) => [a, b]) };
}

// --- Nostr --------------------------------------------------------------------------------

const pool = new SimplePool({ enableReconnect: true, enablePing: true, maxWaitForConnection: 6000 });
pool.onRelayConnectionFailure = (url) => console.error(`couldn't connect to relay ${url}`);
pool.trackRelays = true; // pool.seenOn: which relays returned each event (see heal)

let mode = 'home';  // which <section> shows: 'home' | 'editor' | 'poll'
let P = null;       // the open poll, see initPoll
let draft = null;   // poll being created or edited: {title, notes, tz, slots: [{id, s, e}], final, expire}
let view = dayOf(Date.now()); // first day the calendar shows
let drag = null;    // calendar gesture in progress (editor)
let paint = null;   // grid poll: the rectangle being painted, {on, a, b} (a, b: entries of `shown`)
let shown = [];     // grid poll: the cells on screen, [{c, col, tod}] (tod: minutes past midnight)
let shownCols = []; // the days the calendar shows
let week0 = null;   // weekly poll: the week its times show in (see wrap)
let cals, busy;     // calendars imported in this browser: [{name, at, busy: [{s, e, t}]}] (never published); all their busy times
const setCals = (c) => { cals = c; busy = c.flatMap((x) => x.busy); };
const cur = () => (mode === 'editor' ? draft : P?.poll); // the poll on screen
const weekly = () => !!cur()?.weekly;
const isGrid = () => cur()?.kind === 'grid';
// A weekly poll keeps real instants, in the week its organizer drew them. They show by weekday:
// each moves by whole weeks into the week on screen (week0), and a clash is checked against the
// next four weeks, where only a clash every week rules a time out.
const wrap = (t) => (weekly() ? into(t, week0) : t);
/** When a time happens: once, or for a weekly poll in each of the next four weeks. */
function occurrences({ s, e }) {
  if (!weekly()) return [{ s, e }];
  const t = into(s, dayOf(Date.now()));
  return [0, 1, 2, 3].map((k) => ({ s: shift(t, 7 * k), e: shift(t, 7 * k) + e - s }));
}
const overlap = (r) => busy.filter((b) => b.s < r.e && b.e > r.s);
const clashes = (slot) => [...new Set(occurrences(slot).flatMap(overlap))];
const blocked = (slot) => occurrences(slot).every((o) => overlap(o).length); // our calendar rules it out
const away = (day, bz) => bz.filter((b) => b.s <= day && b.e >= dayOf(shift(day, 1))); // busy the whole day: vacations, trips
/** Our busy times on screen: for a weekly poll, those of the coming 7 days, by weekday. */
const shownBusy = () => (!weekly() ? busy : busy.filter((b) => b.e > dayOf(Date.now()) && b.s < dayOf(shift(Date.now(), 7)))
  .map((b) => ({ ...b, s: wrap(b.s), e: wrap(b.s) + b.e - b.s })));
/** A day's name: its date, or for a weekly poll its weekday. */
const dayName = (t) => (weekly() ? fWeekday : fDay).format(t);
const dayShort = (t) => (weekly() ? fWd : fHead).format(t);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Set P to the poll a link token names (format in the header). */
async function initPoll(token) {
  let raw;
  try { raw = unb64u(token); } catch (err) { console.error('bad poll token', err); }
  if (raw?.length !== 48 && raw?.length !== 80) throw new Error('This isn’t a valid poll link.');
  const share = b64u(raw.subarray(0, 48)), saved = load(STORE + share);
  const sk = raw.length === 80 ? raw.slice(48) : saved.sk ? unhex(saved.sk) : generateSecretKey();
  if (raw.length === 80) history.replaceState(null, '', `#${share}`); // keep the private key out of the address bar
  store(STORE + share, { ...saved, sk: hex(sk), at: Date.now() });
  P = { share, org: hex(raw.subarray(0, 32)), sk, me: getPublicKey(sk), ...(await derive(raw.subarray(32, 48))),
    poll: null, votes: new Map(), events: new Map(), cache: saved.events ?? [], error: null,
    mine: { name: load(NAME, ''), votes: {}, avail: [] }, dirty: false };
  $('#name').value = P.mine.name;
}

/** Stream the poll and every answer from the relays, live. */
function subscribe(p) {
  p.sub = pool.subscribeMany(RELAYS, { kinds: [KIND], '#d': [p.dPoll, p.dVote] }, {
    onevent: (ev) => receive(p, ev),
    oneose: () => {
      if (P !== p) return;
      p.synced = true;
      if (!p.poll) p.error = 'This poll wasn’t found on any reachable relay. It may have expired, the link may be incomplete, or the relays dropped it.';
      heal(p);
      syncAnswerExpiry(p);
      markClashes(p);
      render();
    },
    onclose: (reasons) => { // only once every relay has closed: nothing is reachable
      if (P !== p) return;
      console.error('every relay subscription closed', reasons);
      p.error = `Couldn’t reach any Nostr relay: ${reasons.map((r) => `${r.url} (${r.reason})`).join(', ')}`;
      render();
    },
  });
}

const dTag = (ev) => ev.tags.find((t) => t[0] === 'd')?.[1];
const expOf = (ev) => +ev.tags.find((t) => t[0] === 'expiration')?.[1] || null; // NIP-40, unix seconds
const expired = (ev) => expOf(ev) !== null && expOf(ev) * 1000 <= Date.now();
// NIP-01: of two versions of an addressable event, the later one wins; on a tie, the lowest id.
const supersedes = (a, b) => !b || a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);

/** Apply one signature-checked event, from a relay or from our own publish. Async on purpose:
 *  a throw then reaches the unhandledrejection toast instead of the pool's quiet console.warn. */
async function receive(p, ev) {
  const d = dTag(ev), key = ev.pubkey + d;
  if (d === p.dPoll && ev.pubkey !== p.org) return console.warn('ignoring a poll event not signed by the organizer', ev);
  if (expired(ev) || !supersedes(ev, p.events.get(key))) return; // NIP-40: clients ignore expired events
  let data;
  try {
    data = (d === p.dPoll ? cleanPoll : cleanVote)(unseal(p, ev));
  } catch (err) {
    return console.error('dropping an event that failed to decrypt or validate', ev, err);
  }
  if (P !== p) return; // we navigated away
  p.events.set(key, ev);
  const first = d === p.dPoll && !p.poll;
  if (d === p.dPoll) {
    [p.poll, p.error, p.exp] = [data, null, expOf(ev)];
    clearTimeout(p.expTimer); // drop the poll from view when it expires (setTimeout can't wait past ~24.8 days)
    if (p.exp && p.exp * 1000 - Date.now() < 2 ** 31 - 1) p.expTimer = setTimeout(() => expire(p), p.exp * 1000 - Date.now());
    syncAnswerExpiry(p);
    markClashes(p); // the organizer may have added times
  } else {
    p.votes.set(ev.pubkey, data);
    if (ev.pubkey === p.me && !p.dirty) { // our saved answers (from this or another device)
      p.mine = structuredClone(data);
      $('#name').value = data.name;
    }
  }
  persist(p);
  render();
  if (first && mode === 'poll') goto((data.slots.find((s) => s.e > Date.now()) ?? data.slots[0]).s);
}

/** Answers expire with the poll. If the organizer changed the expiry since we answered,
 *  re-sign our answer to match (only its author can). */
function syncAnswerExpiry(p) {
  const ev = p.events.get(p.me + p.dVote);
  if (!p.synced || !p.poll || !ev || expOf(ev) === p.exp || p.resyncing || P !== p) return;
  p.resyncing = true;
  publish(p.dVote, p.votes.get(p.me))
    .catch((err) => { console.error('couldn’t update the expiry of our answer', err); toast(`Couldn’t update your answer’s expiry: ${err.message}`, true); })
    .finally(() => (p.resyncing = false));
}

/** The poll's time is up: forget it here too, keys included. */
function expire(p) {
  try { localStorage.removeItem(STORE + p.share); } catch (err) { console.error('localStorage unavailable', err); }
  clearTimeout(p.persistTimer);
  Object.assign(p, { poll: null, votes: new Map(), events: new Map(), cache: [], dirty: false, error: 'This poll has expired and was deleted.' });
  if (mode === 'editor' && P === p) mode = 'poll';
  render();
}

/** Drop polls past their expiry from this browser's storage. */
function purgeExpired() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(STORE) && load(k).exp && load(k).exp * 1000 <= Date.now()) localStorage.removeItem(k);
  } catch (err) { console.error('localStorage unavailable', err); }
}

/** Every unexpired signed event we know: what relays sent this session, plus what we saw before. */
function known(p) {
  const m = new Map();
  for (const ev of [...p.cache, ...p.events.values()]) if (!expired(ev) && supersedes(ev, m.get(ev.pubkey + dTag(ev)))) m.set(ev.pubkey + dTag(ev), ev);
  return [...m.values()];
}
function persist(p) {
  clearTimeout(p.persistTimer);
  p.persistTimer = setTimeout(() => store(STORE + p.share, { ...load(STORE + p.share), title: p.poll?.title, exp: p.exp, events: known(p) }), 500);
}

// NIP-11 relay information documents, fetched once per relay (a failure is retried next time).
const nip11 = new Map();
function relayInfo(url) {
  const key = new URL(url).href; // the pool normalizes `wss://host` to `wss://host/`
  if (!nip11.has(key)) {
    nip11.set(key, fetch(key.replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((err) => {
        console.error(`no NIP-11 information from ${url}`, err);
        nip11.delete(key);
        return null;
      }));
  }
  return nip11.get(key);
}
/** The relays that may receive ev: NIP-40 says to send expiring events only to relays that
 *  list NIP-40 in their NIP-11 `supported_nips`. */
async function targets(ev, relays = RELAYS) {
  if (!expOf(ev)) return relays;
  const ok = await Promise.all(relays.map(async (url) => (await relayInfo(url))?.supported_nips?.includes(40)));
  return relays.filter((_, i) => ok[i]);
}

/** Public relays prune and miss events. Signed events can be relayed by anyone, so after the
 *  initial sync hand each event we know to every connected relay that didn't return it. */
async function heal(p) {
  const live = [...pool.listConnectionStatus()].filter(([, ok]) => ok).map(([url]) => url);
  for (const ev of known(p)) {
    const has = new Set([...(pool.seenOn.get(ev.id) ?? [])].map((r) => r.url));
    const missing = (await targets(ev, live)).filter((url) => !has.has(url));
    pool.publish(missing, ev).forEach((pr, i) => pr.catch((err) => console.error(`re-seeding ${missing[i]} failed`, err)));
  }
}

/** Encrypt, sign and publish our event under tag d, expiring at `exp` (unix seconds, or null).
 *  Resolves once a relay has stored it, to "stored/targeted" relay counts: slow relays get a
 *  short grace period, but a dead one isn't waited out. */
async function publish(d, data, exp = P.exp) {
  const p = P, prev = p.events.get(p.me + d)?.created_at ?? 0;
  const ev = finalizeEvent({ kind: KIND, created_at: Math.max(Math.floor(Date.now() / 1000), prev + 1),
    tags: [['d', d], ...(exp ? [['expiration', String(exp)]] : [])], content: seal(p, data) }, p.sk);
  const to = await targets(ev);
  if (!to.length) throw new Error('None of the relays supports expiring events (NIP-40), so this can’t be saved with automatic deletion.');
  let ok = 0;
  const acks = pool.publish(to, ev).map((pr, i) => pr.then(() => ok++, (err) => {
    console.error(`${to[i]} rejected the update`, err);
    throw err?.message ?? err;
  }));
  try {
    await Promise.any(acks);
  } catch (err) {
    throw new Error(`No relay accepted the update (${err.errors.join('; ')})`);
  }
  await Promise.race([Promise.allSettled(acks), new Promise((r) => setTimeout(r, 1500))]);
  await receive(p, ev);
  return `${ok}/${to.length}`;
}

function updateNet() {
  const live = [...pool.listConnectionStatus()].filter(([, ok]) => ok).map(([url]) => url);
  const net = $('#net');
  net.hidden = !P?.sub;
  net.textContent = `● ${live.length}/${RELAYS.length} relays`;
  net.classList.toggle('bad', !live.length);
  net.title = RELAYS.map((u) => `${live.some((l) => new URL(l).host === new URL(u).host) ? '✓' : '✗'} ${u}`).join('\n');
}
setInterval(updateNet, 2000);

// --- rendering ----------------------------------------------------------------------------

/** The poll's times, sorted; a weekly poll's moved into the week on screen (same ids). */
const slots = () => (cur()?.slots ?? []).map((x) => ({ ...x, s: wrap(x.s), e: wrap(x.s) + x.e - x.s })).sort((a, b) => a.s - b.s);
const others = () => [...P.votes].filter(([pk]) => pk !== P.me).map(([, v]) => v).sort((a, b) => a.name.localeCompare(b.name));

// --- grid polls: cells and painted availability ---
/** A grid poll's cells: the start of every `step` minutes in its windows, each counted once. */
function cells(poll) {
  const step = poll.step * MIN, out = new Set();
  for (const w of poll.slots) for (let c = w.s; c + step <= w.e; c += step) out.add(c);
  return [...out].sort((a, b) => a - b);
}
/** Cell starts merged into the [[start, end], …] ranges an answer stores. */
function toRanges(cs, step) {
  const out = [];
  for (const c of [...cs].sort((a, b) => a - b)) {
    if (out.at(-1)?.[1] === c) out.at(-1)[1] = c + step;
    else out.push([c, c + step]);
  }
  return out;
}
const isIn = (ranges, t) => ranges.some(([s, e]) => s <= t && t < e);
/** Who answered a grid poll: us first (unsaved painting included), then everyone else. */
const people = () => [...(P.votes.has(P.me) || P.mine.avail.length ? [{ ...P.mine, name: P.mine.name.trim() || 'You' }] : []), ...others()];
/** The cells inside the rectangle being painted, from its first cell to the one under the pointer. */
function paintSel() {
  const [c0, c1] = [paint.a.col, paint.b.col].sort((x, y) => x - y), [t0, t1] = [paint.a.tod, paint.b.tod].sort((x, y) => x - y);
  return shown.filter((x) => x.col >= c0 && x.col <= c1 && x.tod >= t0 && x.tod <= t1).map((x) => x.c);
}
/** The best times of a grid poll: runs of consecutive cells the same people can make, most
 *  people first, then the longest. `who`: indices into `ppl`. */
function bestTimes(ppl) {
  const step = P.poll.step * MIN, runs = [];
  for (const c of cells(P.poll)) {
    const who = ppl.flatMap((p, i) => (isIn(p.avail, c) ? [i] : [])), key = who.join(), last = runs.at(-1);
    if (last?.e === c && last.key === key) last.e = c + step;
    else if (who.length) runs.push({ s: c, e: c + step, who, key });
  }
  return runs.sort((a, b) => b.who.length - a.who.length || b.e - b.s - (a.e - a.s) || a.s - b.s).slice(0, 5);
}
/** What the info line says about cell c: who's free then. */
function cellInfo(c) {
  const ppl = people(), t = wrap(c), free = ppl.filter((p) => isIn(p.avail, c)).map((p) => p.name);
  const not = ppl.filter((p) => !isIn(p.avail, c)).map((p) => p.name);
  return `${dayName(t)}, ${fTime.formatRange(t, t + P.poll.step * MIN)}: ${free.length} of ${ppl.length} free`
    + `${free.length ? ` (${free.join(', ')})` : ''}${not.length ? `. Not: ${not.join(', ')}` : ''}`;
}

/** Yes / if-need-be counts per slot, counting our unsaved answers; `best` marks the leaders. */
function tallies() {
  const t = new Map(P.poll.slots.map((s) => [s.id, { y: 0, m: 0, n: 0 }]));
  for (const person of [P.mine, ...others()]) for (const [id, v] of Object.entries(person.votes)) if (t.has(id)) t.get(id)[v]++;
  const score = (x) => (x.y + x.m) * 1e4 + x.y; // most people available, then most enthusiastic
  const top = Math.max(...[...t.values()].map(score));
  if (top > 0) for (const x of t.values()) x.best = score(x) === top;
  return t;
}

function render() {
  for (const id of ['home', 'editor', 'poll']) $(`#${id}`).hidden = mode !== id;
  document.body.dataset.kind = cur()?.kind ?? 'vote'; // shows the .vote-only or .grid-only hints
  if (mode === 'editor') for (const o of $('#expire').options) if (+o.value) o.textContent = `${o.dataset.n} ${weekly() ? 'after saving' : 'after the last time'}`;
  $('#me').hidden = mode !== 'poll' || !P?.poll;
  $('#board').hidden = mode === 'home' || (mode === 'poll' && !P?.poll);
  if (mode === 'home') renderHome();
  if (mode === 'poll') renderHead();
  if (!$('#board').hidden) { renderCal(); renderList(); }
  updateNet();
}

function renderHome() {
  document.title = 'Find a time';
  let keys = [];
  try { keys = Object.keys(localStorage).filter((k) => k.startsWith(STORE)); } catch (err) { console.error('localStorage unavailable', err); }
  const polls = keys.map((k) => ({ token: k.slice(STORE.length), ...load(k) })).sort((a, b) => b.at - a.at);
  const isOrg = (p) => p.sk && getPublicKey(unhex(p.sk)) === hex(unb64u(p.token).subarray(0, 32));
  $('#mine').innerHTML = polls.map((p) => `<li><a href="#${esc(p.token)}">${esc(p.title || 'Untitled poll')}</a>
    ${isOrg(p) ? '<small class="badge">organizer</small>' : ''}
    <button class="x" data-forget="${esc(p.token)}" title="Forget this poll in this browser">×</button></li>`).join('')
    || '<li class="muted">Polls you create or open show up here.</li>';
}

function renderHead() {
  const p = P, poll = p?.poll;
  $('#msg').textContent = p?.error ?? (poll ? '' : 'Loading the poll from Nostr relays…');
  $('#msg').classList.toggle('error', !!p?.error);
  $('#head').hidden = !poll;
  if (!poll) return;
  document.title = `${poll.title} · Find a time`;
  $('#title').textContent = poll.title;
  $('#notes').textContent = poll.notes;
  $('#tz').textContent = `${poll.weekly ? 'This poll is about a weekly event. ' : ''}Times are in your time zone, ${TZ}${poll.tz && poll.tz !== TZ
    ? ` (the organizer is in ${poll.tz}${poll.weekly ? ', so a daylight-saving change can move them by an hour' : ''})` : ''}.`
    + (p.exp ? ` The poll and all answers are deleted automatically on ${fFull.format(p.exp * 1000)}.` : '');
  $('#editBtn').hidden = p.me !== p.org;
  const f = finalOf(poll);
  $('#final').hidden = !f;
  if (f) {
    $('#finalTime').textContent = poll.weekly ? `every ${fWeekday.format(f.s)}, ${fTime.formatRange(f.s, f.e)}` : fFull.formatRange(f.s, f.e);
    const [s, e, tz] = when(poll, f);
    $('#gcal').href = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(poll.title)}`
      + `&dates=${s}/${e}&details=${encodeURIComponent(poll.notes)}${tz ? `&ctz=${encodeURIComponent(tz)}&recur=RRULE:FREQ%3DWEEKLY` : ''}`;
  }
  $('#save').disabled = !p.dirty;
  $('#saveState').textContent = p.dirty ? 'Unsaved' : p.votes.has(p.me) ? 'Saved ✓' : '';
  $('#deviceBtn').hidden = !p.votes.has(p.me) && p.me !== p.org; // once there's something here worth taking along
}

/** Place overlapping segments side by side: each gets a lane and its cluster's lane count. */
function lanes(segs) {
  let cluster = [], ends = [], clusterEnd = -Infinity;
  const flush = () => { for (const g of cluster) g.lanes = ends.length; cluster = []; ends = []; };
  for (const g of segs.sort((a, b) => a.s - b.s || b.e - a.e)) {
    if (g.s >= clusterEnd) flush();
    let i = ends.findIndex((e) => e <= g.s);
    if (i < 0) i = ends.push(0) - 1;
    ends[i] = g.e;
    g.lane = i;
    cluster.push(g);
    clusterEnd = Math.max(clusterEnd, g.e);
  }
  flush();
}

/** A calendar grid for the days `cols`: their headers, the hour gutter, then `body(day, next, i)`
 *  for each day column (`next`: the following midnight). */
function gridHtml(cols, head, body) {
  return `<div class="cal-grid" style="--days:${cols.length}"><div class="corner"></div>${cols.map((d) => head(d)).join('')}`
    + `<div class="gutter">${Array.from({ length: 23 }, (_, h) => `<span style="top:${(h + 1) * HH}px">${fHour.format(new Date(view).setHours(h + 1))}</span>`).join('')}</div>`
    + `${cols.map((day, i) => body(day, dayOf(shift(day, 1)), i)).join('')}</div>`;
}

function renderCal() {
  const n = days(), ss = cur()?.slots ?? [], wk = weekly();
  week0 = weekOf(ss.length ? Math.min(...ss.map((s) => s.s)) : view);
  view = dayOf(wrap(view));
  if (n === 7) view = weekOf(view);
  const cols = (shownCols = Array.from({ length: n }, (_, i) => dayOf(wrap(shift(view, i))))); // a weekly 3-day view wraps around
  $('[data-nav="0"]').hidden = wk;
  $('[data-nav="-1"]').hidden = $('[data-nav="1"]').hidden = wk && n === 7;
  $('#range').textContent = wk ? 'Every week' : fRange.formatRange(cols[0], cols[n - 1]);
  const all = slots(), painting = mode === 'poll' && isGrid(), t = mode === 'poll' && !painting && tallies();
  const today = !wk && dayOf(Date.now()), bz = shownBusy();
  // editor: an empty day / week offers to copy the latest earlier day / week that has times
  const copyFrom = (t0, unit, span) => mode === 'editor' && !all.some((s) => s.s >= t0 && s.s < dayOf(shift(t0, span)))
    && Math.max(...all.map((s) => unit(s.s)).filter((u) => u < t0));
  const week = weekOf(view), srcWeek = copyFrom(week, weekOf, 7), weekBtn = $('#copyWeek');
  weekBtn.hidden = !Number.isFinite(srcWeek);
  if (!weekBtn.hidden) {
    weekBtn.textContent = `⧉ Copy week of ${fDate.format(srcWeek)}`;
    Object.assign(weekBtn.dataset, { src: srcWeek, to: week });
  }
  const head = (d, src = copyFrom(d, dayOf, 1)) => `<div class="dh${d === today ? ' today' : ''}">${dayShort(d)}${Number.isFinite(src)
    ? `<button class="copy" data-src="${src}" data-to="${d}" data-span="1" title="Copy the times of ${dayName(src)}">⧉ ${dayShort(src)}</button>`
    : mode === 'editor' ? '<button class="copy ghost" tabindex="-1" aria-hidden="true">⧉</button>' : ''}${ // keeps the header from growing mid-drag
    mode === 'poll' && !painting ? dayNo(d) : ''}${awayNote(d, bz)}</div>`;
  const grid = painting ? cells(P.poll) : [], sel = paint && new Set(paintSel());
  shown = [];
  const top = cal.scrollTop;
  cal.innerHTML = gridHtml(cols, head, (day, next, col) => {
    // our own busy times: a whole busy day shades the column (named in the header), the rest are
    // blocks, under the poll's times or over the cells we paint
    const whole = painting ? [] : away(day, bz), mine = bz.filter((b) => b.s < next && b.e > day && !whole.includes(b))
      .map((b) => ({ t: b.t, s: Math.max(b.s, day), e: Math.min(b.e, next) }));
    lanes(mine);
    const ours = mine.map((g) => `<div class="busy" style="${place(g, next)}">${esc(g.t)}</div>`).join('');
    let inner;
    if (painting) inner = paintCells(grid.filter((c) => wrap(c) >= day && wrap(c) < next), next, col, sel) + ours;
    else {
      // a slot crossing midnight (possible in another time zone) shows as one segment per day
      const segs = all.filter((s) => s.s < next && s.e > day).map((s) => ({ slot: s, s: Math.max(s.s, day), e: Math.min(s.e, next) }));
      lanes(segs);
      inner = ours + segs.map((g) => block(g, next, t)).join('');
    }
    return `<div class="day${day === today ? ' today' : ''}${whole.length ? ' away' : ''}" data-day="${day}">${inner}</div>`;
  });
  cal.scrollTop = top;
}

/** Grid poll: our cells in one day column, painted where we're free (or about to be). */
function paintCells(cs, next, col, sel) {
  return cs.map((c) => {
    const t = wrap(c), d = new Date(t), on = sel?.has(c) ? paint.on : isIn(P.mine.avail, c);
    shown.push({ c, col, tod: d.getHours() * 60 + d.getMinutes() });
    return `<div class="cell${on ? ' on' : ''}" data-cell="${c}" style="top:${yOf(t, next)}px;height:${P.poll.step * HH / 60}px"></div>`;
  }).join('');
}

/** Day header note naming the events that keep us busy all of `day`. */
function awayNote(day, bz) {
  const t = away(day, bz).map((b) => b.t || 'busy').join(', ');
  return t && `<small class="away" title="${esc(t)}">${esc(t)}</small>`;
}

/** Inline position of segment g (laid out by lanes) in its day column. Editor blocks leave a strip
 *  (--free) on the right free, so a click there can add a time that overlaps them. */
function place(g, next) {
  const top = yOf(g.s, next);
  return `top:${top}px;height:${Math.max(yOf(g.e, next) - top, HH / 4)}px;`
    + `left:calc((100% - var(--free, 0px)) * ${g.lane / g.lanes} + 1px);width:calc((100% - var(--free, 0px)) / ${g.lanes} - 3px)`;
}

/** "clashes with …" for a slot that overlaps our calendar's busy times, else ''. */
function clashNote(s) {
  const names = [...new Set(clashes(s).map((b) => b.t || 'busy'))].join(', ');
  return names && `clashes with ${names}${weekly() ? (blocked(s) ? ' every week' : ' on some weeks') : ''}`;
}

function block(g, next, t) {
  const s = g.slot, style = place(g, next), range = fTime.formatRange(s.s, s.e), clash = isGrid() ? '' : clashNote(s); // a window clashes with something anyway
  if (mode === 'editor') {
    return `<div class="blk edit" data-slot="${s.id}" style="${style}" title="${esc(range + (clash && ` · ${clash}`))}"><span>${clash ? '⚠ ' : ''}${range}</span>`
      + `<button class="x" data-del="${s.id}" aria-label="Remove">×</button>`
      + `${g.e === s.e ? `<div class="grip" data-grip="${s.id}"></div>` : ''}</div>`;
  }
  const v = P.mine.votes[s.id] ?? '', x = t.get(s.id);
  return `<button class="blk v-${v || 'none'}${x.best ? ' best' : ''}${P.poll.final === s.id ? ' final' : ''}" data-slot="${s.id}"`
    + ` data-vote="${s.id}" style="${style}" title="${esc(`${range}: ${x.y} yes, ${x.m} if need be${clash && ` · ${clash}`}`)}"><span>${fTime.format(s.s)} ${MARK[v]}${clash ? ' ⚠' : ''}</span>`
    + `<small>${x.best ? '★ ' : ''}${x.y}✓${x.m ? ` ${x.m}(✓)` : ''}</small></button>`;
}

function renderList() {
  const all = slots();
  if (mode === 'editor') {
    const week = Array.from({ length: 7 }, (_, i) => dayOf(shift(week0, i))); // a weekly poll picks weekdays
    list.innerHTML = `<div class="erows">${all.map((s) => `<div class="erow" data-slot="${s.id}">
      ${weekly() ? `<select aria-label="Day">${week.map((d) => `<option value="${d}"${d === dayOf(s.s) ? ' selected' : ''}>${fWeekday.format(d)}</option>`).join('')}</select>`
        : `<input type="date" value="${iso(s.s).slice(0, 10)}" required>`}
      <input type="time" value="${iso(s.s).slice(11, 16)}" step="900" required><span>–</span>
      <input type="time" value="${iso(s.e).slice(11, 16)}" step="900" required>
      <button class="x" data-del="${s.id}" aria-label="Remove">×</button></div>`).join('')
      || `<p class="muted">No ${isGrid() ? 'days' : 'times'} yet.</p>`}</div><button id="addSlot">＋ Add ${isGrid() ? 'day' : 'time'}</button>`;
    return;
  }
  if (isGrid()) return renderGroup();
  const ppl = others(), t = tallies(), admin = P.me === P.org;
  let html = `<table class="votes"><thead><tr><th class="t">${ppl.length + (P.votes.has(P.me) ? 1 : 0)} answered</th><th>Total</th>`
    + `<th class="you">${esc(P.mine.name.trim() || 'You')}</th>${ppl.map((p) => `<th title="${esc(p.name)}">${esc(p.name)}</th>`).join('')}</tr></thead><tbody>`;
  let lastDay;
  for (const s of all) {
    if (dayOf(s.s) !== lastDay) {
      lastDay = dayOf(s.s);
      html += `<tr class="dayrow"><th colspan="${3 + ppl.length}"><span>${dayName(s.s)} ${dayNo(lastDay)}</span></th></tr>`;
    }
    const x = t.get(s.id), v = P.mine.votes[s.id] ?? '', final = P.poll.final === s.id, clash = clashNote(s);
    html += `<tr data-slot="${s.id}" class="${x.best ? 'best' : ''}${final ? ' final' : ''}">`
      + `<th class="t"><button class="link" data-goto="${s.id}" title="Show in calendar">${fTime.formatRange(s.s, s.e)}</button>${clash ? ` <span class="clash" title="${esc(clash)}">⚠</span>` : ''}${x.best ? ' ★' : ''}${final ? ' 📌' : ''}</th>`
      + `<td class="tally">${x.y}✓${x.m ? ` ${x.m}(✓)` : ''}${admin ? ` <button class="pin" data-final="${s.id}" title="${final ? 'Unpick' : 'Pick as the final time'}">📌</button>` : ''}</td>`
      + `<td class="you"><button class="v v-${v || 'none'}" data-vote="${s.id}" aria-label="Your answer">${MARK[v]}</button></td>`
      + ppl.map((p) => `<td class="v v-${p.votes[s.id] || 'none'}">${MARK[p.votes[s.id] ?? '']}</td>`).join('') + '</tr>';
  }
  list.innerHTML = `${html}</tbody></table>`;
}

/** Grid poll: everyone's availability as a heat map (same days and scroll as the calendar), the
 *  best times, and who answered. */
function renderGroup() {
  const ppl = people(), f = P.poll.final, h = P.poll.step * HH / 60, grid = cells(P.poll);
  const heat = (day, next) => `<div class="day">${grid.filter((c) => wrap(c) >= day && wrap(c) < next).map((c) => {
    const n = ppl.filter((p) => isIn(p.avail, c)).length;
    return `<div class="heat${f && c >= f.s && c < f.e ? ' final' : ''}" data-cell="${c}" style="top:${yOf(wrap(c), next)}px;height:${h}px;`
      + `--heat:${ppl.length ? Math.round((100 * n) / ppl.length) : 0}%"></div>`;
  }).join('')}</div>`;
  const best = bestTimes(ppl).map((r) => {
    const t = wrap(r.s), picked = f?.s === r.s && f?.e === r.e, not = ppl.filter((_, i) => !r.who.includes(i)).map((p) => p.name), admin = P.me === P.org;
    return `<li${picked ? ' class="final"' : ''}><button class="link" data-at="${r.s}" title="Show in calendar">${dayName(t)}, ${fTime.formatRange(t, t + r.e - r.s)}</button>`
      + ` · ${r.who.length} of ${ppl.length}${not.length ? ` <small class="muted">(not ${esc(not.join(', '))})</small>` : ''}${picked && !admin ? ' 📌' : ''}`
      + `${admin ? ` <button class="pin" data-pick="${r.s},${r.e}" title="${picked ? 'Unpick' : 'Pick as the final time'}">📌</button>` : ''}</li>`;
  });
  list.innerHTML = `<h3>Best times</h3>${best.length ? `<ol class="best">${best.join('')}</ol>` : '<p class="muted">Nobody has painted any times yet.</p>'}`
    + `<p class="ghead"><b>Everyone</b> · ${plural(ppl.length, 'answer')}${ppl.length ? `: ${esc(ppl.map((p) => p.name).join(', '))}` : ''}`
    + ` <span class="ramp" title="from nobody to everyone free"></span></p>`
    + `<p id="ginfo" class="muted">${ppl.length ? 'Point at or tap a time to see who’s free.' : 'Nobody has answered yet.'}</p>`
    + `<div id="heatmap" class="cal">${gridHtml(shownCols, (d) => `<div class="dh">${dayShort(d)}</div>`, heat)}</div>`;
  $('#heatmap').scrollTop = cal.scrollTop;
}

const daySlots = (day) => slots().filter((s) => s.s < dayOf(shift(day, 1)) && s.e > day);

/** Poll view: a toggle that answers ✗ to every time on `day` (not available all day), or clears them. */
function dayNo(day) {
  const ss = daySlots(day), on = ss.every((s) => P.mine.votes[s.id] === 'n');
  return ss.length ? `<button class="dayno${on ? ' on' : ''}" data-dayno="${day}" aria-pressed="${on}"`
    + ` title="${on ? 'Clear your answers for' : 'Not available all day: ✗ to every time on'} ${dayName(day)}">✗ all day</button>` : '';
}

/** Bring time t into view in the calendar (the editor's list keeps its focus: it isn't redrawn). */
function goto(t) {
  view = dayOf(t);
  if (mode === 'editor') renderCal();
  else render();
  cal.scrollTop = yOf(t, Infinity) - HH;
}

// --- actions ------------------------------------------------------------------------------

async function route() {
  P?.sub?.close();
  [P, draft] = [null, null];
  const h = location.hash.slice(1);
  if (!h) mode = 'home';
  else if (h === 'new') return startEdit(null);
  else {
    mode = 'poll';
    try {
      await initPoll(h);
      subscribe(P);
    } catch (err) {
      console.error(err);
      P = { error: err.message };
    }
  }
  render();
}

function startEdit(poll) {
  // new polls: votes on dates, deleted a month after
  draft = structuredClone(poll ?? { title: '', notes: '', kind: 'vote', weekly: false, step: 30, slots: [], final: null, expire: 30 });
  $('#eTitle').value = draft.title;
  $('#eNotes').value = draft.notes;
  $('#expire').value = draft.expire;
  $('#step').value = draft.step;
  for (const r of document.querySelectorAll('[name=kind], [name=weekly]')) {
    r.checked = r.value === String(r.name === 'kind' ? draft.kind : draft.weekly);
    r.disabled = !!poll; // answers depend on them
  }
  $('#publish').textContent = poll ? 'Save changes' : 'Create poll';
  mode = 'editor';
  render();
  goto(slots()[0]?.s ?? new Date().setHours(8, 0, 0, 0));
}

/** A grid poll's window for `day`: the hours the editor offers by default, or nothing if they're unusable. */
function dayWindow(day) {
  const [s, e] = ['#gFrom', '#gTo'].map((q) => new Date(day).setHours(...$(q).value.split(':')));
  if (s < e) return { s, e };
  toast('The day’s hours have to end after they start', true);
}

function addSlot() {
  // the day after the latest time (within the week, for a weekly poll), same hours; or tomorrow
  const last = slots().at(-1);
  const s = last ? wrap(shift(last.s, 1)) : new Date(wrap(shift(Date.now(), 1))).setHours(9, 0, 0, 0);
  const w = last ? { s, e: s + last.e - last.s } : isGrid() ? dayWindow(s) : { s, e: s + $('#dur').value * MIN };
  if (!w) return;
  draft.slots.push({ id: newId(), ...w });
  render();
  goto(w.s);
}

/** Switch the draft between dates and days of the week. Its times fold into the week on screen. */
function setWeekly(on) {
  if (on) {
    const w = weekOf(view), seen = new Set();
    draft.slots = draft.slots.map((x) => ({ ...x, s: into(x.s, w), e: into(x.s, w) + x.e - x.s }))
      .filter((x) => !seen.has(`${x.s},${x.e}`) && seen.add(`${x.s},${x.e}`)); // the same time on several dates: once
  }
  draft.weekly = on;
}

/** Duplicate the times starting in the `span` days from `src` onto the days from `to`, at the
 *  same wall-clock hours (so a copy across a DST change keeps 10:00 at 10:00). */
function copyDays(src, to, span) {
  const k = Math.round((to - src) / (1440 * MIN)), end = dayOf(shift(src, span));
  for (const s of draft.slots.filter((x) => x.s >= src && x.s < end)) draft.slots.push({ id: newId(), s: shift(s.s, k), e: shift(s.e, k) });
  render();
}

async function savePoll() {
  Object.assign(draft, { title: $('#eTitle').value.trim(), notes: $('#eNotes').value.trim(), tz: TZ, expire: +$('#expire').value,
    step: +$('#step').value });
  if (!draft.title) { $('#eTitle').focus(); return toast('Give the poll a title first', true); }
  if (!draft.slots.length) return toast(`Add at least one ${isGrid() ? 'day' : 'time'}`, true);
  draft.slots.sort((a, b) => a.s - b.s);
  if (!isGrid() && !draft.slots.some((s) => s.id === draft.final)) draft.final = null;
  // the expiry follows the last time, so editing the times moves it; a weekly poll's times recur,
  // so its expiry counts from saving
  const exp = draft.expire ? Math.ceil(shift(draft.weekly ? Date.now() : Math.max(...draft.slots.map((s) => s.e)), draft.expire) / 1000) : null;
  if (exp && exp * 1000 <= Date.now()) return toast('Every time is long past, so the poll would be deleted at once: add a later time or choose “never”.', true);
  const btn = $('#publish');
  btn.disabled = true;
  try {
    if (!P) { // a brand-new poll: mint the organizer's key and the link secret
      const sk = generateSecretKey();
      await initPoll(b64u(new Uint8Array([...unhex(getPublicKey(sk)), ...crypto.getRandomValues(new Uint8Array(16)), ...sk])));
    }
    const isNew = !P.poll, n = await publish(P.dPoll, draft, exp);
    if (!P.sub) subscribe(P);
    [mode, draft] = ['poll', null];
    render();
    toast(`Poll saved to ${n} relays`);
    if (isNew) openShare();
  } finally {
    btn.disabled = false;
  }
}

async function saveAnswers() {
  const name = P.mine.name.trim();
  if (!name) { $('#name').focus(); return toast('Enter your name first', true); }
  store(NAME, name);
  const sent = JSON.stringify(P.mine), first = !P.votes.has(P.me);
  $('#save').disabled = true;
  $('#saveState').textContent = 'Saving…';
  try {
    const n = await publish(P.dVote, { ...P.mine, name });
    P.dirty = JSON.stringify(P.mine) !== sent; // still dirty if they kept tapping while it saved
    toast(`Saved to ${n} relays`);
    if (first) openDevice(true); // the moment to take the private link along, before it's needed
  } finally {
    render();
  }
}

/** Answer ✗ to our unanswered times that clash with our calendar, and say so. Waits for the
 *  initial sync: until then our saved answers may still be on their way. */
function markClashes(p) {
  if (mode !== 'poll' || P !== p || !p.synced || !p.poll) return;
  if (isGrid()) return paintFree(p);
  const hit = p.poll.slots.filter((s) => !p.mine.votes[s.id] && blocked(s));
  if (!hit.length) return;
  for (const s of hit) p.mine.votes[s.id] = 'n';
  p.dirty = true;
  toast(`Marked ${plural(hit.length, 'time')} that clash with your calendar ✗ no. Save answers to send.`);
}

/** Grid poll: a blank answer starts out painted wherever our calendar leaves us free. */
function paintFree(p) {
  if (!busy.length || p.mine.avail.length || p.votes.has(p.me)) return;
  const step = p.poll.step * MIN, free = cells(p.poll).filter((c) => !blocked({ s: c, e: c + step }));
  if (!free.length) return toast('Your calendar is busy at every time of this poll.');
  p.mine.avail = toRanges(free, step);
  p.dirty = true;
  toast('Painted the times your calendar leaves free. Adjust them, then save your answers.');
}

/** Pick (or unpick) the final time: a vote poll's slot id, or a grid poll's {s, e} range. */
async function setFinal(f) {
  const final = JSON.stringify(P.poll.final) === JSON.stringify(f) ? null : f;
  const n = await publish(P.dPoll, { ...P.poll, final });
  toast(`${final ? 'Final time picked' : 'Final time cleared'} (saved to ${n} relays)`);
}

function openShare() {
  $('#shareLink').value = `${location.href.split('#')[0]}#${P.share}`;
  $('#share').showModal();
}

/** Show our private link (it carries our key, see the header) as a QR code, a copyable link and
 *  the share sheet, so the poll opens as us on another device. `saved`: right after a first save. */
async function openDevice(saved) {
  const link = `${location.href.split('#')[0]}#${b64u(new Uint8Array([...unb64u(P.share), ...P.sk]))}`;
  $('#privLink').value = link;
  $('#devSaved').hidden = !saved;
  $('#devHint').textContent = P.me === P.org
    ? 'Open this on your other device to edit the poll and your answers there: scan the code with a phone, or copy the link. Keep it to yourself: anyone holding it can change the poll.'
    : 'Open this on your other device to change your answers there: scan the code with a phone, or copy the link. Both devices then share one answer. Keep it to yourself: anyone holding it can answer as you.';
  $('#sendLink').hidden = !navigator.canShare?.({ url: link });
  $('#qr').textContent = 'Loading the QR code…';
  $('#device').showModal();
  try {
    const { default: qrcode } = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.mjs');
    const qr = qrcode(0, 'M'); // 0: the smallest version that fits
    qr.addData(link);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true, title: 'QR code of your private link' });
  } catch (err) {
    console.error('couldn’t draw the QR code', err);
    $('#qr').textContent = `Couldn’t draw the QR code (${err.message}). Copy the link instead.`;
  }
}

const finalOf = (poll) => (poll.kind === 'grid' ? poll.final : poll.slots.find((s) => s.id === poll.final)) ?? null;

/** iCalendar date-time (YYYYMMDDTHHMMSS) of instant t on the wall clock of IANA zone tz. */
function wallIn(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}
/** The final time f for calendars: [start, end] in UTC, or for a weekly poll [start, end, zone]:
 *  its next occurrence on the organizer's wall clock, which the weekly repeat then keeps across
 *  DST. Moved by whole dates, so no time zone offset is involved. */
function when(poll, f) {
  if (!poll.weekly) return [utc(f.s), utc(f.e)];
  const tz = poll.tz || TZ, [s, e] = [f.s, f.e].map((t) => wallIn(t, tz));
  const date = (w) => Date.UTC(w.slice(0, 4), w.slice(4, 6) - 1, w.slice(6, 8));
  const k = Math.ceil((date(wallIn(Date.now(), tz)) - date(s)) / 864e5 / 7) * 7 * 864e5; // to the coming 7 days
  const move = (w) => new Date(date(w) + k).toISOString().slice(0, 10).replace(/-/g, '') + w.slice(8);
  return [move(s), move(e), tz];
}

function downloadIcs() {
  const poll = P.poll, [s, e, tz] = when(poll, finalOf(poll)), at = (w) => (tz ? `;TZID=${tz}:${w}` : `:${w}`);
  const text = (x) => x.replace(/[\\;,]/g, '\\$&').replace(/\r?\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tools//find-a-time//EN', 'BEGIN:VEVENT',
    `UID:${P.dPoll.slice(0, 32)}@find-a-time`, `DTSTAMP:${utc(Date.now())}`, `DTSTART${at(s)}`, `DTEND${at(e)}`, ...(tz ? ['RRULE:FREQ=WEEKLY'] : []),
    `SUMMARY:${text(poll.title)}`, `DESCRIPTION:${text(poll.notes)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })),
    download: `${poll.title.replace(/[^\w -]+/g, '').trim() || 'event'}.ics`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- your calendar ------------------------------------------------------------------------
// Busy times from the user's own calendar files, read and kept in this browser only: they're
// never published. Calendar servers don't let other sites fetch their feeds (no CORS), and a
// public CORS proxy would see the whole calendar, so the user picks or drops an exported file.

/** The calendars in a picked or dropped file: [[file name, iCalendar text]]. Google Calendar
 *  exports a .zip with one .ics per calendar. */
async function icsFiles(file) {
  if (!/\.zip$/i.test(file.name)) return [[file.name, await file.text()]];
  const { unzipSync, strFromU8 } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');
  const files = Object.entries(unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => /\.ics$/i.test(f.name) }));
  if (!files.length) throw new Error('there’s no .ics file in it');
  return files.map(([name, data]) => [name.split('/').pop(), strFromU8(data)]);
}

// A TZID the file doesn't define (no VTIMEZONE) leaves ical.js times "floating", i.e. read as the
// viewer's local time. When it names an IANA zone, Intl can still place the wall-clock time in it.
const zones = new Map(), badZones = new Set(); // tzid → Intl formatter (null if unknown); unknown ones this import
function msOf(t, tzid) {
  if (t.isDate || t.zone?.tzid !== 'floating' || !tzid) return t.toJSDate().getTime();
  if (!zones.has(tzid)) {
    try {
      zones.set(tzid, new Intl.DateTimeFormat('en-US', { timeZone: tzid, hourCycle: 'h23', year: 'numeric', month: 'numeric',
        day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    } catch (err) {
      console.error(`unknown time zone “${tzid}”: its events are read as local time`, err);
      zones.set(tzid, null);
    }
  }
  const f = zones.get(tzid), wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  if (!f) {
    badZones.add(tzid);
    return t.toJSDate().getTime();
  }
  /** How far the zone's clock is ahead of UTC at instant u. */
  const ahead = (u) => {
    const p = Object.fromEntries(f.formatToParts(u).map((x) => [x.type, +x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - u;
  };
  return wall - ahead(wall - ahead(wall)); // the second pass gets the offset right across a DST change
}

/** One calendar's busy times from yesterday to a year ahead, recurring events expanded:
 *  {name, at, busy: [{s, e, t}]}. */
async function parseIcs(name, text) {
  if (!/^BEGIN:VCALENDAR/i.test(text.trimStart())) throw new Error('it isn’t an iCalendar (.ics) file');
  const { default: ICAL } = await import('https://cdn.jsdelivr.net/npm/ical.js@2.2.1/dist/ical.min.js');
  const root = new ICAL.Component(ICAL.parse(text));
  if (root.name !== 'vcalendar') throw new Error('it holds several calendars: export them one by one');
  for (const tz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
  const from = shift(dayOf(Date.now()), -1), to = shift(from, 367), out = [];
  // Not busy: free (TRANSP:TRANSPARENT), cancelled, or declined by the calendar's owner. Google names
  // one's main calendar after one's address, which is how the owner appears among the attendees.
  const me = `mailto:${root.getFirstPropertyValue('x-wr-calname')}`.toLowerCase();
  const free = (c) => c.getFirstPropertyValue('transp') === 'TRANSPARENT' || c.getFirstPropertyValue('status') === 'CANCELLED'
    || c.getAllProperties('attendee').some((a) => String(a.getFirstValue()).toLowerCase() === me && a.getParameter('partstat') === 'DECLINED');
  const add = (ev, s, e) => {
    const a = msOf(s, ev.startDate.timezone), b = msOf(e, ev.endDate.timezone ?? ev.startDate.timezone);
    if (a < b && a < to && b > from && !free(ev.component)) out.push({ s: a, e: b, t: String(ev.summary ?? '').slice(0, 80) });
  };
  const events = root.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
  // recurring series by UID; an exception (RECURRENCE-ID) replaces one occurrence of its series
  const series = new Map(events.filter((ev) => ev.isRecurring() && !ev.isRecurrenceException()).map((ev) => [ev.uid, ev]));
  for (const ev of events) {
    if (series.get(ev.uid) === ev) continue;
    if (ev.isRecurrenceException() && series.has(ev.uid)) series.get(ev.uid).relateException(ev);
    else add(ev, ev.startDate, ev.endDate);
  }
  for (const ev of series.values()) {
    const it = ev.iterator();
    let n = 0;
    for (let t; (t = it.next()) && t.toJSDate() < to;) { // iterates from the series' first occurrence
      if (++n > 1e5) { console.error(`stopped expanding “${ev.summary}” after 100000 occurrences`, ev); break; }
      const o = ev.getOccurrenceDetails(t);
      add(o.item, o.startDate, o.endDate);
    }
  }
  return { name: root.getFirstPropertyValue('x-wr-calname') || name.replace(/\.ics$/i, ''), at: Date.now(), busy: out };
}

/** Add the busy times from calendar files the user picked or dropped (.ics, or Google's .zip).
 *  Re-adding a calendar replaces its earlier copy. */
async function importCalendars(files) {
  toast('Reading your calendar…');
  const added = [], problems = [];
  badZones.clear();
  for (const file of files) {
    try {
      for (const [name, text] of await icsFiles(file)) added.push(await parseIcs(name, text));
    } catch (err) {
      console.error(`couldn’t read the calendar file ${file.name}`, err);
      problems.push(`Couldn’t read ${file.name}: ${err.message}.`);
    }
  }
  if (badZones.size) problems.push(`Unknown time zone ${[...badZones].join(', ')}: those events are shown as if in yours.`);
  const kept = added.filter((c) => c.busy.length);
  setCals([...cals.filter((c) => !kept.some((k) => k.name === c.name)), ...kept]);
  store(BUSY, cals);
  if (added.length) toast(added.map((c) => `${c.name}: ${plural(c.busy.length, 'busy time').replace(/^0/, 'no')} in the coming year`).join('. '));
  if (P) markClashes(P);
  if (problems.length) toast(problems.join(' '), true);
  render();
}

/** Open (or refresh) the My calendar dialog: the calendars added in this browser. */
function openCals() {
  $('#calList').innerHTML = cals.map((c, i) => `<li><span>${esc(c.name)} <small class="muted">${plural(c.busy.length, 'busy time')}, added ${fDate.format(c.at)}</small></span>`
    + `<button class="x" data-uncal="${i}" title="Remove this calendar" aria-label="Remove">×</button></li>`).join('')
    || '<li class="muted">No calendar added yet.</li>';
  if (!$('#cals').open) $('#cals').showModal();
}

// --- events -------------------------------------------------------------------------------

addEventListener('hashchange', route);
matchMedia('(max-width: 640px)').addEventListener('change', render);
$('#publish').addEventListener('click', savePoll);
$('#cancel').addEventListener('click', () => {
  if (!P) return void (location.hash = '');
  [mode, draft] = ['poll', null];
  render();
});
$('#editBtn').addEventListener('click', () => startEdit(P.poll));
$('#editor').addEventListener('change', (e) => { // the kind of poll, and dates or weekdays
  if (e.target.name === 'kind') draft.kind = e.target.value;
  else if (e.target.name === 'weekly') setWeekly(e.target.value === 'true');
  else return;
  render();
});
$('#shareBtn').addEventListener('click', openShare);
$('#deviceBtn').addEventListener('click', () => openDevice());
$('#toDevice').addEventListener('click', () => {
  $('#share').close();
  openDevice();
});
$('#sendLink').addEventListener('click', async () => {
  try {
    await navigator.share({ title: `${P.poll.title} · Find a time`, text: 'My private link: it opens the poll as me.', url: $('#privLink').value });
  } catch (err) {
    console.error('share sheet failed', err);
    if (err.name !== 'AbortError') toast(`Couldn’t share the link: ${err.message}`, true); // AbortError: the sheet was dismissed
  }
});
$('#save').addEventListener('click', saveAnswers);
$('#ics').addEventListener('click', downloadIcs);
$('#calBtn').addEventListener('click', openCals);
$('#calPick').addEventListener('click', () => $('#calFile').click());
$('#calFile').addEventListener('change', (e) => {
  if (!e.target.files.length) return; // cancelled
  $('#cals').close(); // so the calendar and the toast show what was added
  importCalendars([...e.target.files]);
  e.target.value = '';
});
$('#calList').addEventListener('click', (e) => {
  const i = e.target.dataset.uncal;
  if (i === undefined) return;
  setCals(cals.filter((_, j) => j !== +i));
  store(BUSY, cals);
  openCals();
  render();
});

// Dropping calendar files anywhere adds them. The overlay covers the page while dragging, so its
// dragleave fires only when the drag leaves the window.
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
addEventListener('dragenter', (e) => hasFiles(e) && ($('#drop').hidden = false));
addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
$('#drop').addEventListener('dragleave', () => ($('#drop').hidden = true));
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  $('#drop').hidden = true;
  importCalendars([...e.dataTransfer.files]);
});
$('#name').addEventListener('input', (e) => { P.mine.name = e.target.value; P.dirty = true; render(); });

$('#mine').addEventListener('click', (e) => {
  const token = e.target.dataset.forget;
  if (!token || !confirm('Forget this poll in this browser? Your key for it is deleted: unless you kept your private link, you can no longer edit your answer (or the poll, if you made it).')) return;
  localStorage.removeItem(STORE + token);
  renderHome();
});

// The dialogs' Copy buttons: data-copy names the input to copy. They confirm on the button
// itself, since a toast would sit under the modal's backdrop.
const copyLink = async (e) => {
  const btn = e.target, input = btn.dataset.copy && $(`#${btn.dataset.copy}`);
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  } catch (err) {
    console.error('clipboard write failed', err);
    input.select();
    toast('Couldn’t copy automatically: the link is selected, copy it by hand.', true);
  }
};
$('#share').addEventListener('click', copyLink);
$('#device').addEventListener('click', copyLink);

// One click handler for both views: answers, slot removal, copying, final pick, navigation.
$('#board').addEventListener('click', (e) => {
  const el = e.target.closest('[data-vote], [data-dayno], [data-del], [data-src], [data-final], [data-pick], [data-goto], [data-at], [data-nav], #addSlot');
  const d = el?.dataset ?? {};
  if (d.src) copyDays(+d.src, +d.to, +d.span);
  else if (d.vote) {
    P.mine.votes[d.vote] = NEXT[P.mine.votes[d.vote] ?? ''];
    P.dirty = true;
    render();
  } else if (d.dayno) { // ✗ the whole day, or clear it again
    const ss = daySlots(+d.dayno), clear = ss.every((s) => P.mine.votes[s.id] === 'n');
    for (const s of ss) {
      if (clear) delete P.mine.votes[s.id];
      else P.mine.votes[s.id] = 'n';
    }
    P.dirty = true;
    render();
  } else if (d.del) {
    draft.slots = draft.slots.filter((s) => s.id !== d.del);
    render();
  } else if (d.final) setFinal(d.final);
  else if (d.pick) {
    const [s, e] = d.pick.split(',').map(Number);
    setFinal({ s, e });
  }
  else if (d.goto) goto(P.poll.slots.find((s) => s.id === d.goto).s);
  else if (d.at) goto(+d.at);
  else if (d.nav) {
    view = +d.nav ? dayOf(shift(view, +d.nav * days())) : dayOf(Date.now());
    render();
  } else if (el) addSlot();
});

// Editing a time in the list: the calendar follows at once; the list itself isn't re-rendered
// (that would steal focus mid-typing), so its sibling inputs are patched in place instead.
list.addEventListener('change', (e) => {
  const row = e.target.closest('.erow');
  if (!row) return;
  const slot = draft.slots.find((s) => s.id === row.dataset.slot);
  const [date, from, to] = row.querySelectorAll('select, input'); // a weekly poll's day is a <select> of weekdays
  if (!date.value || !from.value || !to.value) return; // half-typed
  const ymd = weekly() ? iso(+date.value).slice(0, 10) : date.value, s = +new Date(`${ymd}T${from.value}`);
  let end = e.target === to ? +new Date(`${ymd}T${to.value}`) : s + (slot.e - slot.s); // moving the start keeps the length
  if (end <= s) end = shift(end, 1); // an end before the start means past midnight
  Object.assign(slot, { s, e: end });
  for (const [input, v] of [[date, weekly() ? String(dayOf(s)) : iso(s).slice(0, 10)], [from, iso(s).slice(11, 16)], [to, iso(end).slice(11, 16)]]) {
    if (input !== e.target) input.value = v;
  }
  goto(s);
});

// Hovering a time in either view highlights it in both; on a grid poll, the info line says who's free.
const highlight = document.head.appendChild(document.createElement('style'));
$('#board').addEventListener('pointerover', (e) => {
  const el = e.target.closest('[data-slot], [data-cell]'), { slot, cell } = el?.dataset ?? {};
  highlight.textContent = slot ? `[data-slot="${CSS.escape(slot)}"] { --hl: var(--accent); }` : cell ? `[data-cell="${cell}"] { --hl: var(--accent); }` : '';
  if (cell && $('#ginfo')) $('#ginfo').textContent = cellInfo(+cell);
});
// A grid poll's heat map scrolls with the calendar (scroll doesn't bubble, but it can be captured).
const follow = (a, b) => b && Math.abs(a.scrollTop - b.scrollTop) >= 1 && (b.scrollTop = a.scrollTop);
cal.addEventListener('scroll', () => follow(cal, $('#heatmap')));
list.addEventListener('scroll', (e) => e.target.id === 'heatmap' && follow(e.target, cal), true);
$('#board').addEventListener('pointerleave', () => (highlight.textContent = ''));

// Grid poll: painting. A press on a cell starts a rectangle (across days and hours) that paints
// cells free, or clears them if that first cell was already free. Cells take touch drags too
// (touch-action: none); the hour gutter still scrolls.
const cellAt = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest('#cal [data-cell]');
cal.addEventListener('pointerdown', (e) => {
  const at = mode === 'poll' && !e.button && shown.find((x) => x.c === +cellAt(e)?.dataset.cell);
  if (!at) return;
  paint = { on: !isIn(P.mine.avail, at.c), a: at, b: at };
  cal.setPointerCapture(e.pointerId);
  e.preventDefault();
  renderCal();
});
cal.addEventListener('pointermove', (e) => {
  const at = paint && shown.find((x) => x.c === +cellAt(e)?.dataset.cell);
  if (!at || at.c === paint.b.c) return;
  paint.b = at;
  renderCal();
});
const endPaint = (e) => {
  if (!paint) return;
  if (e.type === 'pointerup') {
    const sel = new Set(paintSel());
    P.mine.avail = toRanges(cells(P.poll).filter((c) => (sel.has(c) ? paint.on : isIn(P.mine.avail, c))), P.poll.step * MIN);
    P.dirty = true;
  }
  paint = null;
  render();
};
cal.addEventListener('pointerup', endPaint);
cal.addEventListener('pointercancel', endPaint);

// Editor gestures. Mouse/pen: drag on empty space draws a time. Any pointer: a tap adds the
// default length at the nearest half hour (a grid poll: the day's default hours), and a block's grip resizes it. Touch drags on empty
// space stay with the browser for scrolling (touch-action: pan-y), which cancels the gesture.
// Pointer capture goes on the static #cal scroller, so it survives the re-render on every move.
cal.addEventListener('pointerdown', (e) => {
  const dayEl = e.target.closest('.day'), grip = e.target.closest('.grip');
  if (mode !== 'editor' || !dayEl || e.button || (!grip && e.target.closest('.blk'))) return;
  drag = { day: +dayEl.dataset.day, y0: e.clientY - dayEl.getBoundingClientRect().top, id: grip?.dataset.grip, grip: !!grip,
    touch: e.pointerType === 'touch' };
  if (grip || !drag.touch) {
    cal.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
cal.addEventListener('pointermove', (e) => {
  if (!drag || (drag.touch && !drag.grip)) return;
  const y = e.clientY - cal.querySelector(`.day[data-day="${drag.day}"]`).getBoundingClientRect().top;
  if (drag.grip) {
    const slot = draft.slots.find((s) => s.id === drag.id);
    slot.e = Math.max(slot.s + 15 * MIN, tAt(drag.day, y, 15));
  } else {
    if (!drag.id && Math.abs(y - drag.y0) < 6) return; // not a drag yet
    const s = tAt(drag.day, Math.min(y, drag.y0), 15, Math.floor);
    const end = Math.max(tAt(drag.day, Math.max(y, drag.y0), 15, Math.ceil), s + 15 * MIN);
    if (drag.id) Object.assign(draft.slots.find((x) => x.id === drag.id), { s, e: end });
    else draft.slots.push({ id: (drag.id = newId()), s, e: end });
  }
  render();
});
const endDrag = (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (e.type === 'pointercancel') {
    if (!d.grip && d.id) draft.slots = draft.slots.filter((s) => s.id !== d.id);
  } else if (!d.grip && !d.id) { // a tap: a grid poll offers that day's default hours
    const s = tAt(d.day, d.y0, 30, Math.floor), w = isGrid() ? dayWindow(d.day) : { s, e: s + $('#dur').value * MIN };
    if (w && draft.slots.some((x) => x.s === w.s && x.e === w.e)) toast(`${dayName(w.s)} already offers ${fTime.formatRange(w.s, w.e)}`, true);
    else if (w) draft.slots.push({ id: newId(), ...w });
  }
  render();
};
cal.addEventListener('pointerup', endDrag);
cal.addEventListener('pointercancel', endDrag);

purgeExpired();
setCals(load(BUSY, []));
route();
