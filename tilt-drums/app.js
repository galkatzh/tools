(function () {
  "use strict";

  // --- Config ---
  var PAD_COUNT = 4;
  var RETRIGGER_COOLDOWN_MS = 120;
  var DEAD_ZONE = 3;

  // --- State ---
  var audioCtx = null;
  var sampleBuffers = [];
  var gainNode = null;
  var sensitivity = 20;
  var activeQuadrant = -1;
  var lastTriggerTime = [0, 0, 0, 0];
  var refBeta = null;
  var refGamma = null;
  var orientationEventCount = 0;

  // --- DOM refs ---
  var startScreen = document.getElementById("start-screen");
  var mainScreen = document.getElementById("main-screen");
  var startBtn = document.getElementById("start-btn");
  var pads = document.querySelectorAll(".pad");
  var tiltDot = document.getElementById("tilt-dot");
  var tiltViz = document.getElementById("tilt-viz");
  var sensitivitySlider = document.getElementById("sensitivity");
  var loadSamplesBtn = document.getElementById("load-samples-btn");
  var fileInput = document.getElementById("file-input");
  var sampleLoader = document.getElementById("sample-loader");
  var assignBtns = document.querySelectorAll(".assign-btn");
  var cancelAssign = document.getElementById("cancel-assign");

  console.log("[init] DOM refs acquired, startBtn:", !!startBtn);

  // =========================================================================
  //  Audio
  // =========================================================================

  function initAudio() {
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      console.log("[audio] Constructor:", Ctor === window.AudioContext ? "AudioContext" : "webkitAudioContext");
      audioCtx = new Ctor({ latencyHint: "interactive" });
      console.log("[audio] Created. state:", audioCtx.state, "sampleRate:", audioCtx.sampleRate);
      gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
      console.log("[audio] GainNode connected to destination");
    } catch (err) {
      console.error("[audio] initAudio FAILED:", err);
    }
  }

  function resumeAudio() {
    if (!audioCtx) {
      console.warn("[audio] resumeAudio called but no audioCtx");
      return Promise.resolve();
    }
    console.log("[audio] resumeAudio — current state:", audioCtx.state);
    if (audioCtx.state !== "running") {
      return audioCtx.resume().then(function () {
        console.log("[audio] resume() resolved — state now:", audioCtx.state);
      });
    }
    return Promise.resolve();
  }

  // =========================================================================
  //  Synthesised default drum samples
  // =========================================================================

  function generateKick() {
    var sr = audioCtx.sampleRate;
    var len = (sr * 0.4) | 0;
    var buf = audioCtx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      var freq = 150 * Math.exp(-t * 12);
      d[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 8);
    }
    return buf;
  }

  function generateSnare() {
    var sr = audioCtx.sampleRate;
    var len = (sr * 0.25) | 0;
    var buf = audioCtx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      var noise = Math.random() * 2 - 1;
      var tone = Math.sin(2 * Math.PI * 200 * t);
      d[i] = (noise * 0.7 + tone * 0.3) * Math.exp(-t * 18);
    }
    return buf;
  }

  function generateHiHat() {
    var sr = audioCtx.sampleRate;
    var len = (sr * 0.08) | 0;
    var buf = audioCtx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      var noise = Math.random() * 2 - 1;
      d[i] = noise * Math.sin(2 * Math.PI * 8000 * t) * Math.exp(-t * 50) * 0.6;
    }
    return buf;
  }

  function generateClap() {
    var sr = audioCtx.sampleRate;
    var len = (sr * 0.2) | 0;
    var buf = audioCtx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      var noise = Math.random() * 2 - 1;
      var env = 0;
      for (var b = 0; b < 4; b++) {
        var bt = t - b * 0.01;
        if (bt >= 0) env += Math.exp(-bt * 80);
      }
      env += Math.exp(-t * 20) * 0.5;
      d[i] = noise * env * 0.35;
    }
    return buf;
  }

  function buildDefaultSamples() {
    var names = ["Kick", "Snare", "HiHat", "Clap"];
    var gens = [generateKick, generateSnare, generateHiHat, generateClap];
    for (var i = 0; i < PAD_COUNT; i++) {
      try {
        sampleBuffers[i] = gens[i]();
        console.log("[samples] " + names[i] + " — duration:", sampleBuffers[i].duration.toFixed(3) + "s, length:", sampleBuffers[i].length);
      } catch (err) {
        console.error("[samples] Failed to generate " + names[i] + ":", err);
      }
    }
  }

  // =========================================================================
  //  Playback
  // =========================================================================

  function triggerPad(index) {
    var now = performance.now();
    if (now - lastTriggerTime[index] < RETRIGGER_COOLDOWN_MS) {
      console.log("[trigger] pad " + index + " SKIPPED (cooldown)");
      return;
    }
    lastTriggerTime[index] = now;

    var buffer = sampleBuffers[index];
    if (!buffer) {
      console.warn("[trigger] pad " + index + " — NO BUFFER");
      return;
    }
    if (!audioCtx) {
      console.warn("[trigger] pad " + index + " — NO audioCtx");
      return;
    }

    console.log("[trigger] pad " + index + " — ctx.state:", audioCtx.state, "buf.duration:", buffer.duration.toFixed(3));

    try {
      var src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(gainNode);
      src.start(0);
      console.log("[trigger] pad " + index + " — started OK");
    } catch (err) {
      console.error("[trigger] pad " + index + " — PLAY ERROR:", err);
    }

    pads[index].classList.add("active");
    setTimeout(function () { pads[index].classList.remove("active"); }, 120);
  }

  // =========================================================================
  //  Tilt
  // =========================================================================

  function handleOrientation(e) {
    var beta = e.beta;
    var gamma = e.gamma;

    orientationEventCount++;
    // Log first 5 events, then every 100th
    if (orientationEventCount <= 5 || orientationEventCount % 100 === 0) {
      console.log("[tilt] #" + orientationEventCount + " beta:", beta, "gamma:", gamma);
    }

    if (beta === null || gamma === null) {
      console.warn("[tilt] null values — beta:", beta, "gamma:", gamma);
      return;
    }

    if (refBeta === null) {
      refBeta = beta;
      refGamma = gamma;
      console.log("[tilt] Calibrated — refBeta:", refBeta.toFixed(1), "refGamma:", refGamma.toFixed(1));
    }

    var db = beta - refBeta;
    var dg = gamma - refGamma;

    var s = sensitivity;
    var clampedB = Math.max(-s, Math.min(s, db));
    var clampedG = Math.max(-s, Math.min(s, dg));

    var vizRect = tiltViz.getBoundingClientRect();
    var cx = vizRect.width / 2;
    var cy = vizRect.height / 2;
    tiltDot.style.left = (cx + (clampedG / s) * cx) + "px";
    tiltDot.style.top = (cy + (clampedB / s) * cy) + "px";

    var absB = Math.abs(db);
    var absG = Math.abs(dg);

    if (Math.max(absB, absG) < DEAD_ZONE) {
      activeQuadrant = -1;
      return;
    }

    var quadrant;
    if (absB >= absG) {
      quadrant = db > 0 ? 2 : 0;
    } else {
      quadrant = dg > 0 ? 1 : 3;
    }

    if (quadrant !== activeQuadrant) {
      console.log("[tilt] quadrant changed:", activeQuadrant, "→", quadrant, "(db:", db.toFixed(1), "dg:", dg.toFixed(1) + ")");
      activeQuadrant = quadrant;
      triggerPad(quadrant);
    }
  }

  // =========================================================================
  //  Custom sample loading
  // =========================================================================

  var pendingFiles = [];

  function handleFiles(files) {
    if (!files || files.length === 0) return;
    pendingFiles = Array.from(files);
    console.log("[files] Selected", pendingFiles.length, "file(s)");

    if (pendingFiles.length === 1) {
      sampleLoader.classList.remove("hidden");
    } else {
      var count = Math.min(pendingFiles.length, PAD_COUNT);
      for (var i = 0; i < count; i++) {
        loadFileIntoPad(pendingFiles[i], i);
      }
      pendingFiles = [];
    }
  }

  function loadFileIntoPad(file, padIndex) {
    console.log("[files] Loading", file.name, "into pad", padIndex);
    var reader = new FileReader();
    reader.onload = function (e) {
      audioCtx.decodeAudioData(e.target.result, function (decoded) {
        sampleBuffers[padIndex] = decoded;
        console.log("[files] Decoded", file.name, "— duration:", decoded.duration.toFixed(3));
        var label = pads[padIndex].querySelector(".pad-label");
        label.textContent = file.name.replace(/\.[^.]+$/, "").slice(0, 12);
      }, function (err) {
        console.error("[files] decodeAudioData FAILED for", file.name, ":", err);
      });
    };
    reader.onerror = function (err) {
      console.error("[files] FileReader FAILED:", err);
    };
    reader.readAsArrayBuffer(file);
  }

  // =========================================================================
  //  Recalibrate
  // =========================================================================

  function recalibrate() {
    refBeta = null;
    refGamma = null;
    console.log("[tilt] Recalibrated (next event sets new center)");
  }

  // =========================================================================
  //  Start button — EVERYTHING must stay synchronous in the gesture stack
  // =========================================================================

  startBtn.addEventListener("click", function () {
    console.log("=== START BUTTON PRESSED ===");

    // 1. Audio context — create + resume synchronously in gesture
    initAudio();
    // resume() returns a promise but on iOS the state change happens
    // synchronously when called inside a user gesture
    audioCtx.resume();
    console.log("[start] After resume() call — state:", audioCtx.state);

    // 2. Generate buffers
    buildDefaultSamples();

    // 3. Play silent buffer to prime iOS audio pipeline
    try {
      var silent = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
      var src = audioCtx.createBufferSource();
      src.buffer = silent;
      src.connect(audioCtx.destination);
      src.start(0);
      console.log("[start] Silent buffer played OK");
    } catch (err) {
      console.error("[start] Silent buffer FAILED:", err);
    }

    // 4. Also play the kick immediately as an audible confirmation
    try {
      var kickSrc = audioCtx.createBufferSource();
      kickSrc.buffer = sampleBuffers[0];
      kickSrc.connect(gainNode);
      kickSrc.start(0);
      console.log("[start] Test kick played OK");
    } catch (err) {
      console.error("[start] Test kick FAILED:", err);
    }

    // 5. Motion permission — MUST be called synchronously in user gesture on iOS
    console.log("[start] DeviceOrientationEvent exists:", typeof DeviceOrientationEvent !== "undefined");
    console.log("[start] requestPermission exists:", typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function");

    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then(function (perm) {
        console.log("[motion] Permission result:", perm);
        if (perm === "granted") {
          window.addEventListener("deviceorientation", handleOrientation);
          console.log("[motion] Listener added");
        } else {
          console.warn("[motion] Permission DENIED");
          alert("Motion permission denied — tap pads to play instead.");
        }
      }).catch(function (err) {
        console.error("[motion] requestPermission FAILED:", err);
        window.addEventListener("deviceorientation", handleOrientation);
        console.log("[motion] Listener added (fallback after error)");
      });
    } else {
      window.addEventListener("deviceorientation", handleOrientation);
      console.log("[motion] Listener added (no permission API)");
    }

    // 6. Check context state after a short delay (to see if resume actually worked)
    setTimeout(function () {
      console.log("[start] Delayed check — ctx.state:", audioCtx ? audioCtx.state : "null");
    }, 500);

    startScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
    console.log("[start] UI switched to main screen");
  });

  // Tap pads
  pads.forEach(function (pad) {
    pad.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      var idx = parseInt(pad.dataset.index, 10);
      console.log("[tap] pad " + idx + " tapped, audioCtx:", audioCtx ? audioCtx.state : "null");
      if (audioCtx) resumeAudio();
      triggerPad(idx);
    });
  });

  // Double-tap tilt viz to recalibrate
  var lastTapTime = 0;
  tiltViz.addEventListener("pointerdown", function () {
    var now = performance.now();
    if (now - lastTapTime < 350) recalibrate();
    lastTapTime = now;
  });

  sensitivitySlider.addEventListener("input", function () {
    sensitivity = parseInt(sensitivitySlider.value, 10);
  });

  loadSamplesBtn.addEventListener("click", function () {
    fileInput.click();
  });

  fileInput.addEventListener("change", function () {
    handleFiles(fileInput.files);
    fileInput.value = "";
  });

  assignBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var idx = parseInt(btn.dataset.index, 10);
      if (pendingFiles.length > 0) {
        loadFileIntoPad(pendingFiles[0], idx);
        pendingFiles = [];
      }
      sampleLoader.classList.add("hidden");
    });
  });

  cancelAssign.addEventListener("click", function () {
    pendingFiles = [];
    sampleLoader.classList.add("hidden");
  });
})();
