// FSRS scheduling, wrapping the ts-fsrs library.

import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
} from 'https://cdn.jsdelivr.net/npm/ts-fsrs@5/+esm';

const f = fsrs(generatorParameters({ enable_fuzz: true }));

const RATINGS = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

/** Convert our compact SR object (or null) into a ts-fsrs Card. */
function toFsrsCard(sr) {
  // Start from an empty card so every field ts-fsrs expects is present.
  const c = createEmptyCard(new Date());
  if (!sr || sr.stability == null) {
    // New card, or a legacy comment without FSRS state.
    if (sr && sr.due) c.due = new Date(sr.due);
    return c;
  }
  return {
    ...c,
    due: new Date(sr.due),
    stability: sr.stability,
    difficulty: sr.difficulty,
    reps: sr.reps,
    lapses: sr.lapses,
    state: sr.state,
    last_review: sr.last_review ? new Date(sr.last_review) : undefined,
  };
}

/** Convert a ts-fsrs Card back into our compact SR object. */
function fromFsrsCard(c) {
  return {
    due: isoDate(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: isoDate(c.last_review || new Date()),
  };
}

/** Scheduling state for a brand-new, never-reviewed card. */
export function emptyState(now = new Date()) {
  return fromFsrsCard(createEmptyCard(now));
}

/** True when a card is due (never-reviewed cards are always due). */
export function isDue(sr, now = new Date()) {
  if (!sr) return true;
  return new Date(sr.due) <= now;
}

/** Apply a rating ('again'|'hard'|'good'|'easy'), returning the new SR object. */
export function rate(sr, ratingKey, now = new Date()) {
  const log = f.repeat(toFsrsCard(sr), now);
  return fromFsrsCard(log[RATINGS[ratingKey]].card);
}

/** Human-readable next interval for each rating, e.g. { good: '3d', ... }. */
export function preview(sr, now = new Date()) {
  const log = f.repeat(toFsrsCard(sr), now);
  const out = {};
  for (const [key, rating] of Object.entries(RATINGS)) {
    out[key] = humanInterval(log[rating].card.due, now);
  }
  return out;
}

function humanInterval(due, now) {
  const mins = Math.round((new Date(due) - now) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}
