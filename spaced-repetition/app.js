// Spaced Repetition — controller: routing, deck loading, study sessions.

import { getConfig, saveConfig } from './js/config.js';
import { login, logout, isLoggedIn, handleCallback } from './js/auth.js';
import { listDecks, getGist, getFileContent, updateGistFile } from './js/github.js';
import { parseFile, reattachSR } from './js/parser.js';
import { stripSRLines } from './js/srcomment.js';
import { isDue, rate, preview } from './js/scheduler.js';
import { renderCardSide, typeset } from './js/render.js';
import { cacheDeck, getCachedDecks } from './js/store.js';
import { recordReview, flush } from './js/sync.js';

const $ = (sel) => document.querySelector(sel);

let session = null; // active study session

// ── View routing ────────────────────────────────────────────────────

function showView(name) {
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('hidden', v.id !== `view-${name}`);
  }
  $('#btn-logout').classList.toggle('hidden', !isLoggedIn());
}

function route() {
  if (!isLoggedIn()) {
    showView('login');
    return;
  }
  showView('decks');
  loadDecks();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
  if (msg) setTimeout(() => el.classList.add('hidden'), 4000);
}

/**
 * Last-resort error reporting: catch anything that escapes a try/catch — an
 * unawaited promise rejection, an event-handler throw — so it always lands
 * loudly in the console (and the UI) instead of failing silently.
 */
function installGlobalErrorReporting() {
  window.addEventListener('error', (e) => {
    console.error('Uncaught error:', e.error || e.message, e);
    toast(`Error: ${e.message}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    toast(`Error: ${e.reason?.message || e.reason}`);
  });
}

// ── Settings ────────────────────────────────────────────────────────

function fillSettings() {
  const c = getConfig();
  $('#cfg-prefix').value = c.gistPrefix;
  $('#cfg-math-preamble').value = c.mathPreamble;
  $('#cfg-d-inline').value = c.delim.inline;
  $('#cfg-d-inline-rev').value = c.delim.inlineReversed;
  $('#cfg-d-multiline').value = c.delim.multiline;
  $('#cfg-d-multiline-rev').value = c.delim.multilineReversed;
  $('#cfg-d-cloze-open').value = c.delim.clozeOpen;
  $('#cfg-d-cloze-close').value = c.delim.clozeClose;
}

function saveSettings() {
  saveConfig({
    gistPrefix: $('#cfg-prefix').value.trim() || 'srs:',
    mathPreamble: $('#cfg-math-preamble').value,
    delim: {
      inline: $('#cfg-d-inline').value || '::',
      inlineReversed: $('#cfg-d-inline-rev').value || ':::',
      multiline: $('#cfg-d-multiline').value || '?',
      multilineReversed: $('#cfg-d-multiline-rev').value || '??',
      clozeOpen: $('#cfg-d-cloze-open').value || '==',
      clozeClose: $('#cfg-d-cloze-close').value || '==',
    },
  });
  toast('Settings saved.');
  route();
}

// ── Decks ───────────────────────────────────────────────────────────

let decks = [];

/**
 * Assemble a deck (id, name, cards) from a full gist object. A deck's content
 * lives in markdown files whose name starts with the prefix; the deck name is
 * taken from that file name (prefix and `.md` extension stripped).
 */
async function buildDeck(gist) {
  const prefix = getConfig().gistPrefix;
  const cards = [];
  let name = '';
  for (const [fileName, file] of Object.entries(gist.files)) {
    if (!fileName.startsWith(prefix) || !fileName.toLowerCase().endsWith('.md')) continue;
    if (!name) name = fileName.slice(prefix.length).replace(/\.md$/i, '').trim();
    let content;
    try {
      content = await getFileContent(file);
    } catch (e) {
      console.error(`Failed to read gist file "${fileName}":`, e);
      continue;
    }
    for (const block of parseFile(content)) {
      block.cards.forEach((card, ci) => {
        card.gistId = gist.id;
        card.fileName = fileName;
        card.block = block;
        card.cardIndexInBlock = ci;
        cards.push(card);
      });
    }
  }
  return { id: gist.id, name: name || '(untitled deck)', cards };
}

async function loadDecks() {
  const status = $('#decks-status');
  status.textContent = 'Loading decks…';
  $('#deck-list').innerHTML = '';

  // Phase 1: find the deck gists. Only a failure here means we can't reach
  // GitHub at all, so this is the only case that warrants the cache fallback.
  let gists;
  try {
    gists = await listDecks(getConfig().gistPrefix);
  } catch (e) {
    console.error('Failed to list decks from GitHub:', e);
    const cached = await getCachedDecks();
    decks = [];
    for (const gist of cached) decks.push(await buildDeck(gist));
    status.textContent = decks.length
      ? `Showing cached decks — could not reach GitHub: ${e.message}`
      : `Could not load decks: ${e.message}`;
    renderDeckList();
    return;
  }

  // Phase 2: fetch each found gist. A single failure must not discard the
  // decks that did load — collect failures and report them visibly.
  decks = [];
  const failed = [];
  for (const summary of gists) {
    try {
      const gist = await getGist(summary.id);
      await cacheDeck(gist);
      decks.push(await buildDeck(gist));
    } catch (e) {
      console.error(`Failed to load deck gist ${summary.id}:`, e);
      failed.push(summary);
    }
  }

  if (!gists.length) {
    status.textContent =
      'No decks found. Create a gist with a markdown file whose name starts with your prefix.';
  } else if (failed.length) {
    status.textContent =
      `Loaded ${decks.length} of ${gists.length} deck(s); ${failed.length} failed — see console.`;
  } else {
    status.textContent = '';
  }
  renderDeckList();
}

function renderDeckList() {
  const list = $('#deck-list');
  list.innerHTML = '';
  for (const deck of decks) {
    const due = deck.cards.filter((c) => isDue(c.sr)).length;
    const card = document.createElement('div');
    card.className = 'deck-card';
    card.innerHTML = `
      <div class="deck-info">
        <span class="deck-name"></span>
        <span class="deck-meta"><strong>${due}</strong> due · ${deck.cards.length} cards</span>
      </div>
      <div class="deck-actions">
        <button class="deck-study primary" type="button">Study</button>
        <button class="deck-edit" type="button">Edit</button>
      </div>`;
    card.querySelector('.deck-name').textContent = deck.name;
    const studyBtn = card.querySelector('.deck-study');
    studyBtn.disabled = due === 0;
    studyBtn.addEventListener('click', () => startStudy(deck));
    card.querySelector('.deck-edit').addEventListener('click', () => openEditor(deck));
    list.appendChild(card);
  }
}

// ── Deck editor ─────────────────────────────────────────────────────

const MD_RE = /\.md$/i;

// Active edit session: { gistId, files:{ name:{original,draft} }, current }.
let editor = null;

/** Load a deck's gist files into the editor (SR metadata hidden) and show it. */
async function openEditor(deck) {
  toast('Loading deck for editing…');
  let gist;
  try {
    gist = await getGist(deck.id);
  } catch (e) {
    console.error('Failed to load deck for editing:', e);
    toast(`Could not open editor: ${e.message}`);
    return;
  }

  const prefix = getConfig().gistPrefix;
  const files = {};
  for (const [name, file] of Object.entries(gist.files)) {
    if (!name.startsWith(prefix) || !MD_RE.test(name)) continue;
    try {
      const original = await getFileContent(file);
      files[name] = { original, draft: stripSRLines(original) };
    } catch (e) {
      console.error(`Failed to read gist file "${name}":`, e);
      toast(`Could not read "${name}".`);
      return;
    }
  }
  // A deck gist with no markdown file yet — let the user author the first one.
  if (!Object.keys(files).length) {
    files[`${prefix}${deck.name}.md`] = { original: '', draft: '' };
  }

  const names = Object.keys(files);
  editor = { gistId: deck.id, files, current: names[0] };

  $('#edit-deck-name').textContent = deck.name;
  const sel = $('#edit-file');
  sel.innerHTML = '';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = editor.current;
  $('#edit-file-row').classList.toggle('hidden', names.length < 2);
  $('#edit-content').value = files[editor.current].draft;
  toast('');
  showView('edit');
}

/** Persist the textarea into the current file's draft. */
function syncDraft() {
  if (editor) editor.files[editor.current].draft = $('#edit-content').value;
}

function switchEditorFile(name) {
  syncDraft();
  editor.current = name;
  $('#edit-content').value = editor.files[name].draft;
}

/** True when any file's draft differs from what was loaded. */
function editorDirty() {
  syncDraft();
  return Object.values(editor.files).some(
    (f) => f.draft !== stripSRLines(f.original)
  );
}

async function saveEditor() {
  syncDraft();
  const btn = $('#edit-save');
  btn.disabled = true;
  let saved = 0;
  try {
    for (const [name, f] of Object.entries(editor.files)) {
      if (f.draft === stripSRLines(f.original)) continue; // untouched
      const content = reattachSR(f.draft, f.original);
      await updateGistFile(editor.gistId, name, content);
      f.original = content;
      saved++;
    }
    if (saved) {
      toast(`Saved ${saved} file(s).`);
      editor = null;
      route(); // reloads the (now updated) deck list
    } else {
      toast('No changes to save.');
    }
  } catch (e) {
    console.error('Failed to save deck:', e);
    toast(`Save failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function cancelEditor() {
  if (editorDirty() && !confirm('Discard unsaved changes?')) return;
  editor = null;
  route();
}

// ── Study session ───────────────────────────────────────────────────

function startStudy(deck) {
  const queue = deck.cards.filter((c) => isDue(c.sr));
  session = { deck, queue, reviewed: 0, startedAt: Date.now(), timerId: null };
  // Tick the timer once a second so the "elapsed" portion of the progress
  // line stays live even while the user lingers on a single card.
  session.timerId = setInterval(updateProgress, 1000);
  $('#study-deck-name').textContent = deck.name;
  showView('study');
  nextCard();
}

function stopStudy() {
  if (session?.timerId) clearInterval(session.timerId);
  session = null;
}

/** Format a millisecond duration as `Mm Ss` (or `Hh Mm Ss` past an hour). */
function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
}

function updateProgress() {
  const elapsed = formatElapsed(Date.now() - session.startedAt);
  $('#study-progress').textContent =
    `${session.reviewed} reviewed · ${session.queue.length} left · ${elapsed}`;
}

async function showSide(card, side) {
  const node = $('#study-card');
  node.innerHTML = renderCardSide(card, side);
  await typeset(node);
}

async function nextCard() {
  updateProgress();
  if (!session.queue.length) {
    finishStudy();
    return;
  }
  const card = session.queue[0];
  $('#study-card-wrap').classList.remove('revealed');
  $('#study-ratings').classList.add('hidden');
  $('#study-show').classList.remove('hidden');
  await showSide(card, 'front');
}

async function revealAnswer() {
  const card = session.queue[0];
  $('#study-card-wrap').classList.add('revealed');
  await showSide(card, 'back');
  $('#study-show').classList.add('hidden');

  const intervals = preview(card.sr);
  for (const key of ['again', 'hard', 'good', 'easy']) {
    $(`#rate-${key} .rate-interval`).textContent = intervals[key];
  }
  $('#study-ratings').classList.remove('hidden');
}

async function rateCard(ratingKey) {
  const card = session.queue.shift();
  card.sr = rate(card.sr, ratingKey);
  session.reviewed++;
  try {
    await recordReview({
      gistId: card.gistId,
      fileName: card.fileName,
      cleanText: card.block.cleanText,
      cardIndex: card.cardIndexInBlock,
      sr: card.sr,
    });
  } catch (e) {
    console.error('Failed to queue review:', e);
    toast('Warning: review could not be saved locally.');
  }
  // Re-show "again" cards later in the same session.
  if (ratingKey === 'again') session.queue.push(card);
  nextCard();
}

async function finishStudy() {
  const elapsed = formatElapsed(Date.now() - session.startedAt);
  const reviewed = session.reviewed;
  if (session.timerId) clearInterval(session.timerId);
  session.timerId = null;
  $('#study-card').innerHTML =
    `<p class="study-done">All done — ${reviewed} review(s) in ${elapsed}.</p>`;
  $('#study-show').classList.add('hidden');
  $('#study-ratings').classList.add('hidden');
  $('#study-card-wrap').classList.add('revealed');

  if (navigator.onLine) {
    const { synced, failed } = await flush();
    if (synced) toast(`Synced ${synced} review(s) to GitHub.`);
    if (failed) toast(`${failed} review(s) could not sync — will retry.`);
  } else {
    toast('Offline — reviews will sync when you reconnect.');
  }
}

// ── Init ────────────────────────────────────────────────────────────

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register('sw.js')
    .catch((e) => console.warn('Service worker registration failed:', e));
}

function wireEvents() {
  $('#btn-settings').addEventListener('click', () => {
    fillSettings();
    showView('settings');
  });
  $('#btn-logout').addEventListener('click', () => {
    logout();
    route();
  });
  $('#cfg-save').addEventListener('click', saveSettings);
  $('#cfg-cancel').addEventListener('click', route);
  $('#btn-login').addEventListener('click', login);
  $('#decks-refresh').addEventListener('click', loadDecks);
  $('#edit-cancel').addEventListener('click', cancelEditor);
  $('#edit-save').addEventListener('click', saveEditor);
  $('#edit-file').addEventListener('change', (e) => switchEditorFile(e.target.value));
  $('#study-show').addEventListener('click', revealAnswer);
  $('#study-back').addEventListener('click', () => {
    stopStudy();
    route();
  });
  for (const key of ['again', 'hard', 'good', 'easy']) {
    $(`#rate-${key}`).addEventListener('click', () => rateCard(key));
  }
  window.addEventListener('online', async () => {
    const { synced } = await flush();
    if (synced) toast(`Synced ${synced} review(s) to GitHub.`);
  });
}

async function init() {
  installGlobalErrorReporting();
  registerSW();
  wireEvents();

  const callback = await handleCallback();
  if (callback === 'error') toast('Sign-in failed. Check your settings and try again.');

  route();

  if (isLoggedIn() && navigator.onLine) {
    flush()
      .then(({ synced }) => { if (synced) toast(`Synced ${synced} pending review(s).`); })
      .catch((e) => console.error('Startup sync failed:', e));
  }
}

init();
