// Daily review-time tracking and reminder notifications.
//
// Tracks how many seconds the user has actively spent in study sessions today
// (counted only while the tab is visible). While the page is open, fires a
// browser notification every 5 minutes until that total reaches 5 minutes.
// Stops nudging once the daily goal is met.

const KEY_TIME = 'srs_daily_time';
const GOAL_SECONDS = 5 * 60;
const NOTIFY_INTERVAL_MS = 5 * 60 * 1000;

let getEnabled = () => false;
let tracking = false;
let tickerStart = 0; // ms timestamp; 0 means not currently accruing
let intervalId = null;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadDaily() {
  try {
    const raw = localStorage.getItem(KEY_TIME);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.date === todayKey()) return parsed;
  } catch (e) {
    console.error('Failed to load daily review time:', e);
  }
  return { date: todayKey(), seconds: 0 };
}

function saveDaily(daily) {
  try {
    localStorage.setItem(KEY_TIME, JSON.stringify(daily));
  } catch (e) {
    console.error('Failed to save daily review time:', e);
  }
}

/** Move time since `tickerStart` into today's total and disarm the ticker. */
function flushTicker() {
  if (!tickerStart) return;
  const elapsed = (Date.now() - tickerStart) / 1000;
  tickerStart = 0;
  const daily = loadDaily();
  daily.seconds += elapsed;
  saveDaily(daily);
}

export function getSecondsToday() {
  // Include any in-flight time without losing the live ticker.
  if (tickerStart) {
    const live = (Date.now() - tickerStart) / 1000;
    return loadDaily().seconds + live;
  }
  return loadDaily().seconds;
}

export function startTracking() {
  tracking = true;
  if (!document.hidden && !tickerStart) tickerStart = Date.now();
}

export function stopTracking() {
  flushTicker();
  tracking = false;
}

function onVisibilityChange() {
  if (document.hidden) {
    flushTicker();
  } else if (tracking && !tickerStart) {
    tickerStart = Date.now();
  }
}

function maybeNotify() {
  if (!getEnabled()) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  // Persist the live ticker so the total reflects the current session.
  flushTicker();
  if (tracking && !document.hidden) tickerStart = Date.now();

  const seconds = loadDaily().seconds;
  if (seconds >= GOAL_SECONDS) return;

  const done = Math.floor(seconds / 60);
  const remaining = Math.max(1, Math.ceil((GOAL_SECONDS - seconds) / 60));
  try {
    new Notification('Time to review your cards', {
      body: `You've studied ${done} min today — ${remaining} more to reach your 5-minute goal.`,
      tag: 'srs-daily-reminder',
    });
  } catch (e) {
    console.error('Failed to show review notification:', e);
  }
}

/**
 * Request notification permission. Must be called from a user gesture so the
 * browser will actually show the prompt. Returns true if granted.
 */
export async function requestPermission() {
  if (!('Notification' in window)) {
    console.warn('Notifications API not supported in this browser.');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch (e) {
    console.error('Notification permission request failed:', e);
    return false;
  }
}

export function init({ getEnabled: getter }) {
  getEnabled = getter;
  document.addEventListener('visibilitychange', onVisibilityChange);
  // Flush in-flight time when the page is being unloaded so it isn't lost.
  window.addEventListener('pagehide', flushTicker);
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(maybeNotify, NOTIFY_INTERVAL_MS);
}
