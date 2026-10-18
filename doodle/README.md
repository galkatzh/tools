# Find a time

A Doodle-style scheduling poll with no server and no accounts. Polls live on public
**Nostr relays**, end-to-end encrypted, and the invite link carries the key.

- **Organizer**: give the poll a title, then pick times on a **weekly calendar** (click for
  the default length, drag to draw a range, drag a block's bottom edge to resize, × to remove)
  or in the **list** next to it (date / start / end inputs, ＋ Add time). Both views edit the
  same slots, so a change in one shows up in the other immediately. Hovering a time highlights
  it in both. **Create poll** publishes it and shows the invite link.
- **Participants**: open the link, type a name, and tap times in the calendar *or* the
  Doodle-style table to cycle ✓ yes → (✓) if need be → ✗ no. **Save answers** publishes
  them. Everyone's answers, the per-time totals and the ★ leading time update live.
- The organizer can **edit the poll** and **📌 pick the final time**. Everyone then sees a
  banner with an `.ics` download and a Google Calendar link.
- Times are stored as UTC instants and shown in each viewer's own time zone, with a note when
  the organizer's zone differs. Weeks start on the locale's first day; phones get a 3-day view.

## How it works

**Link format.** `#<token>` with token = base64url(`orgPub ‖ secret [‖ sk]`):

| part | size | role |
|---|---|---|
| `orgPub` | 32 B | the organizer's Nostr pubkey; only poll events signed by it are trusted |
| `secret` | 16 B | HKDF-SHA256 → an AES-256-GCM key, plus the two opaque `d` tags relays filter on |
| `sk` | 32 B | optional: makes it a **private link** that opens the poll *as you* on another device. The organizer's private link also allows editing the poll. |

The fragment never reaches a server. When a private link is opened, its key is moved into
`localStorage` and stripped from the address bar.

**Events.** Everything is NIP-78 app data (kind `30078`), which relays treat as
*addressable*: they keep only the newest event per (pubkey, `d`). The organizer's poll
`{title, notes, tz, slots:[{id,s,e}], final}` sits under `dPoll`. Each participant's
`{name, votes:{slotId:'y'|'m'|'n'}}` sits under `dVote`, signed by a random per-poll key that
stays in that browser. Saving again replaces your previous answer. The content is
`base64url(iv ‖ AES-GCM(json))` with the author's pubkey as associated data, so copying a
ciphertext into an event signed by someone else fails to decrypt. **Relays see only
ciphertext, the opaque tags, random pubkeys and timestamps.** Decrypted payloads are
validated and HTML-escaped before rendering, because anyone with the link can write.

**Relays.** Six public relays (`RELAYS` in `app.js`; `window.DOODLE_RELAYS` overrides them
for tests or self-hosting). A single live subscription streams the poll and all answers.
Saving finishes as soon as one relay stores the event and reports how many have so far
(errors per relay are logged). The header dot shows how many relays are connected and turns
red when none are.

**Self-healing.** Public relays prune and drop events. Signed events can be re-published by
anyone, so after the initial sync each visitor hands every event it knows to the connected
relays that didn't return it. Each browser also keeps the signed events of the polls it
opened. If every relay has lost a poll, the next visit from someone who has it re-publishes
the poll, and it reaches the page back through the relay (never displayed straight from the
cache). If no copy exists anywhere, the page says the poll wasn't found.

## Honest limits

- Your answer is tied to the key in this browser. To edit it from another device, use your
  **private link** (🔗 Share). "Forget" on the home page deletes that key.
- Anyone with the invite link can read the poll and add answers under any name. That's
  Doodle's trust model too. Nobody can change *your* answer without your key.
- There is no deletion: relays keep the latest encrypted versions until they prune them.
- Durability is whatever the six public relays (plus self-healing) provide. That's fine for
  a poll that lives for weeks, not an archive.

## Testing

E2E-tested with Playwright against a minimal local NIP-01 relay (addressable-event
semantics, signature checks). The tests cover: creating times by click, drag and touch tap;
overlapping times laid out side by side; list edits moving and resizing calendar blocks and
the reverse; answering in either view; live sync between browsers; the final pick with
`.ics` export; reload persistence; the private link on a second device; ciphertext-only
relay storage; re-seeding a relay that missed events; restoring from the cache after a relay
was wiped; and the not-found and unreachable error states. Also checked live against the
default public relays.
