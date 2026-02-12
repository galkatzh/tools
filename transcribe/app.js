(function () {
  'use strict';

  const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const GIST_URL = 'https://api.github.com/gists';
  const WHISPER_MODEL = 'whisper-large-v3-turbo';
  const GIST_PREFIX = '[transcribe]';
  const STORE_NAME = 'shared-audio';
  const DB_NAME = 'transcribe-share';

  const $ = (sel) => document.querySelector(sel);
  const el = {
    setup: $('#setup'),
    main: $('#main'),
    groqKey: $('#groq-key'),
    ghToken: $('#gh-token'),
    saveKeys: $('#save-keys'),
    settingsBtn: $('#settings-btn'),
    dropZone: $('#drop-zone'),
    fileInput: $('#file-input'),
    queue: $('#queue'),
    history: $('#history'),
  };

  // ── Keys ──────────────────────────────────────────────────────────────

  function loadKeys() {
    return {
      groq: localStorage.getItem('groq_key') || '',
      gh: localStorage.getItem('gh_token') || '',
    };
  }

  function saveKeys(groq, gh) {
    localStorage.setItem('groq_key', groq);
    localStorage.setItem('gh_token', gh);
  }

  function hasKeys() {
    const k = loadKeys();
    return k.groq && k.gh;
  }

  // ── Screens ───────────────────────────────────────────────────────────

  function showSetup() {
    const k = loadKeys();
    el.groqKey.value = k.groq;
    el.ghToken.value = k.gh;
    el.setup.classList.remove('hidden');
    el.main.classList.add('hidden');
  }

  function showMain() {
    el.setup.classList.add('hidden');
    el.main.classList.remove('hidden');
  }

  // ── IndexedDB for share target handoff ────────────────────────────────

  /** Open (or create) the tiny DB used to pass shared files from the SW. */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME, { autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Drain all files the service worker stashed and delete them. */
  async function consumeSharedFiles() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const all = store.getAll();
      all.onsuccess = () => {
        store.clear();
        resolve(all.result); // array of File objects
      };
      all.onerror = () => reject(all.error);
    });
  }

  // ── Transcription via Groq ────────────────────────────────────────────

  /** Transcribe an audio File via the Groq Whisper endpoint. */
  async function transcribe(file) {
    const body = new FormData();
    body.append('file', file);
    body.append('model', WHISPER_MODEL);

    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loadKeys().groq}` },
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq ${res.status}: ${err}`);
    }
    return (await res.json()).text;
  }

  // ── Gist upload ───────────────────────────────────────────────────────

  /** Create a public gist with the given filename and content. Returns the gist URL. */
  async function createGist(filename, content) {
    const res = await fetch(GIST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loadKeys().gh}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        description: `${GIST_PREFIX} ${filename}`,
        public: false,
        files: { [`${filename}.md`]: { content } },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GitHub ${res.status}: ${err}`);
    }
    return (await res.json()).html_url;
  }

  // ── History: load past transcription gists ─────────────────────────────

  /** Fetch all gists with our prefix and render them as cards. */
  async function loadHistory() {
    el.history.innerHTML = '<div class="history-loading">Loading history\u2026</div>';
    try {
      const gists = await fetchTranscriptionGists();
      el.history.innerHTML = '';
      if (!gists.length) return;

      const heading = document.createElement('h2');
      heading.className = 'history-heading';
      heading.textContent = 'History';
      el.history.appendChild(heading);

      for (const g of gists) {
        el.history.appendChild(renderHistoryCard(g));
      }
    } catch (err) {
      el.history.innerHTML = `<div class="history-loading">${err.message}</div>`;
    }
  }

  /**
   * Paginate through GET /gists until we've gathered all [transcribe] gists.
   * Stops early once a page returns zero matches and we've passed the first page.
   */
  async function fetchTranscriptionGists() {
    const headers = { Authorization: `Bearer ${loadKeys().gh}` };
    const results = [];
    let page = 1;

    while (true) {
      const res = await fetch(`${GIST_URL}?per_page=100&page=${page}`, { headers });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const batch = await res.json();
      if (!batch.length) break;

      for (const g of batch) {
        if (g.description && g.description.startsWith(GIST_PREFIX)) results.push(g);
      }

      // GitHub returns at most 100 per page; stop if less
      if (batch.length < 100) break;
      page++;
    }
    return results;
  }

  /** Build a card DOM element for a past gist. */
  function renderHistoryCard(gist) {
    const name = gist.description.slice(GIST_PREFIX.length).trim();
    const date = new Date(gist.created_at).toLocaleString();
    // Grab the first (and usually only) file's truncated content
    const file = Object.values(gist.files)[0];

    const card = document.createElement('div');
    card.className = 'card done';
    card.innerHTML = `
      <div class="card-name">${name}</div>
      <div class="card-status">
        <span class="card-date">${date}</span>
        <a href="${gist.html_url}" target="_blank" rel="noopener">View Gist</a>
      </div>
    `;

    if (file && file.content) {
      const preview = document.createElement('div');
      preview.className = 'card-preview';
      preview.textContent = file.content.length > 300
        ? file.content.slice(0, 300) + '\u2026'
        : file.content;
      card.appendChild(preview);
    }
    return card;
  }

  // ── Queue UI ──────────────────────────────────────────────────────────

  /** Add a card to the queue and process it. */
  function enqueue(file) {
    const card = document.createElement('div');
    card.className = 'card processing';
    card.innerHTML = `
      <div class="card-name">${file.name}</div>
      <div class="card-status">Transcribing&hellip;</div>
    `;
    el.queue.prepend(card);
    process(file, card);
  }

  async function process(file, card) {
    const status = card.querySelector('.card-status');
    try {
      const text = await transcribe(file);
      status.textContent = 'Uploading to Gist\u2026';

      const gistUrl = await createGist(file.name, text);

      card.classList.remove('processing');
      card.classList.add('done');
      status.innerHTML = `<a href="${gistUrl}" target="_blank" rel="noopener">View Gist</a>`;

      // Show a preview of the transcription
      const preview = document.createElement('div');
      preview.className = 'card-preview';
      preview.textContent = text.length > 300 ? text.slice(0, 300) + '\u2026' : text;
      card.appendChild(preview);
    } catch (err) {
      card.classList.remove('processing');
      card.classList.add('error');
      status.textContent = err.message;
    }
  }

  // ── File handling ─────────────────────────────────────────────────────

  function handleFiles(files) {
    for (const f of files) enqueue(f);
  }

  // ── Events ────────────────────────────────────────────────────────────

  el.saveKeys.addEventListener('click', () => {
    const groq = el.groqKey.value.trim();
    const gh = el.ghToken.value.trim();
    if (!groq || !gh) return alert('Both keys are required.');
    saveKeys(groq, gh);
    showMain();
    loadHistory();
  });

  el.settingsBtn.addEventListener('click', showSetup);

  el.dropZone.addEventListener('click', () => el.fileInput.click());

  el.fileInput.addEventListener('change', () => {
    handleFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  // Drag & drop
  el.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.dropZone.classList.add('active');
  });
  el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('active'));
  el.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropZone.classList.remove('active');
    handleFiles(e.dataTransfer.files);
  });

  // ── Share target: pick up files the SW stashed ────────────────────────

  async function checkForSharedFiles() {
    try {
      const files = await consumeSharedFiles();
      if (files.length) handleFiles(files);
    } catch (err) { console.error('Failed to consume shared files:', err); }
  }

  // ── Service worker registration ───────────────────────────────────────

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      console.warn('SW registration failed:', e);
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────

  async function init() {
    await registerSW();
    if (hasKeys()) {
      showMain();
    } else {
      showSetup();
    }
    // Handle files shared via the Web Share Target API
    await checkForSharedFiles();
    // Load past transcription gists
    if (hasKeys()) loadHistory();
  }

  init();
})();
