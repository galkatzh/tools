// Read/write the scheduling metadata comment appended to each card.
//
// Format (one comment per generated card, positionally anchored):
//   <!--SR:fsrs;1;d=2026-06-01T08:00:00.000Z;s=12.34;D=5.67;r=4;l=1;st=2;lr=...-->
//     d  due (ISO 8601 timestamp)     s  stability         D  difficulty
//     r  reps     l  lapses           st state (0..3)      lr last review
//
// Legacy Obsidian SM-2 comments (<!--SR:!due,interval,ease-->) are parsed
// best-effort and migrated to FSRS on the next review.

const SR_RE = /[ \t]*<!--\s*SR:(.*?)-->/g;

/** Strip every SR comment from a text block, returning the clean text + payloads. */
export function stripSR(text) {
  const payloads = [];
  const clean = text.replace(SR_RE, (_, payload) => {
    payloads.push(payload.trim());
    return '';
  });
  // Drop whitespace left behind on now-empty trailing lines.
  return { clean: clean.replace(/[ \t]+$/gm, '').replace(/\s+$/, ''), payloads };
}

/**
 * Strip SR metadata for display in the deck editor: drop whole lines that hold
 * only SR comments, plus any inline (legacy) ones, leaving no blank-line gaps.
 */
export function stripSRLines(text) {
  return text
    .replace(/^[ \t]*(?:<!--\s*SR:.*?-->[ \t]*)+\r?\n/gm, '')
    .replace(/[ \t]*<!--\s*SR:.*?-->/g, '');
}

/** Parse one SR comment payload into our compact scheduling object, or null. */
export function parsePayload(payload) {
  payload = payload.trim();
  if (payload.startsWith('fsrs;')) return parseFsrs(payload);
  if (payload.startsWith('!')) return parseLegacy(payload);
  console.warn('Unrecognized SR comment payload, ignoring:', payload);
  return null;
}

function parseFsrs(payload) {
  const kv = {};
  // parts: ['fsrs', version, 'k=v', ...]
  for (const part of payload.split(';').slice(2)) {
    const eq = part.indexOf('=');
    if (eq !== -1) kv[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return {
    due: kv.d,
    stability: parseFloat(kv.s),
    difficulty: parseFloat(kv.D),
    reps: parseInt(kv.r, 10) || 0,
    lapses: parseInt(kv.l, 10) || 0,
    state: parseInt(kv.st, 10) || 0,
    last_review: kv.lr || null,
  };
}

/** Legacy SM-2: !due,interval,ease — only the due date carries over. */
function parseLegacy(payload) {
  const [due] = payload.slice(1).split(',');
  return {
    due,
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    state: 0,
    last_review: null,
  };
}

/** Serialize a scheduling object back into an SR comment string. */
export function serialize(sr) {
  const r2 = (n) => Math.round(n * 100) / 100;
  return (
    `<!--SR:fsrs;1;d=${sr.due};s=${r2(sr.stability)};D=${r2(sr.difficulty)};` +
    `r=${sr.reps};l=${sr.lapses};st=${sr.state};lr=${sr.last_review}-->`
  );
}
