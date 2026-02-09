(function () {
  "use strict";

  // --- Config ---
  var PAD_COUNT = 4;
  var RETRIGGER_COOLDOWN_MS = 120;
  var DEAD_ZONE = 3;

  // --- State ---
  var audioCtx = null;       // raw AudioContext (single instance, never replaced)
  var sampleBuffers = [];    // AudioBuffer per pad (raw Web Audio buffers)
  var gainNode = null;       // master gain
  var sensitivity = 20;
  var activeQuadrant = -1;
  var lastTriggerTime = [0, 0, 0, 0];
  var refBeta = null;
  var refGamma = null;

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

  // =========================================================================
  //  Audio — use raw Web Audio API for guaranteed iOS compat & lowest latency
  // =========================================================================

  function initAudio() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor({ latencyHint: "interactive" });
    gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);
  }

  // Resume context (must be called inside user gesture on iOS)
  function resumeAudio() {
    if (audioCtx && audioCtx.state !== "running") {
      return audioCtx.resume();
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
    var gens = [generateKick, generateSnare, generateHiHat, generateClap];
    for (var i = 0; i < PAD_COUNT; i++) {
      sampleBuffers[i] = gens[i]();
    }
  }

  // =========================================================================
  //  Playback — fire-and-forget BufferSourceNodes (lowest possible latency)
  // =========================================================================

  function triggerPad(index) {
    var now = performance.now();
    if (now - lastTriggerTime[index] < RETRIGGER_COOLDOWN_MS) return;
    lastTriggerTime[index] = now;

    var buffer = sampleBuffers[index];
    if (!buffer) return;

    // Each trigger creates a fresh source node (they're cheap & one-shot)
    var src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(gainNode);
    src.start(0);

    // Visual feedback
    pads[index].classList.add("active");
    setTimeout(function () { pads[index].classList.remove("active"); }, 120);
  }

  // =========================================================================
  //  Tilt → quadrant mapping
  //
  //  Calibrates on first reading so current phone position = center.
  //  Dominant axis picks the quadrant:
  //    Forward  (beta+)  → pad 2 (bottom-left)
  //    Backward (beta-)  → pad 0 (top-left)
  //    Right    (gamma+) → pad 1 (top-right)
  //    Left     (gamma-) → pad 3 (bottom-right)
  // =========================================================================

  function handleOrientation(e) {
    var beta = e.beta;
    var gamma = e.gamma;

    if (beta === null || gamma === null) return;

    // Calibrate on first reading
    if (refBeta === null) {
      refBeta = beta;
      refGamma = gamma;
    }

    var db = beta - refBeta;
    var dg = gamma - refGamma;

    // Update tilt dot
    var s = sensitivity;
    var clampedB = Math.max(-s, Math.min(s, db));
    var clampedG = Math.max(-s, Math.min(s, dg));

    var vizRect = tiltViz.getBoundingClientRect();
    var cx = vizRect.width / 2;
    var cy = vizRect.height / 2;
    tiltDot.style.left = (cx + (clampedG / s) * cx) + "px";
    tiltDot.style.top = (cy + (clampedB / s) * cy) + "px";

    // Pick quadrant
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
    var reader = new FileReader();
    reader.onload = function (e) {
      audioCtx.decodeAudioData(e.target.result, function (decoded) {
        sampleBuffers[padIndex] = decoded;
        var label = pads[padIndex].querySelector(".pad-label");
        label.textContent = file.name.replace(/\.[^.]+$/, "").slice(0, 12);
      });
    };
    reader.readAsArrayBuffer(file);
  }

  // =========================================================================
  //  Recalibrate
  // =========================================================================

  function recalibrate() {
    refBeta = null;
    refGamma = null;
  }

  // =========================================================================
  //  Init & events
  // =========================================================================

  startBtn.addEventListener("click", function () {
    // 1. Create & resume audio context inside this user gesture
    initAudio();

    resumeAudio().then(function () {
      // 2. Generate default drum buffers
      buildDefaultSamples();

      // 3. Play a silent buffer to fully unlock audio on iOS
      var silent = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
      var src = audioCtx.createBufferSource();
      src.buffer = silent;
      src.connect(audioCtx.destination);
      src.start(0);

      // 4. Request motion permission (iOS 13+ — must be inside user gesture)
      if (typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function") {
        DeviceOrientationEvent.requestPermission().then(function (perm) {
          if (perm === "granted") {
            window.addEventListener("deviceorientation", handleOrientation);
          } else {
            alert("Motion permission denied — tap pads to play instead.");
          }
        }).catch(function () {
          // Permission API failed — try listening anyway
          window.addEventListener("deviceorientation", handleOrientation);
        });
      } else {
        // Non-iOS or older iOS — just listen
        window.addEventListener("deviceorientation", handleOrientation);
      }

      startScreen.classList.add("hidden");
      mainScreen.classList.remove("hidden");
    });
  });

  // Tap pads directly (also works on desktop)
  pads.forEach(function (pad) {
    pad.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      // Ensure audio context is running (handles edge cases)
      if (audioCtx) resumeAudio();
      triggerPad(parseInt(pad.dataset.index, 10));
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
