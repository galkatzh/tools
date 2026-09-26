// @ts-check
// Fighter — weekend-1 recogniser spike. Webcam → MediaPipe PoseLandmarker →
// pose.js recogniser, with a latency readout and a drill recorder whose sessions
// replay through `evaluate` to score the recogniser offline.
// MediaPipe runs on the main thread for now: there is no game loop to block yet,
// and tasks-vision's loader is unreliable in module workers. Move it to a worker
// before the physics lands.
import { Recogniser, evaluate, pack, DEFAULTS, DISCRETE, CONTINUOUS } from './pose.js';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const MODEL = (v) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/1/pose_landmarker_${v}.task`;
const PRETTY = {
  hook_L: 'LEFT HOOK', hook_R: 'RIGHT HOOK', uppercut_L: 'LEFT UPPERCUT', uppercut_R: 'RIGHT UPPERCUT',
  guard: 'GUARD UP (hold)', duck: 'DUCK (hold)', lean_L: 'LEAN LEFT (hold)', lean_R: 'LEAN RIGHT (hold)',
};
const $ = (id) => /** @type {any} */ (document.getElementById(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Show an error in the page banner (callers log it to the console themselves). */
function showError(msg) {
  $('error').hidden = false;
  $('error').textContent += (($('error').textContent ? '\n' : '') + msg);
}
window.addEventListener('error', (e) => { console.error(e.error ?? e.message); showError(e.message); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); showError(String(e.reason?.message ?? e.reason)); });

const cfg = { ...DEFAULTS };
const rec = new Recogniser(cfg);
// Live tuning from the console, e.g. `fighter.cfg.hookSpeed = 3`. (Filter
// cutoffs are read when a filter is created, so change those before starting.)
Object.assign(window, { fighter: { cfg, rec } });

const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
let landmarker, PoseLandmarker, drawer, aspect = 4 / 3;
/** @type {import('./pose.js').Session & {start:number, mode:string}|null} */
let session = null;

// Rolling stats, refreshed in the HUD a few times a second.
const lat = [], inf = [];
let fpsMark = { t: 0, presented: 0, processed: 0 }, processed = 0, hudAt = 0;
const meanSd = (a) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return [m, Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length)];
};
const pushStat = (a, v) => { a.push(v); if (a.length > 90) a.shift(); };

async function start() {
  $('start').disabled = true;
  $('backend').textContent = 'loading model…';
  const vision = await import(`${MP}/vision_bundle.mjs`);
  PoseLandmarker = vision.PoseLandmarker;
  const files = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
  const variant = new URLSearchParams(location.search).get('model') || 'lite';
  const make = (delegate) => PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL(variant), delegate }, runningMode: 'VIDEO', numPoses: 1,
  });
  let backend = 'GPU';
  try { landmarker = await make('GPU'); } catch (e) {
    console.error('GPU delegate failed, falling back to CPU:', e);
    landmarker = await make('CPU');
    backend = 'CPU — GPU failed, see console';
  }
  $('backend').textContent = `${backend}, ${variant}`;

  video.srcObject = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } }, audio: false,
  });
  await video.play();
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  aspect = video.videoWidth / video.videoHeight;
  $('stage').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  drawer = new vision.DrawingUtils(ctx);
  for (const id of ['calibrate', 'drill', 'negatives']) $(id).disabled = false;
  video.requestVideoFrameCallback(onFrame);
}

/** Per camera frame: detect, draw, recognise, record. */
function onFrame(now, meta) {
  video.requestVideoFrameCallback(onFrame); // re-arm first, so a throw below can't stop the loop
  const t0 = performance.now();
  const res = landmarker.detectForVideo(video, now);
  const done = performance.now();
  // captureTime (Chromium, camera streams) is when the sensor captured the frame,
  // so done − captureTime is the full camera→recognition latency. Elsewhere we only
  // get presentationTime, which starts later and understates it — labelled as such.
  const captured = meta.captureTime ?? meta.presentationTime;
  $('latLabel').textContent = meta.captureTime ? 'Capture→event' : 'Present→event (no captureTime)';
  pushStat(lat, done - captured); pushStat(inf, done - t0); processed++;
  updateHud(now, meta);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const lm = res.landmarks[0], world = res.worldLandmarks[0];
  if (!lm) return;
  drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#3ccf7a', lineWidth: 3 });
  drawer.drawLandmarks(lm, { color: '#ffd23c', radius: 2 });

  if (session) session.frames.push({ t: captured - session.start, w: pack(world), i: pack(lm) });
  const { events, posture } = rec.update(world, lm, captured, aspect);
  for (const e of events) {
    const label = PRETTY[`${e.type}_${e.side}`], ms = Math.round(done - captured);
    console.log('ActionEvent', e, `${ms} ms after capture`);
    $('flash').textContent = label;
    $('flash').classList.remove('show'); void $('flash').offsetWidth; $('flash').classList.add('show');
    $('events').insertAdjacentHTML('afterbegin', `<li>${label} · power ${e.power.toFixed(2)} · ${ms} ms</li>`);
    $('events').children[30]?.remove();
  }
  $('guard').classList.toggle('on', posture.guard);
  $('duck').style.width = `${posture.duck * 100}%`;
  Object.assign($('lean').style, { left: `${50 + Math.min(0, posture.lean) * 50}%`, width: `${Math.abs(posture.lean) * 50}%` });
}

function updateHud(now, meta) {
  if (now - fpsMark.t >= 1000) {
    const s = (now - fpsMark.t) / 1000;
    if (fpsMark.t) {
      const cam = (meta.presentedFrames - fpsMark.presented) / s;
      $('camFps').textContent = cam.toFixed(0) + (cam < 25 ? ' ⚠ low — add light (webcams drop fps in dim rooms)' : '');
      const proc = (processed - fpsMark.processed) / s;
      $('procFps').textContent = proc.toFixed(0) + (proc < 25 ? ' ⚠ device too slow for the model' : '');
    }
    fpsMark = { t: now, presented: meta.presentedFrames, processed };
  }
  if (now - hudAt < 250) return;
  hudAt = now;
  const [lm, ls] = meanSd(lat), [im] = meanSd(inf);
  $('latency').textContent = `${lm.toFixed(0)} ± ${ls.toFixed(0)} ms`;
  $('infer').textContent = `${im.toFixed(1)} ms`;
  if (session) $('recStatus').textContent = `${session.mode}: ${session.frames.length} frames, ${session.prompts.length} prompts`;
}

/** 3-2-1 countdown, then collect a neutral-stance baseline. Returns false if cancelled. */
async function calibrate(owner = session) {
  for (const n of [3, 2, 1]) {
    $('prompt').textContent = `Stand naturally, facing the camera — calibrating in ${n}…`;
    await sleep(1000);
    if (session !== owner) return false;
  }
  $('prompt').textContent = 'Hold still…';
  $('calib').textContent = 'calibrating…';
  const t = performance.now();
  session?.prompts.push({ t: t - session.start, label: 'calibrate' });
  rec.startCalibration(t);
  // The baseline is finalised by the first frame captured after the window, which
  // arrives a pipeline-latency later than the wall clock says, so wait for that.
  await sleep(cfg.calibMs);
  while (rec.calib) await sleep(50);
  $('prompt').textContent = '';
  // A failed calibration throws inside onFrame, which the error handler reports.
  $('calib').textContent = rec.base ? `✓ ${new Date().toLocaleTimeString()}` : '✗ failed (duck off)';
  return session === owner;
}

/** Record a session. `drill` prompts random moves; `negatives` records non-attack movement only. */
async function record(mode) {
  const s = session = { version: 1, mode, aspect, start: performance.now(), startedAt: new Date().toISOString(), frames: [], prompts: [] };
  for (const id of ['calibrate', 'drill', 'negatives']) $(id).disabled = true;
  $('stop').disabled = false;
  if (!(await calibrate(s))) return;
  if (mode === 'negatives') { $('prompt').textContent = 'Move around, talk, stretch, reset your stance — just don\'t attack'; return; }
  let deck = [];
  while (session === s) {
    if (!deck.length) deck = [...DISCRETE, ...CONTINUOUS].sort(() => Math.random() - 0.5);
    const label = deck.pop();
    $('prompt').className = ''; $('prompt').textContent = `Get ready: ${PRETTY[label]}`;
    await sleep(1200);
    if (session !== s) return;
    $('prompt').className = 'go'; $('prompt').textContent = PRETTY[label];
    s.prompts.push({ t: performance.now() - s.start, label });
    await sleep(CONTINUOUS.includes(label) ? 2000 : 800);
    $('prompt').className = ''; $('prompt').textContent = 'Relax, move around';
    await sleep(2000 + Math.random() * 2000);
  }
}

/** Stop recording and download the session as JSON. */
function stop() {
  const s = session;
  if (!s) return;
  session = null;
  const { start: _, ...data } = s;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...data, cfg })], { type: 'application/json' }));
  a.download = `fighter_${s.mode}_${s.startedAt.replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('prompt').className = ''; $('prompt').textContent = '';
  $('recStatus').textContent = `saved ${s.frames.length} frames`;
  for (const id of ['calibrate', 'drill', 'negatives']) $(id).disabled = false;
  $('stop').disabled = true;
}

/** Replay recordings through the recogniser with the current `fighter.cfg` and render the scores. */
async function evaluateFiles(files) {
  const sessions = await Promise.all([...files].map(async (f) => JSON.parse(await f.text())));
  const r = evaluate(sessions, cfg);
  const pct = (v) => (Number.isNaN(v) ? '—' : `${Math.round(v * 100)}%`);
  const cols = [...DISCRETE, 'miss', 'extra'];
  $('report').innerHTML = `
    <h2>Evaluation — ${sessions.length} file(s), ${r.minutes.toFixed(1)} min</h2>
    <p><b class="${r.falseFiresPerMin > 1 ? 'bad' : ''}">${r.falseFiresPerMin.toFixed(2)} false fires / min</b>
      ${Object.entries(r.falseFires).map(([k, v]) => `${PRETTY[k]} ×${v}`).join(', ')}</p>
    <table><tr><th>prompted ↓ / detected →</th>${cols.map((c) => `<th>${PRETTY[c] ?? c}</th>`).join('')}<th>recall</th></tr>
      ${DISCRETE.map((l) => `<tr><th>${PRETTY[l]}</th>${cols.map((c) => `<td class="${c === l ? 'diag' : ''}">${r.confusion[l][c] ?? ''}</td>`).join('')}<td>${pct(r.recall[l])}</td></tr>`).join('')}
    </table>
    <table><tr><th>posture</th><th>active when prompted</th><th>active when not</th></tr>
      ${CONTINUOUS.map((l) => `<tr><th>${PRETTY[l]}</th><td>${pct(r.continuous[l].hit)}</td><td>${pct(r.continuous[l].falseActive)}</td></tr>`).join('')}
    </table>`;
  console.log('Evaluation', r);
}

const run = (fn) => (...args) => fn(...args).catch((e) => { console.error(e); showError(e.message ?? String(e)); });
$('start').onclick = run(async () => { try { await start(); } catch (e) { $('start').disabled = false; throw e; } });
$('calibrate').onclick = run(() => calibrate());
$('drill').onclick = run(() => record('drill'));
$('negatives').onclick = run(() => record('negatives'));
$('stop').onclick = stop;
$('eval').onchange = run(async (e) => { await evaluateFiles(e.target.files); e.target.value = ''; });
window.addEventListener('keydown', (e) => {
  const id = { c: 'calibrate', d: 'drill', n: 'negatives', s: 'stop' }[e.key.toLowerCase()];
  if (id && !$(id).disabled && !e.metaKey && !e.ctrlKey) $(id).click();
});
