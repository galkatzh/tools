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
const STORE = 'schedule:', NAME = 'schedule.name'; // localStorage: one entry per poll opened; last name used
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
const dayOf = (t) => new Date(t).setHours(0, 0, 0, 0);
const shift = (t, days) => { const d = new Date(t); return d.setDate(d.getDate() + days); }; // same wall-clock time
const weekOf = (t) => dayOf(shift(t, -((new Date(t).getDay() - FIRST_DAY + 7) % 7)));
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
  toast.timer = setTimeout(() => (t.className = 'toast'), isError ? 8000 : 2500);
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
function cleanPoll(x) {
  const slots = (Array.isArray(x.slots) ? x.slots : [])
    .filter((s) => typeof s?.id === 'string' && ID.test(s.id) && Number.isFinite(s.s) && Number.isFinite(s.e) && s.s < s.e)
    .slice(0, 500).map(({ id, s, e }) => ({ id, s, e }));
  if (!slots.length) throw new Error('poll has no valid times');
  return { title: String(x.title ?? '').slice(0, 120), notes: String(x.notes ?? '').slice(0, 2000),
    tz: String(x.tz ?? '').slice(0, 64), slots, final: slots.some((s) => s.id === x.final) ? x.final : null,
    expire: EXPIRE.includes(x.expire) ? x.expire : 0 };
}
function cleanVote(x) {
  return { name: String(x.name ?? '').slice(0, 60) || 'Anonymous',
    votes: Object.fromEntries(Object.entries(x.votes ?? {}).filter(([id, v]) => ID.test(id) && /^[ymn]$/.test(v))) };
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
    mine: { name: load(NAME, ''), votes: {} }, dirty: false };
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

const slots = () => [...((mode === 'editor' ? draft : P?.poll)?.slots ?? [])].sort((a, b) => a.s - b.s);
const others = () => [...P.votes].filter(([pk]) => pk !== P.me).map(([, v]) => v).sort((a, b) => a.name.localeCompare(b.name));

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
  $('#tz').textContent = `Times are in your time zone, ${TZ}${poll.tz && poll.tz !== TZ ? ` (the organizer is in ${poll.tz})` : ''}.`
    + (p.exp ? ` The poll and all answers are deleted automatically on ${fFull.format(p.exp * 1000)}.` : '');
  $('#editBtn').hidden = p.me !== p.org;
  const f = poll.slots.find((s) => s.id === poll.final);
  $('#final').hidden = !f;
  if (f) {
    $('#finalTime').textContent = fFull.formatRange(f.s, f.e);
    $('#gcal').href = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(poll.title)}`
      + `&dates=${utc(f.s)}/${utc(f.e)}&details=${encodeURIComponent(poll.notes)}`;
  }
  $('#save').disabled = !p.dirty;
  $('#saveState').textContent = p.dirty ? 'Unsaved' : p.votes.has(p.me) ? 'Saved ✓' : '';
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

function renderCal() {
  const n = days();
  if (n === 7) view = weekOf(view);
  const cols = Array.from({ length: n }, (_, i) => dayOf(shift(view, i)));
  $('#range').textContent = fRange.formatRange(cols[0], cols[n - 1]);
  const all = slots(), t = mode === 'poll' && tallies(), today = dayOf(Date.now());
  // editor: an empty day / week offers to copy the latest earlier day / week that has times
  const copyFrom = (t0, unit, span) => mode === 'editor' && !all.some((s) => s.s >= t0 && s.s < dayOf(shift(t0, span)))
    && Math.max(...all.map((s) => unit(s.s)).filter((u) => u < t0));
  const week = weekOf(view), srcWeek = copyFrom(week, weekOf, 7), weekBtn = $('#copyWeek');
  weekBtn.hidden = !Number.isFinite(srcWeek);
  if (!weekBtn.hidden) {
    weekBtn.textContent = `⧉ Copy week of ${fDate.format(srcWeek)}`;
    Object.assign(weekBtn.dataset, { src: srcWeek, to: week });
  }
  const head = (d, src = copyFrom(d, dayOf, 1)) => `<div class="dh${d === today ? ' today' : ''}">${fHead.format(d)}${Number.isFinite(src)
    ? `<button class="copy" data-src="${src}" data-to="${d}" data-span="1" title="Copy the times of ${fDay.format(src)}">⧉ ${fHead.format(src)}</button>` : ''}</div>`;
  let html = `<div class="cal-grid" style="--days:${n}"><div class="corner"></div>${cols.map((d) => head(d)).join('')}`
    + `<div class="gutter">${Array.from({ length: 23 }, (_, h) => `<span style="top:${(h + 1) * HH}px">${fHour.format(new Date(view).setHours(h + 1))}</span>`).join('')}</div>`;
  for (const day of cols) {
    const next = dayOf(shift(day, 1));
    // a slot crossing midnight (possible in another time zone) shows as one segment per day
    const segs = all.filter((s) => s.s < next && s.e > day).map((s) => ({ slot: s, s: Math.max(s.s, day), e: Math.min(s.e, next) }));
    lanes(segs);
    html += `<div class="day${day === today ? ' today' : ''}" data-day="${day}">${segs.map((g) => block(g, next, t)).join('')}</div>`;
  }
  const top = cal.scrollTop;
  cal.innerHTML = `${html}</div>`;
  cal.scrollTop = top;
}

function block(g, next, t) {
  const s = g.slot, top = yOf(g.s, next);
  const style = `top:${top}px;height:${Math.max(yOf(g.e, next) - top, HH / 4)}px;`
    + `left:calc(${(g.lane / g.lanes) * 100}% + 1px);width:calc(${100 / g.lanes}% - 3px)`;
  const range = fTime.formatRange(s.s, s.e);
  if (mode === 'editor') {
    return `<div class="blk edit" data-slot="${s.id}" style="${style}"><span>${range}</span>`
      + `<button class="x" data-del="${s.id}" aria-label="Remove">×</button>`
      + `${g.e === s.e ? `<div class="grip" data-grip="${s.id}"></div>` : ''}</div>`;
  }
  const v = P.mine.votes[s.id] ?? '', x = t.get(s.id);
  return `<button class="blk v-${v || 'none'}${x.best ? ' best' : ''}${P.poll.final === s.id ? ' final' : ''}" data-slot="${s.id}"`
    + ` data-vote="${s.id}" style="${style}" title="${range}: ${x.y} yes, ${x.m} if need be"><span>${fTime.format(s.s)} ${MARK[v]}</span>`
    + `<small>${x.best ? '★ ' : ''}${x.y}✓${x.m ? ` ${x.m}(✓)` : ''}</small></button>`;
}

function renderList() {
  const all = slots();
  if (mode === 'editor') {
    list.innerHTML = `<div class="erows">${all.map((s) => `<div class="erow" data-slot="${s.id}">
      <input type="date" value="${iso(s.s).slice(0, 10)}" required>
      <input type="time" value="${iso(s.s).slice(11, 16)}" step="900" required><span>–</span>
      <input type="time" value="${iso(s.e).slice(11, 16)}" step="900" required>
      <button class="x" data-del="${s.id}" aria-label="Remove">×</button></div>`).join('')
      || '<p class="muted">No times yet.</p>'}</div><button id="addSlot">＋ Add time</button>`;
    return;
  }
  const ppl = others(), t = tallies(), admin = P.me === P.org;
  let html = `<table class="votes"><thead><tr><th class="t">${ppl.length + (P.votes.has(P.me) ? 1 : 0)} answered</th><th>Total</th>`
    + `<th class="you">${esc(P.mine.name.trim() || 'You')}</th>${ppl.map((p) => `<th title="${esc(p.name)}">${esc(p.name)}</th>`).join('')}</tr></thead><tbody>`;
  let lastDay;
  for (const s of all) {
    if (dayOf(s.s) !== lastDay) {
      lastDay = dayOf(s.s);
      html += `<tr class="dayrow"><th colspan="${3 + ppl.length}"><span>${fDay.format(s.s)}</span></th></tr>`;
    }
    const x = t.get(s.id), v = P.mine.votes[s.id] ?? '', final = P.poll.final === s.id;
    html += `<tr data-slot="${s.id}" class="${x.best ? 'best' : ''}${final ? ' final' : ''}">`
      + `<th class="t"><button class="link" data-goto="${s.id}" title="Show in calendar">${fTime.formatRange(s.s, s.e)}</button>${x.best ? ' ★' : ''}${final ? ' 📌' : ''}</th>`
      + `<td class="tally">${x.y}✓${x.m ? ` ${x.m}(✓)` : ''}${admin ? ` <button class="pin" data-final="${s.id}" title="${final ? 'Unpick' : 'Pick as the final time'}">📌</button>` : ''}</td>`
      + `<td class="you"><button class="v v-${v || 'none'}" data-vote="${s.id}" aria-label="Your answer">${MARK[v]}</button></td>`
      + ppl.map((p) => `<td class="v v-${p.votes[s.id] || 'none'}">${MARK[p.votes[s.id] ?? '']}</td>`).join('') + '</tr>';
  }
  list.innerHTML = `${html}</tbody></table>`;
}

/** Bring time t into view in the calendar. */
function goto(t) {
  view = dayOf(t);
  renderCal();
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
  draft = structuredClone(poll ?? { title: '', notes: '', slots: [], final: null, expire: 0 });
  $('#eTitle').value = draft.title;
  $('#eNotes').value = draft.notes;
  $('#expire').value = draft.expire;
  $('#publish').textContent = poll ? 'Save changes' : 'Create poll';
  mode = 'editor';
  render();
  goto(slots()[0]?.s ?? new Date().setHours(8, 0, 0, 0));
}

function addSlot() {
  // the day after the latest time, same hours; or tomorrow at 9:00
  const last = slots().at(-1);
  const s = last ? shift(last.s, 1) : new Date(shift(Date.now(), 1)).setHours(9, 0, 0, 0);
  draft.slots.push({ id: newId(), s, e: s + (last ? last.e - last.s : $('#dur').value * MIN) });
  render();
  goto(s);
}

/** Duplicate the times starting in the `span` days from `src` onto the days from `to`, at the
 *  same wall-clock hours (so a copy across a DST change keeps 10:00 at 10:00). */
function copyDays(src, to, span) {
  const k = Math.round((to - src) / (1440 * MIN)), end = dayOf(shift(src, span));
  for (const s of draft.slots.filter((x) => x.s >= src && x.s < end)) draft.slots.push({ id: newId(), s: shift(s.s, k), e: shift(s.e, k) });
  render();
}

async function savePoll() {
  Object.assign(draft, { title: $('#eTitle').value.trim(), notes: $('#eNotes').value.trim(), tz: TZ, expire: +$('#expire').value });
  if (!draft.title) { $('#eTitle').focus(); return toast('Give the poll a title first', true); }
  if (!draft.slots.length) return toast('Add at least one time', true);
  draft.slots.sort((a, b) => a.s - b.s);
  if (!draft.slots.some((s) => s.id === draft.final)) draft.final = null;
  // the expiry follows the last time, so editing the times moves it
  const exp = draft.expire ? Math.ceil(shift(Math.max(...draft.slots.map((s) => s.e)), draft.expire) / 1000) : null;
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
  const sent = JSON.stringify(P.mine);
  $('#save').disabled = true;
  $('#saveState').textContent = 'Saving…';
  try {
    const n = await publish(P.dVote, { ...P.mine, name });
    P.dirty = JSON.stringify(P.mine) !== sent; // still dirty if they kept tapping while it saved
    toast(`Saved to ${n} relays`);
  } finally {
    render();
  }
}

async function setFinal(id) {
  const final = P.poll.final === id ? null : id;
  const n = await publish(P.dPoll, { ...P.poll, final });
  toast(`${final ? 'Final time picked' : 'Final time cleared'} (saved to ${n} relays)`);
}

function openShare() {
  const base = `${location.href.split('#')[0]}#`;
  $('#shareLink').value = base + P.share;
  $('#privLink').value = base + b64u(new Uint8Array([...unb64u(P.share), ...P.sk]));
  $('#privHint').textContent = P.me === P.org
    ? 'Opens the poll as the organizer, to edit it from another device. Anyone holding it can change the poll: keep it to yourself.'
    : 'Opens the poll as you, to change your answers from another device. Keep it to yourself.';
  $('#share').showModal();
}

function downloadIcs() {
  const poll = P.poll, f = poll.slots.find((s) => s.id === poll.final);
  const text = (s) => s.replace(/[\\;,]/g, '\\$&').replace(/\r?\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tools//find-a-time//EN', 'BEGIN:VEVENT',
    `UID:${P.dPoll.slice(0, 32)}@find-a-time`, `DTSTAMP:${utc(Date.now())}`, `DTSTART:${utc(f.s)}`, `DTEND:${utc(f.e)}`,
    `SUMMARY:${text(poll.title)}`, `DESCRIPTION:${text(poll.notes)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })),
    download: `${poll.title.replace(/[^\w -]+/g, '').trim() || 'event'}.ics`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
$('#shareBtn').addEventListener('click', openShare);
$('#save').addEventListener('click', saveAnswers);
$('#ics').addEventListener('click', downloadIcs);
$('#name').addEventListener('input', (e) => { P.mine.name = e.target.value; P.dirty = true; render(); });

$('#mine').addEventListener('click', (e) => {
  const token = e.target.dataset.forget;
  if (!token || !confirm('Forget this poll in this browser? Your key for it is deleted: unless you kept your private link, you can no longer edit your answer (or the poll, if you made it).')) return;
  localStorage.removeItem(STORE + token);
  renderHome();
});

$('#share').addEventListener('click', async (e) => {
  const input = e.target.dataset.copy && $(`#${e.target.dataset.copy}`);
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    toast('Copied');
  } catch (err) {
    console.error('clipboard write failed', err);
    input.select();
    toast('Couldn’t copy automatically: the link is selected, copy it by hand.', true);
  }
});

// One click handler for both views: answers, slot removal, copying, final pick, navigation.
$('#board').addEventListener('click', (e) => {
  const el = e.target.closest('[data-vote], [data-del], [data-src], [data-final], [data-goto], [data-nav], #addSlot');
  const d = el?.dataset ?? {};
  if (d.src) copyDays(+d.src, +d.to, +d.span);
  else if (d.vote) {
    P.mine.votes[d.vote] = NEXT[P.mine.votes[d.vote] ?? ''];
    P.dirty = true;
    render();
  } else if (d.del) {
    draft.slots = draft.slots.filter((s) => s.id !== d.del);
    render();
  } else if (d.final) setFinal(d.final);
  else if (d.goto) goto(P.poll.slots.find((s) => s.id === d.goto).s);
  else if (d.nav) {
    view = +d.nav ? dayOf(shift(view, +d.nav * days())) : dayOf(Date.now());
    renderCal();
  } else if (el) addSlot();
});

// Editing a time in the list: the calendar follows at once; the list itself isn't re-rendered
// (that would steal focus mid-typing), so its sibling inputs are patched in place instead.
list.addEventListener('change', (e) => {
  const row = e.target.closest('.erow');
  if (!row) return;
  const slot = draft.slots.find((s) => s.id === row.dataset.slot);
  const [date, from, to] = row.querySelectorAll('input');
  if (!date.value || !from.value || !to.value) return; // half-typed
  const s = +new Date(`${date.value}T${from.value}`);
  let end = e.target === to ? +new Date(`${date.value}T${to.value}`) : s + (slot.e - slot.s); // moving the start keeps the length
  if (end <= s) end = shift(end, 1); // an end before the start means past midnight
  Object.assign(slot, { s, e: end });
  for (const [input, v] of [[date, iso(s).slice(0, 10)], [from, iso(s).slice(11, 16)], [to, iso(end).slice(11, 16)]]) {
    if (input !== e.target) input.value = v;
  }
  goto(s);
});

// Hovering a time in either view highlights it in both.
const highlight = document.head.appendChild(document.createElement('style'));
$('#board').addEventListener('pointerover', (e) => {
  const id = e.target.closest('[data-slot]')?.dataset.slot;
  highlight.textContent = id ? `[data-slot="${CSS.escape(id)}"] { --hl: var(--accent); }` : '';
});
$('#board').addEventListener('pointerleave', () => (highlight.textContent = ''));

// Editor gestures. Mouse/pen: drag on empty space draws a time. Any pointer: a tap adds the
// default length at the nearest half hour, and a block's grip resizes it. Touch drags on empty
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
  } else if (!d.grip && !d.id) {
    const s = tAt(d.day, d.y0, 30, Math.floor);
    draft.slots.push({ id: newId(), s, e: s + $('#dur').value * MIN });
  }
  render();
};
cal.addEventListener('pointerup', endDrag);
cal.addEventListener('pointercancel', endDrag);

purgeExpired();
route();
