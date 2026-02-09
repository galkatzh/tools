(function () {
  "use strict";

  var PAD_COUNT = 4;
  var RETRIGGER_COOLDOWN_MS = 120;
  var DEAD_ZONE = 3;

  var sampleBuffers = [];
  var gainNode = null;
  var sensitivity = 20;
  var activeQuadrant = -1;
  var lastTriggerTime = [0, 0, 0, 0];
  var refBeta = null;
  var refGamma = null;
  var orientationEventCount = 0;

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
  var debugEl = document.getElementById("debug-status");

  // ---- On-screen debug log ----
  function dbg(msg) {
    console.log(msg);
    if (debugEl) {
      debugEl.textContent += msg + "\n";
      debugEl.scrollTop = debugEl.scrollHeight;
    }
  }

  // =========================================================================
  //  Create AudioContext IMMEDIATELY at page load (before any gesture).
  //  iOS requires it to EXIST before the gesture that resumes it.
  // =========================================================================

  var AudioCtor = window.AudioContext || window.webkitAudioContext;
  var audioCtx;
  try {
    audioCtx = new AudioCtor();
    dbg("ctx created: state=" + audioCtx.state + " sr=" + audioCtx.sampleRate);
  } catch (err) {
    dbg("ctx creation FAILED: " + err);
  }

  if (audioCtx) {
    audioCtx.onstatechange = function () {
      dbg("ctx statechange -> " + audioCtx.state + " t=" + audioCtx.currentTime.toFixed(3));
    };
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(audioCtx.destination);
  }

  // =========================================================================
  //  Synthesised drum samples
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
    var names = ["Kick", "Snare", "HiHat", "Clap"];
    var gens = [generateKick, generateSnare, generateHiHat, generateClap];
    for (var i = 0; i < PAD_COUNT; i++) {
      sampleBuffers[i] = gens[i](audioCtx);
      dbg(names[i] + ": " + sampleBuffers[i].duration.toFixed(3) + "s " + sampleBuffers[i].length + " samples");
    }
  }

  // =========================================================================
  //  Playback
  // =========================================================================

  function triggerPad(index) {
    var now = performance.now();
    if (now - lastTriggerTime[index] < RETRIGGER_COOLDOWN_MS) return;
    lastTriggerTime[index] = now;

    var buffer = sampleBuffers[index];
    if (!buffer || !audioCtx) return;

    dbg("play " + index + " state=" + audioCtx.state + " t=" + audioCtx.currentTime.toFixed(3));

    var src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start(0);

    pads[index].classList.add("active");
    setTimeout(function () { pads[index].classList.remove("active"); }, 120);
  }

  // =========================================================================
  //  Tilt
  // =========================================================================

  function handleOrientation(e) {
    var beta = e.beta, gamma = e.gamma;
    orientationEventCount++;
    if (orientationEventCount <= 3 || orientationEventCount % 200 === 0) {
      dbg("tilt #" + orientationEventCount + " b=" + (beta && beta.toFixed(1)) + " g=" + (gamma && gamma.toFixed(1)));
    }

    if (beta === null || gamma === null) return;

    if (refBeta === null) {
      refBeta = beta;
      refGamma = gamma;
      dbg("calibrated ref b=" + refBeta.toFixed(1) + " g=" + refGamma.toFixed(1));
    }

    var db = beta - refBeta, dg = gamma - refGamma;
    var s = sensitivity;
    var clampedB = Math.max(-s, Math.min(s, db));
    var clampedG = Math.max(-s, Math.min(s, dg));

    var vizRect = tiltViz.getBoundingClientRect();
    var cx = vizRect.width / 2, cy = vizRect.height / 2;
    tiltDot.style.left = (cx + (clampedG / s) * cx) + "px";
    tiltDot.style.top = (cy + (clampedB / s) * cy) + "px";

    var absB = Math.abs(db), absG = Math.abs(dg);
    if (Math.max(absB, absG) < DEAD_ZONE) { activeQuadrant = -1; return; }

    var quadrant;
    if (absB >= absG) { quadrant = db > 0 ? 2 : 0; }
    else { quadrant = dg > 0 ? 1 : 3; }

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
        dbg("loaded " + file.name + " -> pad " + padIndex);
      }, function (err) { dbg("decode FAIL: " + err); });
    };
    reader.readAsArrayBuffer(file);
  }

  function recalibrate() { refBeta = null; refGamma = null; dbg("recalibrated"); }

  // =========================================================================
  //  START — only resume() + play here, context already exists
  // =========================================================================

  startBtn.onclick = function () {
    dbg("=== START tap ===");
    dbg("ctx.state BEFORE resume: " + audioCtx.state);

    // Resume the pre-existing context inside this user gesture
    audioCtx.resume().then(function () {
      dbg("resume() resolved: state=" + audioCtx.state + " t=" + audioCtx.currentTime.toFixed(3));
    }).catch(function (err) {
      dbg("resume() REJECTED: " + err);
    });

    dbg("ctx.state AFTER resume call: " + audioCtx.state);

    // Generate samples
    buildDefaultSamples();

    // Play an oscillator beep — the simplest possible audio output
    try {
      var osc = audioCtx.createOscillator();
      osc.frequency.value = 440;
      var g = audioCtx.createGain();
      g.gain.value = 0.3;
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.2);
      dbg("440Hz beep scheduled at t=" + audioCtx.currentTime.toFixed(3));
    } catch (err) {
      dbg("beep FAILED: " + err);
    }

    // Also play kick directly to destination
    try {
      var src = audioCtx.createBufferSource();
      src.buffer = sampleBuffers[0];
      src.connect(audioCtx.destination);
      src.start(0);
      dbg("test kick played");
    } catch (err) {
      dbg("test kick FAILED: " + err);
    }

    // Motion permission (iOS 13+)
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      dbg("requesting motion permission...");
      DeviceOrientationEvent.requestPermission().then(function (perm) {
        dbg("motion permission: " + perm);
        if (perm === "granted") {
          window.addEventListener("deviceorientation", handleOrientation);
        }
      }).catch(function (err) {
        dbg("motion permission error: " + err);
        window.addEventListener("deviceorientation", handleOrientation);
      });
    } else {
      window.addEventListener("deviceorientation", handleOrientation);
      dbg("no motion permission API, listener added");
    }

    // Periodic state check
    var n = 0;
    var iv = setInterval(function () {
      n++;
      dbg("check #" + n + " state=" + audioCtx.state + " t=" + audioCtx.currentTime.toFixed(3));
      if (n >= 5) clearInterval(iv);
    }, 1000);

    startScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
  };

  // ---- Pad taps ----
  pads.forEach(function (pad) {
    pad.onclick = function () {
      var idx = parseInt(pad.dataset.index, 10);
      dbg("tap pad " + idx + " state=" + audioCtx.state + " t=" + audioCtx.currentTime.toFixed(3));
      if (audioCtx.state !== "running") {
        audioCtx.resume();
        dbg("resume() called from pad tap");
      }
      triggerPad(idx);
    };
  });

  var lastTapTime = 0;
  tiltViz.addEventListener("pointerdown", function () {
    var now = performance.now();
    if (now - lastTapTime < 350) recalibrate();
    lastTapTime = now;
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
