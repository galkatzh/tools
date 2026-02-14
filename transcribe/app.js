(function () {
  'use strict';

  const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const GIST_URL = 'https://api.github.com/gists';
  const WHISPER_MODEL = 'whisper-large-v3';
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
    recordBtn: $('#record-btn'),
    recordTimer: $('#record-timer'),
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

  /** Delete a gist by its ID. */
  async function deleteGist(id) {
    const res = await fetch(`${GIST_URL}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${loadKeys().gh}` },
    });
    if (!res.ok && res.status !== 204) {
      const err = await res.text();
      throw new Error(`GitHub ${res.status}: ${err}`);
    }
  }

  /** Fetch the full content of a single gist by ID. */
  async function fetchGistContent(id) {
    const res = await fetch(`${GIST_URL}/${id}`, {
      headers: { Authorization: `Bearer ${loadKeys().gh}` },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const gist = await res.json();
    return Object.values(gist.files)[0]?.content ?? '';
  }

  /** Build a card DOM element for a past gist. Tap to expand full text. */
  function renderHistoryCard(gist) {
    const name = gist.description.slice(GIST_PREFIX.length).trim();
    const date = new Date(gist.created_at).toLocaleString();

    const card = document.createElement('div');
    card.className = 'card done expandable';
    card.innerHTML = `
      <div class="card-top">
        <div class="card-name">${name}</div>
        <button class="btn-delete" title="Delete gist" aria-label="Delete gist">&times;</button>
      </div>
      <div class="card-status">
        <span class="card-date">${date}</span>
        <a href="${gist.html_url}" target="_blank" rel="noopener">View Gist</a>
      </div>
      <div class="card-preview collapsed">Tap to expand\u2026</div>
    `;

    const preview = card.querySelector('.card-preview');
    const link = card.querySelector('a');
    const deleteBtn = card.querySelector('.btn-delete');
    let loaded = false;

    // Prevent the card click from firing when tapping interactive children
    link.addEventListener('click', (e) => e.stopPropagation());

    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${name}"?`)) return;
      deleteBtn.disabled = true;
      deleteBtn.textContent = '\u2026';
      try {
        await deleteGist(gist.id);
        card.remove();
        // Remove heading if no more history cards remain
        if (!el.history.querySelector('.card')) el.history.innerHTML = '';
      } catch (err) {
        console.error('Failed to delete gist:', err);
        alert(`Delete failed: ${err.message}`);
        deleteBtn.disabled = false;
        deleteBtn.textContent = '\u00d7';
      }
    });

    card.addEventListener('click', async () => {
      if (!loaded) {
        preview.textContent = 'Loading\u2026';
        try {
          preview.textContent = await fetchGistContent(gist.id);
          loaded = true;
        } catch (err) {
          console.error('Failed to fetch gist content:', err);
          preview.textContent = err.message;
          return;
        }
      }
      preview.classList.toggle('collapsed');
    });

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

  // ── Recording ────────────────────────────────────────────────────

  let mediaRecorder = null;
  let recordingChunks = [];
  let recordingStart = 0;
  let timerInterval = null;

  /** Probe for a MIME type the browser's MediaRecorder actually supports. */
  function getRecordingMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return ''; // let browser pick its default
  }

  /** Map a MIME string to a file extension Groq will accept. */
  function extForMime(mime) {
    if (!mime) return 'm4a';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
    if (mime.includes('ogg')) return 'ogg';
    return 'm4a';
  }

  /** Format seconds as m:ss. */
  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    return `${m}:${s}`;
  }

  function startTimer() {
    recordingStart = Date.now();
    el.recordTimer.classList.remove('hidden');
    el.recordTimer.textContent = '0:00';
    timerInterval = setInterval(() => {
      el.recordTimer.textContent = fmtTime((Date.now() - recordingStart) / 1000);
    }, 250);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    el.recordTimer.classList.add('hidden');
  }

  /** Start recording from the microphone. */
  async function startRecording() {
    const mimeType = getRecordingMimeType();
    if (mimeType === null) {
      throw new Error('Recording is not supported in this browser.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];

    const opts = mimeType ? { mimeType } : undefined;
    mediaRecorder = new MediaRecorder(stream, opts);

    // Capture the actual type the recorder chose (fallback for onstop)
    const chosenMime = mediaRecorder.mimeType || mimeType;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordingChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const mime = chosenMime;
      const blob = new Blob(recordingChunks, { type: mime });
      const ext = extForMime(mime);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = new File([blob], `recording-${ts}.${ext}`, { type: blob.type });
      handleFiles([file]);
    };
    mediaRecorder.start();
    el.recordBtn.classList.add('recording');
    el.recordBtn.querySelector('.mic-icon').classList.add('hidden');
    el.recordBtn.querySelector('.stop-icon').classList.remove('hidden');
    startTimer();
  }

  /** Stop an in-progress recording. */
  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    el.recordBtn.classList.remove('recording');
    el.recordBtn.querySelector('.mic-icon').classList.remove('hidden');
    el.recordBtn.querySelector('.stop-icon').classList.add('hidden');
    stopTimer();
    mediaRecorder = null;
  }

  async function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      try {
        await startRecording();
      } catch (err) {
        console.error('Microphone access denied:', err);
        alert('Microphone access is required to record audio.');
      }
    }
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
  el.recordBtn.addEventListener('click', toggleRecording);

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
