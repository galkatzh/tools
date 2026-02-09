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
  var audioUnlocked = false;

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
  console.log("[init] window.AudioContext:", !!window.AudioContext);
  console.log("[init] window.webkitAudioContext:", !!window.webkitAudioContext);
  console.log("[init] UA:", navigator.userAgent);

  // =========================================================================
  //  Audio
  // =========================================================================

  function initAudio() {
    try {
      // iOS Safari: do NOT pass options — some versions silently break
      var Ctor = window.AudioContext || window.webkitAudioContext;
      console.log("[audio] Using:", Ctor === window.AudioContext ? "AudioContext" : "webkitAudioContext");

      audioCtx = new Ctor();
      console.log("[audio] Created — state:", audioCtx.state,
        "sampleRate:", audioCtx.sampleRate,
        "currentTime:", audioCtx.currentTime,
        "baseLatency:", audioCtx.baseLatency);

      // Track state changes
      audioCtx.onstatechange = function () {
        console.log("[audio] STATE CHANGED →", audioCtx.state, "currentTime:", audioCtx.currentTime);
      };

      gainNode = audioCtx.createGain();
      gainNode.gain.value = 1;
      gainNode.connect(audioCtx.destination);
      console.log("[audio] GainNode connected, gain:", gainNode.gain.value);
    } catch (err) {
      console.error("[audio] initAudio FAILED:", err.name, err.message);
    }
  }

  function tryUnlockAudio() {
    if (!audioCtx) return;

    console.log("[unlock] Attempting — state:", audioCtx.state, "currentTime:", audioCtx.currentTime);

    // Strategy 1: resume()
    try {
      audioCtx.resume().then(function () {
        console.log("[unlock] resume() resolved — state:", audioCtx.state, "currentTime:", audioCtx.currentTime);
      }).catch(function (err) {
        console.error("[unlock] resume() rejected:", err);
      });
    } catch (err) {
      console.error("[unlock] resume() threw:", err);
    }

    // Strategy 2: oscillator (known to work on stubborn iOS versions)
    try {
      var osc = audioCtx.createOscillator();
      osc.frequency.value = 1; // sub-audible
      osc.connect(audioCtx.destination);
      osc.start(0);
      osc.stop(audioCtx.currentTime + 0.001);
      console.log("[unlock] Oscillator played OK");
    } catch (err) {
      console.error("[unlock] Oscillator failed:", err);
    }

    // Strategy 3: silent buffer connected DIRECTLY to destination (bypass gainNode)
    try {
      var silent = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
      var src = audioCtx.createBufferSource();
      src.buffer = silent;
      src.connect(audioCtx.destination);
      src.start(0);
      console.log("[unlock] Silent buffer (direct) played OK");
    } catch (err) {
      console.error("[unlock] Silent buffer failed:", err);
    }

    // Check state after a tick
    setTimeout(function () {
      if (audioCtx) {
        console.log("[unlock] After tick — state:", audioCtx.state, "currentTime:", audioCtx.currentTime);
        if (audioCtx.state === "running" && audioCtx.currentTime > 0) {
          audioUnlocked = true;
          console.log("[unlock] ✓ AUDIO UNLOCKED");
        } else {
          console.warn("[unlock] ✗ Audio still NOT running. state:", audioCtx.state, "currentTime:", audioCtx.currentTime);
        }
      }
    }, 100);
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

    console.log("[trigger] pad " + index +
      " — ctx.state:", audioCtx.state +
      " currentTime:", audioCtx.currentTime.toFixed(3) +
      " buf.dur:", buffer.duration.toFixed(3) +
      " gain:", gainNode.gain.value);

    // Try both paths: through gainNode AND direct to destination
    try {
      var src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(gainNode);
      src.start(0);
      console.log("[trigger] pad " + index + " — via gainNode OK");
    } catch (err) {
      console.error("[trigger] pad " + index + " — gainNode FAILED:", err);
    }

    try {
      var src2 = audioCtx.createBufferSource();
      src2.buffer = buffer;
      src2.connect(audioCtx.destination);
      src2.start(0);
      console.log("[trigger] pad " + index + " — direct to destination OK");
    } catch (err) {
      console.error("[trigger] pad " + index + " — direct FAILED:", err);
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
    if (orientationEventCount <= 5 || orientationEventCount % 100 === 0) {
      console.log("[tilt] #" + orientationEventCount + " beta:", beta, "gamma:", gamma);
    }

    if (beta === null || gamma === null) {
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
      console.log("[tilt] quadrant:", activeQuadrant, "→", quadrant, "(db:", db.toFixed(1), "dg:", dg.toFixed(1) + ")");
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
    console.log("[tilt] Recalibrated");
  }

  // =========================================================================
  //  Start — use touchend (most reliable gesture on iOS) + click fallback
  // =========================================================================

  var startHandled = false;

  function handleStart(eventType) {
    if (startHandled) return;
    startHandled = true;

    console.log("=== START (" + eventType + ") ===");

    // 1. Create context (no options — safest for iOS)
    initAudio();

    // 2. Try every unlock strategy
    tryUnlockAudio();

    // 3. Generate sample buffers
    buildDefaultSamples();

    // 4. Play audible test kick via BOTH paths
    try {
      var kickSrc = audioCtx.createBufferSource();
      kickSrc.buffer = sampleBuffers[0];
      kickSrc.connect(gainNode);
      kickSrc.start(0);
      console.log("[start] Test kick (gainNode) OK");
    } catch (err) {
      console.error("[start] Test kick (gainNode) FAILED:", err);
    }
    try {
      var kickSrc2 = audioCtx.createBufferSource();
      kickSrc2.buffer = sampleBuffers[0];
      kickSrc2.connect(audioCtx.destination);
      kickSrc2.start(0);
      console.log("[start] Test kick (direct) OK");
    } catch (err) {
      console.error("[start] Test kick (direct) FAILED:", err);
    }

    // 5. Play an audible oscillator beep as ultimate test
    try {
      var beep = audioCtx.createOscillator();
      var beepGain = audioCtx.createGain();
      beep.frequency.value = 440;
      beepGain.gain.value = 0.3;
      beep.connect(beepGain);
      beepGain.connect(audioCtx.destination);
      beep.start(0);
      beep.stop(audioCtx.currentTime + 0.15);
      console.log("[start] 440Hz beep OK");
    } catch (err) {
      console.error("[start] 440Hz beep FAILED:", err);
    }

    // 6. Motion permission
    console.log("[start] DeviceOrientationEvent:", typeof DeviceOrientationEvent);
    console.log("[start] requestPermission:", typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission);

    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then(function (perm) {
        console.log("[motion] Permission:", perm);
        if (perm === "granted") {
          window.addEventListener("deviceorientation", handleOrientation);
          console.log("[motion] Listener added");
        } else {
          alert("Motion permission denied — tap pads to play instead.");
        }
      }).catch(function (err) {
        console.error("[motion] requestPermission error:", err);
        window.addEventListener("deviceorientation", handleOrientation);
      });
    } else {
      window.addEventListener("deviceorientation", handleOrientation);
      console.log("[motion] Listener added (no permission API)");
    }

    // 7. Periodic state check
    var checkCount = 0;
    var checker = setInterval(function () {
      checkCount++;
      if (audioCtx) {
        console.log("[check #" + checkCount + "] state:", audioCtx.state, "currentTime:", audioCtx.currentTime.toFixed(3));
      }
      if (checkCount >= 5) clearInterval(checker);
    }, 1000);

    startScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
    console.log("[start] UI switched");
  }

  // Bind BOTH touchend and click — touchend fires first on iOS and is
  // the most reliable event for audio unlock
  startBtn.addEventListener("touchend", function (e) {
    e.preventDefault();
    handleStart("touchend");
  });
  startBtn.addEventListener("click", function () {
    handleStart("click");
  });

  // Tap pads — also try to unlock on every tap
  pads.forEach(function (pad) {
    pad.addEventListener("touchend", function (e) {
      e.preventDefault();
      var idx = parseInt(pad.dataset.index, 10);
      console.log("[tap] pad " + idx + " (touchend) ctx:", audioCtx ? audioCtx.state : "null", "currentTime:", audioCtx ? audioCtx.currentTime.toFixed(3) : "n/a");
      if (audioCtx && audioCtx.state !== "running") {
        tryUnlockAudio();
      }
      triggerPad(idx);
    });
    pad.addEventListener("click", function () {
      var idx = parseInt(pad.dataset.index, 10);
      console.log("[tap] pad " + idx + " (click) ctx:", audioCtx ? audioCtx.state : "null");
      if (audioCtx && audioCtx.state !== "running") {
        tryUnlockAudio();
      }
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
