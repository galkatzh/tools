(function () {
  "use strict";

  // --- Config ---
  const PAD_COUNT = 4;
  const RETRIGGER_COOLDOWN_MS = 150; // min ms between re-triggers of the same pad
  const DEAD_ZONE = 3; // degrees – ignore tiny movements near center

  // --- Default samples (synthesised via Tone so we ship zero assets) ---
  // We create short buffer-based players from generated AudioBuffers for
  // the lowest possible playback latency (no decoding on trigger).

  let audioCtx; // raw AudioContext used for buffer generation
  let players = new Array(PAD_COUNT); // Tone.Player instances
  let buffers = new Array(PAD_COUNT); // Tone.ToneAudioBuffer

  // --- State ---
  let sensitivity = 20; // degrees from center to edge of zone
  let activeQuadrant = -1; // currently triggered quadrant (0-3, -1 = dead zone)
  let lastTriggerTime = new Array(PAD_COUNT).fill(0);
  let started = false;

  // --- DOM refs ---
  const startScreen = document.getElementById("start-screen");
  const mainScreen = document.getElementById("main-screen");
  const startBtn = document.getElementById("start-btn");
  const pads = document.querySelectorAll(".pad");
  const tiltDot = document.getElementById("tilt-dot");
  const tiltViz = document.getElementById("tilt-viz");
  const sensitivitySlider = document.getElementById("sensitivity");
  const loadSamplesBtn = document.getElementById("load-samples-btn");
  const fileInput = document.getElementById("file-input");
  const sampleLoader = document.getElementById("sample-loader");
  const assignBtns = document.querySelectorAll(".assign-btn");
  const cancelAssign = document.getElementById("cancel-assign");

  // =========================================================================
  //  Audio buffer generation (default drum sounds)
  // =========================================================================

  function generateKick(ctx, sr) {
    const len = sr * 0.4;
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const freq = 150 * Math.exp(-t * 12);
      const amp = Math.exp(-t * 8);
      d[i] = Math.sin(2 * Math.PI * freq * t) * amp;
    }
    return buf;
  }

  function generateSnare(ctx, sr) {
    const len = sr * 0.25;
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const noise = Math.random() * 2 - 1;
      const tone = Math.sin(2 * Math.PI * 200 * t);
      const amp = Math.exp(-t * 18);
      d[i] = (noise * 0.7 + tone * 0.3) * amp;
    }
    return buf;
  }

  function generateHiHat(ctx, sr) {
    const len = sr * 0.08;
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const noise = Math.random() * 2 - 1;
      // band-pass–ish: multiply noise by high-freq sine
      const bp = noise * Math.sin(2 * Math.PI * 8000 * t);
      d[i] = bp * Math.exp(-t * 50) * 0.6;
    }
    return buf;
  }

  function generateClap(ctx, sr) {
    const len = sr * 0.2;
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const noise = Math.random() * 2 - 1;
      // multiple short bursts
      let env = 0;
      for (let b = 0; b < 4; b++) {
        const bt = t - b * 0.01;
        if (bt >= 0) env += Math.exp(-bt * 80);
      }
      // longer tail
      env += Math.exp(-t * 20) * 0.5;
      d[i] = noise * env * 0.35;
    }
    return buf;
  }

  const generators = [generateKick, generateSnare, generateHiHat, generateClap];

  // =========================================================================
  //  Build Tone players
  // =========================================================================

  function buildDefaultPlayers() {
    audioCtx = Tone.context.rawContext;
    const sr = audioCtx.sampleRate;

    for (let i = 0; i < PAD_COUNT; i++) {
      const rawBuf = generators[i](audioCtx, sr);
      buffers[i] = new Tone.ToneAudioBuffer().fromArray(rawBuf.getChannelData(0));
      createPlayer(i, buffers[i]);
    }
  }

  function createPlayer(index, toneBuffer) {
    if (players[index]) {
      players[index].dispose();
    }
    const player = new Tone.Player(toneBuffer).toDestination();
    // keep player hot – reduces first-trigger latency
    player.playbackRate = 1;
    players[index] = player;
  }

  // =========================================================================
  //  Trigger logic
  // =========================================================================

  function triggerPad(index) {
    const now = performance.now();
    if (now - lastTriggerTime[index] < RETRIGGER_COOLDOWN_MS) return;
    lastTriggerTime[index] = now;

    const player = players[index];
    if (!player || !player.loaded) return;

    // Stop then immediately restart for rapid re-triggers
    player.stop();
    player.start();

    // Visual feedback
    pads[index].classList.add("active");
    setTimeout(() => pads[index].classList.remove("active"), 120);
  }

  // =========================================================================
  //  Tilt → quadrant mapping
  //
  //  Phone flat on table: beta ≈ 0, gamma ≈ 0  (we use this as center)
  //  Tilt forward  (top away):   beta increases  → quadrant 0 (top)
  //  Tilt backward (top toward): beta decreases  → quadrant 2 (bottom)
  //  Tilt right:                 gamma increases  → quadrant 1 (right)
  //  Tilt left:                  gamma decreases  → quadrant 3 (left)
  //
  //  We pick whichever axis has the largest absolute deflection.
  // =========================================================================

  let refBeta = null; // calibration reference
  let refGamma = null;

  function handleOrientation(e) {
    let beta = e.beta;   // -180..180 (front/back tilt)
    let gamma = e.gamma; // -90..90  (left/right tilt)

    if (beta === null || gamma === null) return;

    // On first reading, calibrate so current position = center
    if (refBeta === null) {
      refBeta = beta;
      refGamma = gamma;
    }

    // Relative to calibration point
    let db = beta - refBeta;
    let dg = gamma - refGamma;

    // Clamp to [-sensitivity, sensitivity] for visualisation
    const s = sensitivity;
    const clampedB = Math.max(-s, Math.min(s, db));
    const clampedG = Math.max(-s, Math.min(s, dg));

    // Update dot position (CSS: top = forward = negative Y on screen)
    const vizRect = tiltViz.getBoundingClientRect();
    const cx = vizRect.width / 2;
    const cy = vizRect.height / 2;
    const dotX = cx + (clampedG / s) * cx;
    const dotY = cy + (clampedB / s) * cy;
    tiltDot.style.left = dotX + "px";
    tiltDot.style.top = dotY + "px";

    // Determine quadrant
    const absB = Math.abs(db);
    const absG = Math.abs(dg);
    const maxDeflection = Math.max(absB, absG);

    if (maxDeflection < DEAD_ZONE) {
      // In dead zone – no trigger
      if (activeQuadrant !== -1) {
        activeQuadrant = -1;
      }
      return;
    }

    let quadrant;
    if (absB >= absG) {
      quadrant = db > 0 ? 2 : 0; // forward(+beta)=bottom pad, backward=top pad
    } else {
      quadrant = dg > 0 ? 1 : 3; // right=right pad, left=left pad
    }

    if (quadrant !== activeQuadrant) {
      activeQuadrant = quadrant;
      triggerPad(quadrant);
    }
  }

  // =========================================================================
  //  Custom sample loading
  // =========================================================================

  let pendingFiles = [];

  function handleFiles(files) {
    if (!files || files.length === 0) return;
    pendingFiles = Array.from(files);

    if (pendingFiles.length === 1) {
      // Show pad picker
      sampleLoader.classList.remove("hidden");
    } else {
      // Auto-assign to pads in order
      const count = Math.min(pendingFiles.length, PAD_COUNT);
      for (let i = 0; i < count; i++) {
        loadFileIntoPad(pendingFiles[i], i);
      }
      pendingFiles = [];
    }
  }

  function loadFileIntoPad(file, padIndex) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const arrayBuf = e.target.result;
      Tone.context.rawContext.decodeAudioData(arrayBuf).then(function (decoded) {
        const toneBuf = new Tone.ToneAudioBuffer().fromArray(decoded.getChannelData(0));
        createPlayer(padIndex, toneBuf);
        // Update label
        const label = pads[padIndex].querySelector(".pad-label");
        label.textContent = file.name.replace(/\.[^.]+$/, "").slice(0, 12);
      });
    };
    reader.readAsArrayBuffer(file);
  }

  // =========================================================================
  //  Recalibrate on tap
  // =========================================================================

  function recalibrate() {
    refBeta = null;
    refGamma = null;
  }

  // =========================================================================
  //  Init & event binding
  // =========================================================================

  startBtn.addEventListener("click", async function () {
    // Must start Tone from a user gesture
    await Tone.start();

    // Lower latency: shrink buffer if possible
    if (Tone.context.rawContext.baseLatency !== undefined) {
      try {
        // Try to recreate context with lower latency
        const newCtx = new AudioContext({ latencyHint: "interactive", sampleRate: 44100 });
        await Tone.setContext(new Tone.Context(newCtx));
      } catch (_) {
        // keep default context
      }
    }

    buildDefaultPlayers();

    // Request motion permission (required on iOS 13+)
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== "granted") {
          alert("Motion permission denied. Tap pads to play instead.");
        }
      } catch (_) {
        // ignore
      }
    }

    window.addEventListener("deviceorientation", handleOrientation);

    startScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
    started = true;
  });

  // Tap pads as fallback / desktop testing
  pads.forEach(function (pad) {
    pad.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      const idx = parseInt(pad.dataset.index, 10);
      triggerPad(idx);
    });
  });

  // Double-tap the viz area to recalibrate
  let lastTapTime = 0;
  tiltViz.addEventListener("pointerdown", function () {
    const now = performance.now();
    if (now - lastTapTime < 350) {
      recalibrate();
    }
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
      const idx = parseInt(btn.dataset.index, 10);
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
