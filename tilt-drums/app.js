(function () {
  "use strict";

  var PAD_COUNT = 4;
  var RETRIGGER_COOLDOWN_MS = 120;
  var DEAD_ZONE = 3;

  var sampleBuffers = [];
  var sensitivity = 20;
  var activeQuadrant = -1;
  var lastTriggerTime = [0, 0, 0, 0];
  var refBeta = null;
  var refGamma = null;

  var startScreen = document.getElementById("start-screen");
  var mainScreen = document.getElementById("main-screen");
  var startBtn = document.getElementById("start-btn");
  var pads = document.querySelectorAll(".pad");
  var sensitivitySlider = document.getElementById("sensitivity");
  var loadSamplesBtn = document.getElementById("load-samples-btn");
  var fileInput = document.getElementById("file-input");
  var sampleLoader = document.getElementById("sample-loader");
  var assignBtns = document.querySelectorAll(".assign-btn");
  var cancelAssign = document.getElementById("cancel-assign");
  var tiltDebug = document.getElementById("tilt-debug");

  // =========================================================================
  //  AudioContext — created at page load, resumed on first user gesture
  // =========================================================================

  var audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // =========================================================================
  //  Drum sample synthesis
  // =========================================================================

  function generateKick(ctx) {
    var sr = ctx.sampleRate, len = (sr * 0.4) | 0;
    var buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      d[i] = Math.sin(2 * Math.PI * 150 * Math.exp(-t * 12) * t) * Math.exp(-t * 8);
    }
    return buf;
  }

  function generateSnare(ctx) {
    var sr = ctx.sampleRate, len = (sr * 0.25) | 0;
    var buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      d[i] = ((Math.random() * 2 - 1) * 0.7 + Math.sin(2 * Math.PI * 200 * t) * 0.3) * Math.exp(-t * 18);
    }
    return buf;
  }

  function generateHiHat(ctx) {
    var sr = ctx.sampleRate, len = (sr * 0.08) | 0;
    var buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      d[i] = (Math.random() * 2 - 1) * Math.sin(2 * Math.PI * 8000 * t) * Math.exp(-t * 50) * 0.6;
    }
    return buf;
  }

  function generateClap(ctx) {
    var sr = ctx.sampleRate, len = (sr * 0.2) | 0;
    var buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / sr, env = 0;
      for (var b = 0; b < 4; b++) { var bt = t - b * 0.01; if (bt >= 0) env += Math.exp(-bt * 80); }
      env += Math.exp(-t * 20) * 0.5;
      d[i] = (Math.random() * 2 - 1) * env * 0.35;
    }
    return buf;
  }

  function buildDefaultSamples() {
    var gens = [generateKick, generateSnare, generateHiHat, generateClap];
    for (var i = 0; i < PAD_COUNT; i++) {
      sampleBuffers[i] = gens[i](audioCtx);
    }
  }

  // =========================================================================
  //  Playback — fire-and-forget BufferSourceNodes
  // =========================================================================

  function triggerPad(index) {
    var now = performance.now();
    if (now - lastTriggerTime[index] < RETRIGGER_COOLDOWN_MS) return;
    lastTriggerTime[index] = now;

    var buffer = sampleBuffers[index];
    if (!buffer) return;

    var src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start();

    pads[index].classList.add("active");
    setTimeout(function () { pads[index].classList.remove("active"); }, 120);
  }

  // =========================================================================
  //  Tilt → quadrant mapping
  //
  //  Calibrates on first reading. Dominant axis picks the quadrant:
  //    Forward  (beta+)  → pad 2    Backward (beta-)  → pad 0
  //    Right    (gamma+) → pad 1    Left     (gamma-) → pad 3
  // =========================================================================

  var aimedQuadrant = -1;
  var smoothB = 0, smoothG = 0;
  var SMOOTH = 0.3; // EMA alpha — 0 = no smoothing, 1 = raw
  var eventCount = 0;
  var firstEventTime = 0;
  var QUADRANT_NAMES = ["Back", "Right", "Fwd", "Left"];

  function setAimedPad(index) {
    if (index === aimedQuadrant) return;
    if (aimedQuadrant >= 0) pads[aimedQuadrant].classList.remove("aimed");
    aimedQuadrant = index;
    if (index >= 0) pads[index].classList.add("aimed");
  }

  function handleOrientation(e) {
    var beta = e.beta, gamma = e.gamma;
    if (beta === null || gamma === null) return;

    if (refBeta === null) {
      refBeta = beta;
      refGamma = gamma;
    }

    var rawB = beta - refBeta, rawG = gamma - refGamma;

    // Exponential moving average
    smoothB = smoothB + SMOOTH * (rawB - smoothB);
    smoothG = smoothG + SMOOTH * (rawG - smoothG);

    // Event rate
    eventCount++;
    if (eventCount === 1) firstEventTime = performance.now();
    var hz = eventCount > 1 ? (eventCount / ((performance.now() - firstEventTime) / 1000)).toFixed(0) : "?";

    var absB = Math.abs(smoothB), absG = Math.abs(smoothG);
    var quadrant = -1;
    if (Math.max(absB, absG) >= DEAD_ZONE) {
      if (absB >= absG) { quadrant = smoothB > 0 ? 2 : 0; }
      else { quadrant = smoothG > 0 ? 1 : 3; }
    }

    // Debug display
    tiltDebug.textContent =
      "raw  b:" + rawB.toFixed(1) + "  g:" + rawG.toFixed(1) + "\n" +
      "smooth  b:" + smoothB.toFixed(1) + "  g:" + smoothG.toFixed(1) + "\n" +
      hz + "Hz  q:" + (quadrant >= 0 ? quadrant + " " + QUADRANT_NAMES[quadrant] : "dead");

    if (quadrant < 0) {
      activeQuadrant = -1;
      setAimedPad(-1);
      return;
    }

    setAimedPad(quadrant);

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
      for (var i = 0; i < Math.min(pendingFiles.length, PAD_COUNT); i++) {
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
        pads[padIndex].querySelector(".pad-label").textContent =
          file.name.replace(/\.[^.]+$/, "").slice(0, 12);
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function recalibrate() { refBeta = null; refGamma = null; }

  // =========================================================================
  //  Start
  // =========================================================================

  startBtn.onclick = function () {
    audioCtx.resume();
    buildDefaultSamples();

    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then(function (perm) {
        if (perm === "granted") {
          window.addEventListener("deviceorientation", handleOrientation);
        }
      }).catch(function () {
        window.addEventListener("deviceorientation", handleOrientation);
      });
    } else {
      window.addEventListener("deviceorientation", handleOrientation);
    }

    startScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
  };

  // Pad taps
  pads.forEach(function (pad) {
    pad.onclick = function () {
      if (audioCtx.state !== "running") audioCtx.resume();
      triggerPad(parseInt(pad.dataset.index, 10));
    };
  });

  sensitivitySlider.addEventListener("input", function () {
    sensitivity = parseInt(sensitivitySlider.value, 10);
  });

  loadSamplesBtn.onclick = function () { fileInput.click(); };
  fileInput.addEventListener("change", function () {
    handleFiles(fileInput.files);
    fileInput.value = "";
  });

  assignBtns.forEach(function (btn) {
    btn.onclick = function () {
      var idx = parseInt(btn.dataset.index, 10);
      if (pendingFiles.length > 0) {
        loadFileIntoPad(pendingFiles[0], idx);
        pendingFiles = [];
      }
      sampleLoader.classList.add("hidden");
    };
  });

  cancelAssign.onclick = function () {
    pendingFiles = [];
    sampleLoader.classList.add("hidden");
  };
})();
