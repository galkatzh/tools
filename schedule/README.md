# Find a time

A Doodle-style scheduling poll with no server and no accounts. Polls live on public
**Nostr relays**, end-to-end encrypted, and the invite link carries the key.

- **Organizer**: give the poll a title, then pick times on a **weekly calendar** (click for
  the default length, drag to draw a range, drag a block's bottom edge to resize, × to remove)
  or in the **list** next to it (date / start / end inputs, ＋ Add time). Each day keeps a free strip on
  the right of its times, so a click there adds a time that overlaps another one (13:30 inside a
  13:00–14:00 option, say). Both views edit the
  same slots, so a change in one shows up in the other immediately. Hovering a time highlights
  it in both. An empty day's header offers **⧉ copy** of the latest earlier day with times,
  and an empty week offers **⧉ Copy week of …** in the toolbar. Copies keep the wall-clock
  hours, even across a DST change. **Create poll** publishes it and shows the invite link.
- **Participants**: open the link, type a name, and tap times in the calendar *or* the
  Doodle-style table to cycle ✓ yes → (✓) if need be → ✗ no. **✗ all day**, in a day's header
  or its row in the table, answers ✗ to every time that day (press it again to clear them).
  **Save answers** publishes them. Everyone's answers, the per-time totals and the ★ leading
  time update live.
- **📱 Edit on another device**: right after your first save, the page shows your **private
  link** as a QR code to scan with your phone, a link to copy, and (where the browser has one)
  the share sheet to send it to yourself. Opening it elsewhere opens the poll as you, with your
  answers, and saving there updates the same answer. The button stays next to **Save answers**,
  and organizers also reach it from 🔗 Share (their private link also lets them edit the poll).
- **📅 My calendar** (organizers and participants): add your own calendar file, picked or dropped
  anywhere on the page, to see your events hatched behind the poll's times. Times that clash get
  a ⚠, and when you answer, the ones you haven't answered yet are marked ✗ for you (save to
  send them). The file never leaves the browser. It's remembered for every poll you open there,
  until you remove it.
- The organizer can **edit the poll** and **📌 pick the final time**. Everyone then sees a
  banner with an `.ics` download and a Google Calendar link.
- **Delete automatically**: 1 month after the last time (default), 1 day, 1 week, or never.
  The poll and every answer then carry a NIP-40 expiration, relays drop them, open pages
  close the poll, and each browser forgets it (title and keys included).
- Times are stored as UTC instants and shown in each viewer's own time zone, with a note when
  the organizer's zone differs. Weeks start on the locale's first day; phones get a 3-day view.

## How it works

**Link format.** `#<token>` with token = base64url(`orgPub ‖ secret [‖ sk]`):

| part | size | role |
|---|---|---|
| `orgPub` | 32 B | the organizer's Nostr pubkey; only poll events signed by it are trusted |
| `secret` | 16 B | HKDF-SHA256 → the poll's NIP-44 key, plus the two opaque `d` tags relays filter on |
| `sk` | 32 B | optional: makes it a **private link** that opens the poll *as you* on another device. The organizer's private link also allows editing the poll. |

The fragment never reaches a server. When a private link is opened, its key is moved into
`localStorage` and stripped from the address bar.

**Events.** Kind `30827`, an unregistered kind in NIP-01's *addressable* range: relays keep
only the newest event per (kind, pubkey, `d`). Ties go to the lowest id, as NIP-01 says, and
the client resolves versions the same way. The organizer's poll
`{title, notes, tz, slots:[{id,s,e}], final, expire}` sits under `dPoll`. Each participant's
`{name, votes:{slotId:'y'|'m'|'n'}}` sits under `dVote`, signed by a random per-poll key that
stays in that browser. Saving again replaces your previous answer. **Relays see only
ciphertext, the opaque tags, random pubkeys and timestamps.** Decrypted payloads are
validated and HTML-escaped before rendering, because anyone with the link can write.

**Encryption.** The content is **NIP-44 v2**, encrypted to a poll keypair derived from the
link secret, the same "encrypt to yourself" pattern NIP-51 uses for private items. Any NIP-44
implementation can decrypt it given that key, and NIP-44's padding hides exact lengths.
NIP-44 has no associated data, so the plaintext names its author (`by`), and the client
drops any event whose signer doesn't match. That way nobody can re-sign someone else's
ciphertext as their own answer.

**Nostr compliance notes.**
- *Why not NIP-78 (kind 30078)?* NIP-78 is for data private to its author. It asks relays to
  require NIP-42 AUTH and to serve those events only to their author, which would hide the
  organizer's poll from participants. Shared app data belongs in a dedicated kind, as NIP-78
  itself says.
- *No `alt` tag:* NIP-31 is now marked "unrecommended", and the tag would leak what the
  events are.
- *Expiry (NIP-40):* expiring events go only to relays whose NIP-11 document lists `40` in
  `supported_nips`, as NIP-40 asks of clients. If none does, saving fails with an error
  rather than producing a poll that never expires. Expired events are ignored, never
  re-seeded, and purged from local storage. Answers expire with the poll. If the organizer
  changes the expiry, each participant's client re-signs that participant's answer with the
  new expiry on their next visit (only its author can).

**Relays.** Six public relays (`RELAYS` in `app.js`; `window.SCHEDULE_RELAYS` overrides them
for tests or self-hosting). The pool keeps one websocket per relay (NIP-01), and a single
live subscription streams the poll and all answers.
Saving finishes as soon as one relay stores the event and reports how many have so far
(errors per relay are logged). The header dot shows how many relays are connected and turns
red when none are.

**Self-healing.** Public relays prune and drop events. Signed events can be re-published by
anyone, so after the initial sync each visitor hands every event it knows to the connected
relays that didn't return it. Each browser also keeps the signed events of the polls it
opened. If every relay has lost a poll, the next visit from someone who has it re-publishes
the poll, and it reaches the page back through the relay (never displayed straight from the
cache). If no copy exists anywhere, the page says the poll wasn't found.

**Your calendar.** Calendar servers don't let other sites fetch their iCal feeds (Google's, for
one, sends no CORS headers), and the public CORS proxies are either down, rate-limited or
asking for API keys. A proxy would also see the whole calendar. So the app reads an exported
file instead: an `.ics`, or the `.zip` Google Calendar exports (one `.ics` per calendar, unpacked
with [fflate](https://github.com/101arrowz/fflate)). [ical.js](https://github.com/kewisch/ical.js)
parses it, and both libraries load only when a file is added. Recurring events are expanded from
yesterday to a year ahead, with EXDATEs and moved occurrences (RECURRENCE-ID) applied. Free
(`TRANSP:TRANSPARENT`), cancelled and declined events don't count as busy. A declined event is
one where the attendee whose address names the calendar (as Google names your main one) has
`PARTSTAT=DECLINED`. Times use the file's VTIMEZONEs; a TZID the file doesn't define is resolved
as an IANA zone with `Intl`, and an unknown one is reported. A day that's busy from midnight to
midnight (a vacation, a trip) is shaded and named in its header rather than drawn as a block.
The busy times, with their titles, are stored in `localStorage` (`schedule.busy`) and are never
published. Clashing times are marked ✗ only after the initial sync, so answers you saved earlier
(perhaps on another device) load first and are never overwritten.

## Honest limits

- Your answer is tied to the key in this browser. To edit it from another device, take your
  **private link** along (📱 Edit on another device). "Forget" on the home page deletes that key.
  Anyone holding the private link can answer as you (and the organizer's can change the poll),
  so keep it to yourself.
- Anyone with the invite link can read the poll and add answers under any name. That's
  Doodle's trust model too. Nobody can change *your* answer without your key.
- Without automatic deletion, relays keep the latest encrypted versions until they prune
  them. With it, NIP-40 is a request rather than a guarantee: relays SHOULD delete expired
  events, and anyone could have copied the ciphertext before then (the key is in the link).
- After the organizer changes the expiry, an answer keeps its old expiry until its author
  opens the poll again. Answers from people who never return can therefore expire earlier
  or later than the poll.
- An added calendar is a snapshot: add the file again when your calendar changes (the dialog
  shows when each one was added). Phones can't easily export a calendar, so this works best on a
  computer. Declined invitations are only recognized in Google's files.
- Durability is whatever the six public relays (plus self-healing) provide. That's fine for
  a poll that lives for weeks, not an archive.

## Testing

E2E-tested with Playwright against a minimal local relay (NIP-01 addressable semantics and
signature checks, a NIP-11 document with CORS, NIP-40, and a variant without NIP-40). The
tests cover: creating times by click, drag and touch tap;
overlapping times laid out side by side; list edits moving and resizing calendar blocks and
the reverse; answering in either view; live sync between browsers; the final pick with
`.ics` export; reload persistence; the private link on a second device; ciphertext-only
relay storage; re-seeding a relay that missed events; restoring from the cache after a relay
was wiped; and the not-found and unreachable error states. They also cover NIP-44 interop: an
independent Node implementation decrypts the relay's copy from the link secret. On the
expiry side they check:
- the expiration tags on the poll and on answers;
- that nothing reaches a relay without NIP-40;
- re-signing answers when the expiry changes;
- that a client ignores expired events and an open page closes the poll at expiry;
- the purge from local storage;
- refusal when every time is already past, or when no relay supports NIP-40.

For the calendar features they check:
- clicks and drags in the free strip adding overlapping times (mouse and touch), while clicks
  on a block add nothing;
- ✗ all day from the calendar header and from the table, and pressing it again to clear;
- adding a calendar from the dialog and by dropping Google's `.zip`;
- the parsed busy times: recurring events with a moved occurrence, a VTIMEZONE zone and an
  undefined TZID, with free, cancelled and declined events left out;
- clash marks, auto-✗ of unanswered times only, nothing re-marked after saving and reloading;
- whole busy days shaded, escaped titles, loud errors for non-calendar files and unknown zones,
  and removing a calendar.

For taking answers to another device they check: the QR code decodes to the private link; the
first save opens the dialog and later ones don't; copying; the share sheet, and dismissing it
quietly; a second device opening as you and editing the same answer, followed live by the first
device and the organizer; and a visible message when the QR library can't load.

Also checked live against the default public relays: they accept the custom kind with
expiration tags and serve it back.
