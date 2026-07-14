(function () {
  "use strict";

  // ==========================================================================
  //  Freesound browser — search freesound.org and load sounds onto the pads.
  //
  //  Auth is the OAuth2 authorization-code grant, per
  //  https://freesound.org/docs/api/authentication.html. Freesound has no
  //  PKCE, so the token exchange requires a client secret. This app is a
  //  static page with no backend, so each user supplies their own free API
  //  credential (https://freesound.org/apiv2/apply) whose redirect URL points
  //  back at this page; the credential and tokens live only in localStorage.
  //
  //  Pads are loaded from the HQ MP3 preview rather than the original file:
  //  originals may be in formats decodeAudioData can't handle (FLAC/AIFF) and
  //  are often huge, while previews are universally decodable and plenty for
  //  a drum pad.
  // ==========================================================================

  var API = "https://freesound.org/apiv2";

  // Shared built-in credential — intentionally public. Freesound has no PKCE,
  // so a static app cannot keep a secret anyway; the exposure is limited
  // because rate limits are keyed to the client_id (everyone on this
  // credential shares one 60/min, 2000/day quota — only searches count) and
  // authorization codes are only ever redirected to this app's registered
  // URL. Users who want a private quota can paste their own credential in
  // the panel, which is stored in localStorage and overrides this one.
  var DEFAULT_CREDS = {
    id: "k5XqvXP2zEPXZB1y1uxx",
    secret: "XQ4VcZA2JZqmkq0wFvckTzTzVSCggwrI7MdujZYc",
  };

  var LS_CREDS = "tilt-drums.fs-creds";
  var LS_TOKEN = "tilt-drums.fs-token";
  var LS_STATE = "tilt-drums.fs-state";
  var SEARCH_FIELDS = "id,name,username,duration,previews";
  // Pad indices 0..3 map to flick directions Up, Right, Left, Down (see app.js)
  var PAD_ARROWS = ["↑", "→", "←", "↓"];
  var PAD_NAMES = ["Up", "Right", "Left", "Down"];

  var panel = document.getElementById("freesound-panel");
  var openBtn = document.getElementById("fs-open");
  var closeBtn = document.getElementById("fs-close");
  var errorEl = document.getElementById("fs-error");
  var setupEl = document.getElementById("fs-setup");
  var browserEl = document.getElementById("fs-browser");
  var clientIdInput = document.getElementById("fs-client-id");
  var clientSecretInput = document.getElementById("fs-client-secret");
  var connectBtn = document.getElementById("fs-connect");
  var searchForm = document.getElementById("fs-search-form");
  var queryInput = document.getElementById("fs-query");
  var statusEl = document.getElementById("fs-status");
  var resultsEl = document.getElementById("fs-results");
  var moreBtn = document.getElementById("fs-more");
  var disconnectBtn = document.getElementById("fs-disconnect");

  document.getElementById("fs-redirect-uri").textContent =
    location.origin + location.pathname;

  // ---- Error / status display ----

  function showError(msg, err) {
    console.error(msg, err || "");
    errorEl.textContent = msg + (err ? ": " + (err.message || err) : "");
    errorEl.classList.remove("hidden");
  }

  function clearError() { errorEl.classList.add("hidden"); }

  function setStatus(msg) { statusEl.textContent = msg; }

  // ---- localStorage helpers ----

  function readJSON(key) {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.error("Corrupt localStorage entry, discarding:", key, err);
      localStorage.removeItem(key);
      return null;
    }
  }

  // ---- OAuth2 ----

  /** The user's own credential from localStorage, or the shared built-in one. */
  function getCreds() {
    return readJSON(LS_CREDS) || DEFAULT_CREDS;
  }

  /** POST to the token endpoint (auth-code exchange or refresh) and store the result. */
  function tokenRequest(params) {
    var creds = getCreds();
    params.client_id = creds.id;
    params.client_secret = creds.secret;
    return fetch(API + "/oauth2/access_token/", {
      method: "POST",
      body: new URLSearchParams(params),
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error("Token request failed (" + res.status + "): " + text);
        var tok = JSON.parse(text);
        tok.expires_at = Date.now() + tok.expires_in * 1000;
        localStorage.setItem(LS_TOKEN, JSON.stringify(tok));
        return tok;
      });
    });
  }

  /** Resolve to a valid access token, refreshing it if (nearly) expired. */
  function ensureToken() {
    var tok = readJSON(LS_TOKEN);
    if (!tok) return Promise.reject(new Error("Not connected to Freesound"));
    if (Date.now() < tok.expires_at - 60000) return Promise.resolve(tok.access_token);
    return tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh_token })
      .then(function (t) { return t.access_token; })
      .catch(function (err) {
        // Refresh tokens are single-use; a failed refresh means the user
        // must go through the authorization flow again.
        localStorage.removeItem(LS_TOKEN);
        updateView();
        throw err;
      });
  }

  function apiGet(url) {
    return ensureToken().then(function (token) {
      return fetch(url, { headers: { Authorization: "Bearer " + token } });
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("Freesound API error (" + res.status + "): " + t);
        });
      }
      return res.json();
    });
  }

  connectBtn.onclick = function () {
    clearError();
    var id = clientIdInput.value.trim();
    var secret = clientSecretInput.value.trim();
    if (!!id !== !!secret) {
      showError("Enter both the client ID and the client secret — or leave both empty to use the built-in credential");
      return;
    }
    if (id) {
      localStorage.setItem(LS_CREDS, JSON.stringify({ id: id, secret: secret }));
    } else {
      localStorage.removeItem(LS_CREDS);
    }
    var state = Array.from(crypto.getRandomValues(new Uint8Array(16)), function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
    localStorage.setItem(LS_STATE, state);
    location.href = API + "/oauth2/authorize/?" +
      new URLSearchParams({ client_id: getCreds().id, response_type: "code", state: state });
  };

  /** Handle ?code=/?error= on page load after Freesound redirects back. */
  function handleRedirect() {
    var params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) return;
    // Strip the query string so a reload doesn't retry the (single-use) code.
    history.replaceState(null, "", location.pathname);
    openPanel();
    if (params.has("error")) {
      showError("Freesound authorization failed: " + params.get("error"));
      return;
    }
    var expected = localStorage.getItem(LS_STATE);
    localStorage.removeItem(LS_STATE);
    if (!expected || expected !== params.get("state")) {
      showError("OAuth state mismatch — please try connecting again");
      return;
    }
    setStatus("Connecting…");
    tokenRequest({ grant_type: "authorization_code", code: params.get("code") })
      .then(function () {
        updateView();
        setStatus("Connected — search for sounds");
      })
      .catch(function (err) {
        showError("Could not complete the Freesound login", err);
      });
  }

  disconnectBtn.onclick = function () {
    localStorage.removeItem(LS_TOKEN);
    resultsEl.innerHTML = "";
    setStatus("");
    updateView();
  };

  // ---- Panel ----

  /** Show setup or browser depending on whether we hold a token. */
  function updateView() {
    // Only a user-supplied credential is shown in the inputs; when on the
    // built-in one they stay empty so "empty = built-in" holds visually too.
    var custom = readJSON(LS_CREDS);
    clientIdInput.value = custom ? custom.id : "";
    clientSecretInput.value = custom ? custom.secret : "";
    var connected = !!readJSON(LS_TOKEN);
    setupEl.classList.toggle("hidden", connected);
    browserEl.classList.toggle("hidden", !connected);
  }

  function openPanel() {
    updateView();
    panel.classList.remove("hidden");
  }

  openBtn.onclick = openPanel;

  closeBtn.onclick = function () {
    previewAudio.pause();
    panel.classList.add("hidden");
  };

  // ---- Search ----

  var nextUrl = null;

  searchForm.onsubmit = function (e) {
    e.preventDefault();
    var query = queryInput.value.trim();
    if (!query) return;
    clearError();
    setStatus("Searching…");
    resultsEl.innerHTML = "";
    nextUrl = null;
    moreBtn.classList.add("hidden");
    apiGet(API + "/search/text/?" + new URLSearchParams({
      query: query,
      fields: SEARCH_FIELDS,
      page_size: 20,
    })).then(renderPage).catch(function (err) {
      setStatus("");
      showError("Search failed", err);
    });
  };

  moreBtn.onclick = function () {
    if (!nextUrl) return;
    moreBtn.disabled = true;
    apiGet(nextUrl).then(function (data) {
      moreBtn.disabled = false;
      renderPage(data);
    }).catch(function (err) {
      moreBtn.disabled = false;
      showError("Could not load more results", err);
    });
  };

  function renderPage(data) {
    setStatus(data.count + " sound" + (data.count === 1 ? "" : "s"));
    data.results.forEach(renderResult);
    nextUrl = data.next;
    moreBtn.classList.toggle("hidden", !nextUrl);
  }

  function renderResult(sound) {
    var li = document.createElement("li");
    li.className = "fs-result";

    var playBtn = document.createElement("button");
    playBtn.className = "fs-play";
    playBtn.textContent = "▶";
    playBtn.onclick = function () { togglePreview(playBtn, sound); };

    var meta = document.createElement("div");
    meta.className = "fs-meta";
    var nameEl = document.createElement("div");
    nameEl.className = "fs-name";
    nameEl.textContent = sound.name;
    var subEl = document.createElement("div");
    subEl.className = "fs-sub";
    subEl.textContent = sound.duration.toFixed(1) + "s · " + sound.username;
    meta.appendChild(nameEl);
    meta.appendChild(subEl);

    var assign = document.createElement("div");
    assign.className = "fs-assign";
    PAD_ARROWS.forEach(function (arrow, padIndex) {
      var btn = document.createElement("button");
      btn.textContent = arrow;
      btn.title = "Load onto the " + PAD_NAMES[padIndex] + " pad";
      btn.onclick = function () { assignToPad(sound, padIndex, btn); };
      assign.appendChild(btn);
    });

    li.appendChild(playBtn);
    li.appendChild(meta);
    li.appendChild(assign);
    resultsEl.appendChild(li);
  }

  // ---- Preview playback (one shared player so only one preview at a time) ----

  var previewAudio = new Audio();
  var playingBtn = null;

  previewAudio.onended = function () {
    if (playingBtn) playingBtn.textContent = "▶";
  };
  previewAudio.onerror = function () {
    var err = previewAudio.error;
    showError("Preview playback failed", err && err.message);
    if (playingBtn) playingBtn.textContent = "▶";
  };

  function togglePreview(btn, sound) {
    if (playingBtn === btn && !previewAudio.paused) {
      previewAudio.pause();
      btn.textContent = "▶";
      return;
    }
    if (playingBtn) playingBtn.textContent = "▶";
    playingBtn = btn;
    previewAudio.src = sound.previews["preview-hq-mp3"];
    previewAudio.play().then(function () {
      btn.textContent = "⏸";
    }).catch(function (err) {
      showError("Preview playback failed", err);
    });
  }

  // ---- Loading onto a pad ----

  function assignToPad(sound, padIndex, btn) {
    clearError();
    btn.disabled = true;
    btn.textContent = "…";
    fetch(sound.previews["preview-hq-mp3"]).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      return window.tiltDrums.loadSampleIntoPad(buf, sound.name, padIndex);
    }).then(function () {
      btn.textContent = "✓";
      setTimeout(function () {
        btn.disabled = false;
        btn.textContent = PAD_ARROWS[padIndex];
      }, 1200);
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = PAD_ARROWS[padIndex];
      showError('Could not load "' + sound.name + '"', err);
    });
  }

  updateView();
  handleRedirect();
})();
