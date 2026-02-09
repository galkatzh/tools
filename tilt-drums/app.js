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

  function dbg(msg) {
    console.log(msg);
    if (debugEl) {
      debugEl.textContent += msg + "\n";
      debugEl.scrollTop = debugEl.scrollHeight;
    }
  }

  // =========================================================================
  //  iOS audio session unlock via <audio> element
  //
  //  iOS Web Audio uses the "ambient" audio session by default, which
  //  respects the hardware mute switch. Playing an <audio> element forces
  //  iOS into "playback" mode so all subsequent Web Audio output is audible.
  //
  //  We build a valid WAV blob programmatically (data URI MP3 was rejected
  //  silently by iOS Safari).
  // =========================================================================

  function createSilentWAV() {
    var sr = 44100, ch = 1, bps = 16;
    var numSamples = sr; // 1 second of silence
    var dataSize = numSamples * ch * (bps / 8);
    var buf = new ArrayBuffer(44 + dataSize);
    var v = new DataView(buf);

    function writeStr(offset, str) {
      for (var i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, "RIFF");
    v.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);       // PCM
    v.setUint16(22, ch, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * (bps / 8), true);
    v.setUint16(32, ch * (bps / 8), true);
    v.setUint16(34, bps, true);
    writeStr(36, "data");
    v.setUint32(40, dataSize, true);
    // PCM samples are all zeros (silence) — ArrayBuffer is zero-initialized
    return new Blob([buf], { type: "audio/wav" });
  }

  var audioEl = null;

  function unlockIOSAudio() {
    dbg("building WAV blob for <audio> unlock...");
    try {
      var blob = createSilentWAV();
      var url = URL.createObjectURL(blob);
      audioEl = new Audio(url);
      audioEl.setAttribute("playsinline", "");
      audioEl.volume = 1;
      dbg("<audio> src=" + url + " readyState=" + audioEl.readyState);

      var p = audioEl.play();
      if (p && p.then) {
        p.then(function () {
          dbg("<audio> play() OK — audio session should be 'playback' now");
          URL.revokeObjectURL(url);
        }).catch(function (err) {
          dbg("<audio> play() REJECTED: " + err);
        });
      } else {
        dbg("<audio> play() returned non-promise (old browser)");
      }
    } catch (err) {
      dbg("<audio> unlock FAILED: " + err);
    }
  }

  // =========================================================================
  //  AudioContext — created at page load
  // =========================================================================

  var AudioCtor = window.AudioContext || window.webkitAudioContext;
  var audioCtx;
  try {
    audioCtx = new AudioCtor();
    dbg("ctx created: state=" + audioCtx.state + " sr=" + audioCtx.sampleRate);
  } catch (err) {
    dbg("ctx FAILED: " + err);
  }

  if (audioCtx) {
    audioCtx.onstatechange = function () {
      dbg("ctx -> " + audioCtx.state + " t=" + audioCtx.currentTime.toFixed(3));
    };
  }

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
    var names = ["Kick", "Snare", "HiHat", "Clap"];
    var gens = [generateKick, generateSnare, generateHiHat, generateClap];
    for (var i = 0; i < PAD_COUNT; i++) {
      sampleBuffers[i] = gens[i](audioCtx);
      dbg(names[i] + ": " + sampleBuffers[i].duration.toFixed(3) + "s");
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

    var src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start();

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
  //  START
  // =========================================================================

  startBtn.onclick = function () {
    dbg("=== START ===");

    // 1. Force iOS into "playback" audio session by playing <audio> element
    unlockIOSAudio();

    // 2. Resume Web Audio context
    audioCtx.resume().then(function () {
      dbg("resume OK: state=" + audioCtx.state + " t=" + audioCtx.currentTime.toFixed(3));
    });

    // 3. Build samples
    buildDefaultSamples();

    // 4. Play test beep (should now be audible even with mute switch)
    try {
      var osc = audioCtx.createOscillator();
      osc.frequency.value = 440;
      var g = audioCtx.createGain();
      g.gain.value = 0.3;
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.2);
      dbg("beep scheduled");
    } catch (err) {
      dbg("beep err: " + err);
    }

    // 5. Motion permission
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then(function (perm) {
        dbg("motion: " + perm);
        if (perm === "granted") {
          window.addEventListener("deviceorientation", handleOrientation);
        }
      }).catch(function (err) {
        dbg("motion err: " + err);
        window.addEventListener("deviceorientation", handleOrientation);
      });
    } else {
      window.addEventListener("deviceorientation", handleOrientation);
    }

    // 6. Check
    var n = 0;
    var iv = setInterval(function () {
      n++;
      dbg("#" + n + " state=" + audioCtx.state + " t=" + audioCtx.currentTime.toFixed(3));
      if (n >= 3) clearInterval(iv);
    }, 1000);

    startScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
  };

  // Pad taps
  pads.forEach(function (pad) {
    pad.onclick = function () {
      var idx = parseInt(pad.dataset.index, 10);
      if (audioCtx.state !== "running") audioCtx.resume();
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
