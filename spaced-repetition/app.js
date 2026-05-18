// Spaced Repetition — controller: routing, deck loading, study sessions.

import { getConfig, saveConfig } from './js/config.js';
import { login, logout, isLoggedIn, handleCallback } from './js/auth.js';
import { listDecks, getGist, getFileContent } from './js/github.js';
import { parseFile } from './js/parser.js';
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

// ── Settings ────────────────────────────────────────────────────────

function fillSettings() {
  const c = getConfig();
  $('#cfg-prefix').value = c.gistPrefix;
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

/** Assemble a deck (id, name, cards) from a full gist object. */
async function buildDeck(gist) {
  const prefix = getConfig().gistPrefix;
  const cards = [];
  for (const [fileName, file] of Object.entries(gist.files)) {
    if (!fileName.toLowerCase().endsWith('.md')) continue;
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
  const name = (gist.description || '').slice(prefix.length).trim() || '(untitled deck)';
  return { id: gist.id, name, cards };
}

async function loadDecks() {
  const status = $('#decks-status');
  status.textContent = 'Loading decks…';
  $('#deck-list').innerHTML = '';
  try {
    const gists = await listDecks(getConfig().gistPrefix);
    decks = [];
    for (const summary of gists) {
      const gist = await getGist(summary.id);
      await cacheDeck(gist);
      decks.push(await buildDeck(gist));
    }
    status.textContent = decks.length ? '' : 'No decks found. Create a gist whose description starts with your prefix.';
  } catch (e) {
    console.error('Failed to load decks online; falling back to cache:', e);
    const cached = await getCachedDecks();
    decks = [];
    for (const gist of cached) decks.push(await buildDeck(gist));
    status.textContent = decks.length
      ? 'Offline — showing cached decks.'
      : `Could not load decks: ${e.message}`;
  }
  renderDeckList();
}

function renderDeckList() {
  const list = $('#deck-list');
  list.innerHTML = '';
  for (const deck of decks) {
    const due = deck.cards.filter((c) => isDue(c.sr)).length;
    const el = document.createElement('button');
    el.className = 'deck-card';
    el.innerHTML = `
      <span class="deck-name"></span>
      <span class="deck-meta"><strong>${due}</strong> due · ${deck.cards.length} cards</span>`;
    el.querySelector('.deck-name').textContent = deck.name;
    el.disabled = due === 0;
    el.addEventListener('click', () => startStudy(deck));
    list.appendChild(el);
  }
}

// ── Study session ───────────────────────────────────────────────────

function startStudy(deck) {
  const queue = deck.cards.filter((c) => isDue(c.sr));
  session = { deck, queue, reviewed: 0 };
  $('#study-deck-name').textContent = deck.name;
  showView('study');
  nextCard();
}

function updateProgress() {
  $('#study-progress').textContent = `${session.reviewed} reviewed · ${session.queue.length} left`;
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
  $('#study-card').innerHTML =
    `<p class="study-done">All done — ${session.reviewed} review(s) this session.</p>`;
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
  $('#study-show').addEventListener('click', revealAnswer);
  $('#study-back').addEventListener('click', () => {
    session = null;
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
