(function () {
  "use strict";

  // =========================================================================
  //  Global error reporting — nothing fails silently
  // =========================================================================

  var errorBanner = document.createElement("div");
  errorBanner.id = "error-banner";
  errorBanner.className = "hidden";
  document.body.appendChild(errorBanner);
  errorBanner.onclick = function () { errorBanner.classList.add("hidden"); };

  function showErrorBanner(msg) {
    errorBanner.textContent = msg + " (tap to dismiss)";
    errorBanner.classList.remove("hidden");
  }

  window.addEventListener("error", function (e) {
    showErrorBanner(e.message || "Unknown error");
  });
  window.addEventListener("unhandledrejection", function (e) {
    console.error("Unhandled rejection:", e.reason);
    showErrorBanner(String((e.reason && e.reason.message) || e.reason));
  });

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
  // Indexed by data-index — DOM order (0,2,1,3 for the d-pad cross) differs
  // from pad index, so a plain querySelectorAll NodeList would mismatch.
  var pads = [];
  document.querySelectorAll(".pad").forEach(function (pad) {
    pads[parseInt(pad.dataset.index, 10)] = pad;
  });
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

  // Looper DOM
  var loopRecBtn = document.getElementById("loop-rec");
  var loopStopBtn = document.getElementById("loop-stop");
  var loopPlayBtn = document.getElementById("loop-play");
  var loopDoubleBtn = document.getElementById("loop-double");
  var loopClearBtn = document.getElementById("loop-clear");
  var loopFill = document.getElementById("loop-fill");
  var loopStatusEl = document.getElementById("loop-status");

  // =========================================================================
  //  AudioContext — created at page load, resumed on first user gesture
  // =========================================================================

  var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Tell iOS to play audio even when the device is on silent.
  // navigator.audioSession is a Safari-only API; no-op on other browsers.
  if (navigator.audioSession) {
    navigator.audioSession.type = 'playback';
  }
  Tone.setContext(audioCtx);

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

    captureLoopEvent(index, buffer);
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
    return vg > 0 ? 1 : 2;   // right (gamma+) → Right(1), left (gamma-) → Left(2)
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

  /** Decode an ArrayBuffer of audio and assign it to a pad. Returns a Promise. */
  function loadSampleIntoPad(arrayBuffer, name, padIndex) {
    return new Promise(function (resolve, reject) {
      audioCtx.decodeAudioData(arrayBuffer, resolve, reject);
    }).then(function (decoded) {
      sampleBuffers[padIndex] = decoded;
      pads[padIndex].querySelector(".pad-label").textContent = name.slice(0, 12);
    });
  }

  function loadFileIntoPad(file, padIndex) {
    file.arrayBuffer().then(function (buf) {
      return loadSampleIntoPad(buf, file.name.replace(/\.[^.]+$/, ""), padIndex);
    }).catch(function (err) {
      console.error("Failed to load sample", file.name, err);
      showErrorBanner('Could not load "' + file.name + '": ' + (err.message || err));
    });
  }

  // Interface for freesound.js, plus accessors for console debugging / tests.
  window.tiltDrums = {
    loadSampleIntoPad: loadSampleIntoPad,
    getLoopEvents: function () { return loopEvents; },
    getLoopDuration: function () { return loopDuration; },
    getPadBuffer: function (i) { return sampleBuffers[i]; },
  };

  function recalibrate() { refBeta = null; refGamma = null; }

  // =========================================================================
  //  Loop pedal — event sequencer backed by Tone.Transport
  //
  //  Workflow (like a guitar loop pedal):
  //    1. Press REC → start capturing pad hits with timestamps
  //    2. Press REC again → set loop length, begin looped playback + overdub
  //    3. Keep playing → new hits layer on top each pass
  //    4. Press REC → exit overdub (playback continues)
  //    5. Press STOP → silence   |   PLAY → resume   |   ×2 → double length
  //    6. Tap ✕ → clear all; HOLD ✕ and tap a pad → delete just the hits
  //       whose sound is currently on that pad
  //
  //  Each event captures the pad's AudioBuffer at record time, so loading a
  //  new sound onto a pad layers on top of the old hits instead of rewriting
  //  them. Hits whose sound is no longer on any pad can only be removed by
  //  the global clear.
  // =========================================================================

  var loopEvents = [];       // [{pad, time, buffer}] — time in s from loop start
  var loopDuration = 0;      // seconds; set when first recording pass ends
  var loopState = "idle";    // idle | recording | overdubbing | playing
  var recordStartTime = 0;   // Tone.now() when recording began
  var loopTickId = null;     // rAF id for progress / status updates
  var scheduledIds = [];     // Tone.Transport event IDs for cleanup

  /** Play a recorded loop event at the current moment (used by the sequencer). */
  function playEvent(evt) {
    var src = audioCtx.createBufferSource();
    src.buffer = evt.buffer;
    src.connect(audioCtx.destination);
    src.start();
    pads[evt.pad].classList.add("active");
    setTimeout(function () { pads[evt.pad].classList.remove("active"); }, 120);
  }

  /** Capture a pad hit into the loop (no-op unless recording/overdubbing). */
  function captureLoopEvent(padIndex, buffer) {
    if (loopState !== "recording" && loopState !== "overdubbing") return;

    var offset;
    if (loopState === "recording") {
      offset = Tone.now() - recordStartTime;
    } else {
      // Wrap to current position within loop
      offset = Tone.Transport.seconds % loopDuration;
    }

    var evt = { pad: padIndex, time: offset, buffer: buffer };
    loopEvents.push(evt);

    // During overdub, schedule immediately so it plays on subsequent cycles
    if (loopState === "overdubbing") {
      var id = Tone.Transport.schedule(function () { playEvent(evt); }, evt.time);
      scheduledIds.push(id);
    }
  }

  /** Clear all Tone.Transport scheduled events and re-schedule from loopEvents. */
  function scheduleAllEvents() {
    scheduledIds.forEach(function (id) { Tone.Transport.clear(id); });
    scheduledIds = [];
    loopEvents.forEach(function (evt) {
      var id = Tone.Transport.schedule(function () { playEvent(evt); }, evt.time);
      scheduledIds.push(id);
    });
  }

  /** Start the rAF tick that drives the progress bar and status text. */
  function startTick() {
    if (loopTickId !== null) return;
    (function tick() {
      switch (loopState) {
        case "recording":
          loopStatusEl.textContent = "REC " + (Tone.now() - recordStartTime).toFixed(1) + "s";
          break;
        case "overdubbing":
        case "playing":
          loopFill.style.width = (Tone.Transport.progress * 100) + "%";
          break;
        default:
          loopFill.style.width = "0%";
          return; // stop ticking
      }
      loopTickId = requestAnimationFrame(tick);
    })();
  }

  function stopTick() {
    if (loopTickId !== null) { cancelAnimationFrame(loopTickId); loopTickId = null; }
    loopFill.style.width = "0%";
  }

  /** Update button active states and status label. */
  function updateLoopUI() {
    loopRecBtn.classList.toggle("rec-active", loopState === "recording" || loopState === "overdubbing");
    loopPlayBtn.classList.toggle("play-active", loopState === "playing" || loopState === "overdubbing");
    loopDoubleBtn.disabled = !loopDuration || loopState === "recording";
    if (loopState === "idle") {
      loopStatusEl.textContent = loopDuration ? loopDuration.toFixed(1) + "s loop" : "";
    } else if (loopState === "overdubbing") {
      loopStatusEl.textContent = "OVERDUB";
    } else if (loopState === "playing") {
      loopStatusEl.textContent = "PLAY";
    }
  }

  // ---- Looper button handlers ----

  loopRecBtn.onclick = function () {
    switch (loopState) {
      case "idle":
        recordStartTime = Tone.now();
        loopEvents = [];
        loopDuration = 0;
        loopState = "recording";
        startTick();
        break;
      case "recording":
        loopDuration = Tone.now() - recordStartTime;
        if (loopDuration < 0.2) return; // ignore accidental double-tap
        Tone.Transport.loop = true;
        Tone.Transport.loopStart = 0;
        Tone.Transport.loopEnd = loopDuration;
        scheduleAllEvents();
        Tone.Transport.start();
        loopState = "overdubbing";
        break;
      case "overdubbing":
        loopState = "playing";
        break;
      case "playing":
        loopState = "overdubbing";
        break;
    }
    updateLoopUI();
  };

  loopStopBtn.onclick = function () {
    if (loopState === "idle") return;
    if (loopState === "recording") {
      loopEvents = [];
      loopDuration = 0;
    }
    Tone.Transport.stop();
    Tone.Transport.cancel();
    scheduledIds = [];
    stopTick();
    loopState = "idle";
    updateLoopUI();
  };

  loopPlayBtn.onclick = function () {
    if (loopState !== "idle" || !loopDuration) return;
    Tone.Transport.loop = true;
    Tone.Transport.loopStart = 0;
    Tone.Transport.loopEnd = loopDuration;
    scheduleAllEvents();
    Tone.Transport.start();
    loopState = "playing";
    startTick();
    updateLoopUI();
  };

  /** Double the loop length, duplicating existing hits into the new half. */
  loopDoubleBtn.onclick = function () {
    if (!loopDuration || loopState === "recording") return;
    loopEvents = loopEvents.concat(loopEvents.map(function (evt) {
      return { pad: evt.pad, time: evt.time + loopDuration, buffer: evt.buffer };
    }));
    loopDuration *= 2;
    if (loopState === "playing" || loopState === "overdubbing") {
      Tone.Transport.loopEnd = loopDuration;
      scheduleAllEvents();
    }
    updateLoopUI();
  };

  function clearLoop() {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    scheduledIds = [];
    loopEvents = [];
    loopDuration = 0;
    stopTick();
    loopState = "idle";
    updateLoopUI();
  }

  // ---- ✕ button: tap = clear everything; hold + tap pads = per-pad delete ----
  //
  // While ✕ is held, tapping a pad removes the hits whose sound is CURRENTLY
  // on that pad (matched by buffer, so hits of an old, since-replaced sound
  // survive — those are only removable with the global clear).

  var deleteArmed = false;
  var padDeleteUsed = false;

  /** Remove loop hits whose sound is currently assigned to this pad. */
  function deletePadSoundFromLoop(padIndex) {
    var buf = sampleBuffers[padIndex];
    var kept = loopEvents.filter(function (evt) { return evt.buffer !== buf; });
    var removed = loopEvents.length - kept.length;
    loopEvents = kept;
    if (removed && (loopState === "playing" || loopState === "overdubbing")) {
      scheduleAllEvents();
    }
    loopStatusEl.textContent = removed
      ? "Removed " + removed + " hit" + (removed === 1 ? "" : "s")
      : "No hits with this pad's sound";
  }

  loopClearBtn.addEventListener("pointerdown", function (e) {
    // Capture so we still get pointerup if the finger slides off the button.
    // (Skipped for synthetic events, whose pointerId isn't capturable.)
    if (e.isTrusted) loopClearBtn.setPointerCapture(e.pointerId);
    deleteArmed = true;
    padDeleteUsed = false;
    document.body.classList.add("delete-armed");
    loopStatusEl.textContent = "Tap a pad to delete its sound / release to clear all";
  });

  loopClearBtn.addEventListener("pointerup", function () {
    var deletedPadSound = padDeleteUsed;
    deleteArmed = false;
    document.body.classList.remove("delete-armed");
    if (!deletedPadSound) clearLoop(); // plain tap → global clear
  });

  loopClearBtn.addEventListener("pointercancel", function () {
    deleteArmed = false;
    document.body.classList.remove("delete-armed");
    updateLoopUI();
  });

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

  // Pad taps — also the target half of the delete combo (hold ✕ + tap pad).
  // A pad tapped while ✕ is held deletes instead of playing, so its click
  // (which fires after pointerup) must be swallowed.
  var suppressPadClick = [false, false, false, false];
  pads.forEach(function (pad, idx) {
    pad.addEventListener("pointerdown", function () {
      if (!deleteArmed) return;
      padDeleteUsed = true;
      suppressPadClick[idx] = true;
      deletePadSoundFromLoop(idx);
    });
    pad.onclick = function () {
      if (suppressPadClick[idx]) {
        suppressPadClick[idx] = false;
        return;
      }
      if (audioCtx.state !== "running") audioCtx.resume();
      triggerPad(idx);
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

  updateLoopUI();
})();
