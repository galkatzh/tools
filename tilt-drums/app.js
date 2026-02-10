(function () {
  "use strict";

  var PAD_COUNT = 4;
  var RETRIGGER_COOLDOWN_MS = 120;

  var sampleBuffers = [];
  var sensitivity = 20;
  var lastTriggerTime = [0, 0, 0, 0];
  var refBeta = null;
  var refGamma = null;

  var startScreen = document.getElementById("start-screen");
  var mainScreen = document.getElementById("main-screen");
  var startBtn = document.getElementById("start-btn");
  var pads = document.querySelectorAll(".pad");
  var sensitivitySlider = document.getElementById("sensitivity");
  var cooldownSlider = document.getElementById("cooldown");
  var cooldownVal = document.getElementById("cooldown-val");
  var loadSamplesBtn = document.getElementById("load-samples-btn");
  var fileInput = document.getElementById("file-input");
  var sampleLoader = document.getElementById("sample-loader");
  var assignBtns = document.querySelectorAll(".assign-btn");
  var cancelAssign = document.getElementById("cancel-assign");
  var tiltBox = document.getElementById("tilt-box");
  var tiltRawDot = document.getElementById("tilt-raw-dot");
  var tiltSmoothDot = document.getElementById("tilt-smooth-dot");
  var tiltDeadzone = document.getElementById("tilt-deadzone");
  var tiltInfo = document.getElementById("tilt-info");
  var tiltLblTop = document.getElementById("tilt-lbl-top");
  var tiltLblBottom = document.getElementById("tilt-lbl-bottom");
  var tiltLblLeft = document.getElementById("tilt-lbl-left");
  var tiltLblRight = document.getElementById("tilt-lbl-right");

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
  //  Tilt → motion detection
  //
  //  Triggers pads based on tilt VELOCITY (flick gestures), not position.
  //  Dominant axis of the movement picks the direction:
  //    Forward  motion (beta-)  → pad 0 (Up)
  //    Right    motion (gamma+) → pad 1 (Right)
  //    Left     motion (gamma-) → pad 2 (Left)
  //    Backward motion (beta+)  → pad 3 (Down)
  // =========================================================================

  var aimedPad = -1;
  var smoothB = 0, smoothG = 0;
  var SMOOTH = 0.3;
  var eventCount = 0;
  var firstEventTime = 0;
  var DIR_NAMES = ["Up", "Right", "Left", "Down"];

  var prevRawB = 0, prevRawG = 0, prevTime = 0;
  var velB = 0, velG = 0;
  var VEL_SMOOTH = 0.5;
  var MOTION_COOLDOWN_MS = 200;
  var lastMotionTime = 0;

  // Auto-scaling range for the debug box — starts at ±10, grows with data
  var rangeB = 10, rangeG = 10;

  function setAimedPad(index) {
    if (index === aimedPad) return;
    if (aimedPad >= 0) pads[aimedPad].classList.remove("aimed");
    aimedPad = index;
    if (index >= 0) pads[index].classList.add("aimed");
  }

  // Position a dot element as percentage within the box.
  function placeDot(dot, g, b, rg, rb) {
    var px = 50 + (g / rg) * 50;
    var py = 50 + (b / rb) * 50; // forward (beta-) → negative → up
    px = Math.max(0, Math.min(100, px));
    py = Math.max(0, Math.min(100, py));
    dot.style.left = px + "%";
    dot.style.top = py + "%";
  }

  function getMotionThreshold() {
    // sensitivity 5..45 → threshold ~250..30 °/s
    return 300 - sensitivity * 6;
  }

  function motionDir(vb, vg) {
    if (Math.abs(vb) >= Math.abs(vg)) {
      return vb < 0 ? 0 : 3; // forward → Up(0), backward → Down(3)
    }
    return vg > 0 ? 1 : 2;   // right → Right(1), left → Left(2)
  }

  function handleOrientation(e) {
    var beta = e.beta, gamma = e.gamma;
    if (beta === null || gamma === null) return;

    if (refBeta === null) {
      refBeta = beta;
      refGamma = gamma;
    }

    var rawB = beta - refBeta, rawG = gamma - refGamma;

    smoothB = smoothB + SMOOTH * (rawB - smoothB);
    smoothG = smoothG + SMOOTH * (rawG - smoothG);

    eventCount++;
    if (eventCount === 1) firstEventTime = performance.now();
    var now = performance.now();
    var hz = eventCount > 1 ? (eventCount / ((now - firstEventTime) / 1000)).toFixed(0) : "?";

    // Grow range to fit observed values (never shrink)
    rangeB = Math.max(rangeB, Math.abs(rawB) * 1.2);
    rangeG = Math.max(rangeG, Math.abs(rawG) * 1.2);

    // Position dots (visualization)
    placeDot(tiltRawDot, rawG, rawB, rangeG, rangeB);
    placeDot(tiltSmoothDot, smoothG, smoothB, rangeG, rangeB);

    // Hide dead zone indicator (not used in motion mode)
    tiltDeadzone.style.display = "none";

    // Edge labels
    tiltLblLeft.textContent = "g:" + (-rangeG).toFixed(0);
    tiltLblRight.textContent = "g:+" + rangeG.toFixed(0);
    tiltLblTop.textContent = "Fwd b:-" + rangeB.toFixed(0);
    tiltLblBottom.textContent = "Back b:+" + rangeB.toFixed(0);

    // Compute velocity (°/s)
    var dt = prevTime > 0 ? (now - prevTime) / 1000 : 0;
    if (dt > 0 && dt < 0.1) {
      var rawVelB = (rawB - prevRawB) / dt;
      var rawVelG = (rawG - prevRawG) / dt;
      velB = velB + VEL_SMOOTH * (rawVelB - velB);
      velG = velG + VEL_SMOOTH * (rawVelG - velG);
    }
    prevRawB = rawB;
    prevRawG = rawG;
    prevTime = now;

    var absVB = Math.abs(velB), absVG = Math.abs(velG);
    var threshold = getMotionThreshold();
    var maxVel = Math.max(absVB, absVG);

    // Show aimed pad based on current velocity direction
    if (maxVel > threshold * 0.3) {
      setAimedPad(motionDir(velB, velG));
    } else {
      setAimedPad(-1);
    }

    // Trigger on significant motion
    if (maxVel >= threshold && now - lastMotionTime >= MOTION_COOLDOWN_MS) {
      triggerPad(motionDir(velB, velG));
      lastMotionTime = now;
    }

    // Info text
    tiltInfo.textContent =
      "vel b:" + velB.toFixed(0) + " g:" + velG.toFixed(0) + "/s" +
      "  thr:" + threshold.toFixed(0) +
      "  " + hz + "Hz" +
      (aimedPad >= 0 ? " " + DIR_NAMES[aimedPad] : "");
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

  cooldownSlider.addEventListener("input", function () {
    MOTION_COOLDOWN_MS = parseInt(cooldownSlider.value, 10);
    cooldownVal.textContent = MOTION_COOLDOWN_MS + "ms";
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
