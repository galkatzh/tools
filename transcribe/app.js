(function () {
  'use strict';

  const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const GIST_URL = 'https://api.github.com/gists';
  const WHISPER_MODEL = 'whisper-large-v3-turbo';
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
        description: `Transcription of ${filename}`,
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
    } catch { /* no shared files */ }
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
  }

  init();
})();
