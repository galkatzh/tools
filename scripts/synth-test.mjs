// Synthetic-motion tests for fighter/pose.js. Fake skeleton in MediaPipe world coords
// (x image-right, y down, z away; player faces the camera, so their right is image left),
// scripted at 30 fps.
// Usage: POSE=../tools/fighter/pose.js node scripts/synth-test.mjs
import { pose } from './lib.mjs';
const { Recogniser, evaluate, pack, DEFAULTS } = pose;

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
// Neutral stance with fists up in guard (wrists above the shoulders' height in body frame).
const GUARD = {
  0: [0, -0.7, -0.05], 11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0],
  13: [0.2, -0.35, -0.15], 14: [-0.2, -0.35, -0.15], 15: [0.08, -0.62, -0.3], 16: [-0.08, -0.62, -0.3],
  23: [0.1, 0, 0], 24: [-0.1, 0, 0],
};
const LOW = { ...GUARD, 13: [0.25, -0.25, -0.1], 14: [-0.25, -0.25, -0.1], 15: [0.15, -0.35, -0.25], 16: [-0.15, -0.35, -0.25] };
const ease = (u) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;
const lerp = (a, b, u) => a.map((v, i) => v + (b[i] - v) * ease(u));

function frames(ms, pose, { base = GUARD, t0 = 0, noise = 0.004 } = {}) {
  const out = [];
  for (let t = 0; t < ms; t += 33.3) {
    const p = { ...base, ...pose(t) };
    const w = Array.from({ length: 33 }, (_, i) => {
      const [x, y, z] = p[i] ?? [0, 0.4, 0];
      return { x: x + rand() * noise, y: y + rand() * noise, z: z + rand() * noise, visibility: 0.95 };
    });
    const k = p.k ?? 1, img = w.map((l) => ({ x: 0.5 + l.x * 0.8 * k, y: 0.5 + l.y * 0.8 * k + (p.dy ?? 0), z: 0, visibility: 0.95 }));
    out.push({ t: t0 + t, w, img });
  }
  return out;
}
// Hook from guard: fist swings out-and-around at head height (mostly toward the camera).
const hook = (W, sg) => (t) => ({ [W]: lerp([sg * 0.08, -0.62, -0.3], [sg * -0.12, -0.6, -0.6], (t - 300) / 200) });
const hookL = hook(15, 1), hookR = hook(16, -1);
// Uppercut from guard: dip, then drive up.
const upper = (W, E, sg) => (t) => ({
  [W]: t < 450 ? lerp([sg * 0.08, -0.62, -0.3], [sg * 0.15, -0.2, -0.25], (t - 200) / 250) : lerp([sg * 0.15, -0.2, -0.25], [sg * 0.08, -0.7, -0.35], (t - 450) / 220),
  [E]: [sg * 0.25, -0.22, -0.15],
});
const upperL = upper(15, 13, 1), upperR = upper(16, 14, -1);
// Both wrists lunge toward the camera together (step in); right one faster.
// A single-frame jump, so both cross the hook threshold on the same frame (as in the holdout recording).
const lunge = (t) => ({ 15: t < 330 ? [0.08, -0.62, -0.3] : [0.08, -0.62, -0.5], 16: t < 330 ? [-0.08, -0.62, -0.3] : [-0.08, -0.62, -0.62] });
const guardUp = (t) => ({ 15: lerp([0.15, -0.3, -0.2], [0.08, -0.62, -0.3], (t - 300) / 250), 16: lerp([-0.15, -0.3, -0.2], [-0.08, -0.62, -0.3], (t - 300) / 250) });

let fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); fail += !ok; };
function run(name, fs, expect) {
  const rec = new Recogniser({ ...DEFAULTS }), evs = [];
  for (const f of fs) evs.push(...rec.update(f.w, f.img, f.t, 4 / 3).events);
  const got = evs.map((e) => `${e.type}_${e.side}`);
  check(name, JSON.stringify(got) === JSON.stringify(expect), got.join(' ') || '(none)');
}
run('idle in guard 5 s', frames(5000, () => ({})), []);
run('idle hands down 5 s', frames(5000, () => ({}), { base: LOW }), []);
run('hook L from guard', frames(1200, hookL), ['hook_L']);
run('hook R from guard', frames(1200, hookR), ['hook_R']);
run('uppercut L from guard', frames(1200, upperL), ['uppercut_L']);
run('uppercut R from guard', frames(1200, upperR), ['uppercut_R']);
run('both wrists lunge, R faster → hook R only', frames(1200, lunge), ['hook_R']);
run('raising guard from hands down is not an attack', frames(1200, guardUp, { base: LOW }), []);
{
  const rec = new Recogniser({ ...DEFAULTS }); let post;
  for (const f of frames(1200, guardUp, { base: LOW })) post = rec.update(f.w, f.img, f.t, 4 / 3).posture;
  check('guard is up after raising it', post.guard);
}
{
  const rec = new Recogniser({ ...DEFAULTS }); rec.startCalibration(0); let p, peak = 0;
  for (const f of frames(2500, () => ({}))) p = rec.update(f.w, f.img, f.t, 4 / 3).posture;
  for (const f of frames(1000, () => ({ dy: 0.12, 0: [0, -0.55, -0.1] }), { t0: 2500 })) { p = rec.update(f.w, f.img, f.t, 4 / 3).posture; peak = Math.max(peak, p.duck); }
  check('fast duck registers and stays on while held', peak > 0.5 && p.duck > 0.5, `peak ${peak.toFixed(2)} after 1 s held ${p.duck.toFixed(2)}`);
  for (const f of frames(1000, () => ({ 11: [0.0, -0.46, 0], 12: [-0.4, -0.46, 0], 15: [-0.12, -0.58, -0.3], 16: [-0.28, -0.58, -0.3] }), { t0: 3500 })) p = rec.update(f.w, f.img, f.t, 4 / 3).posture;
  check('lean right', p.lean > 0.5, `lean ${p.lean.toFixed(2)}`);
}
// A slow head drop (settling lower over 1.5 s) and stepping back (shrinking 25% while the
// head drops in the image, as with a camera below head height) must not read as ducks.
for (const [name, pose] of [
  ['slow 1.5 s head drop is not a duck', (t) => ({ dy: 0.12 * Math.min(1, t / 1500) })],
  ['stepping back is not a duck', (t) => { const u = ease(t / 500); return { k: 1 - 0.25 * u, dy: 0.12 * u }; }],
]) {
  const rec = new Recogniser({ ...DEFAULTS }); let peak = 0;
  for (const f of frames(500, () => ({}))) rec.update(f.w, f.img, f.t, 4 / 3);
  for (const f of frames(2000, pose, { t0: 500 })) peak = Math.max(peak, rec.update(f.w, f.img, f.t, 4 / 3).posture.duck);
  check(name, peak <= 0.5, `peak ${peak.toFixed(2)}`);
}
{
  const rec = new Recogniser({ ...DEFAULTS }); rec.startCalibration(0);
  try { for (const f of frames(500, () => ({}), { t0: 2500 })) rec.update(f.w, f.img, f.t, 4 / 3); check('calibration without frames throws', false); }
  catch (e) { check('calibration without frames throws', /Calibration failed/.test(e.message)); }
}
{
  const seq = [['calibrate', () => ({}), 2500], ['hook_L', hookL, 2600], ['uppercut_R', upperR, 2600], ['hook_R', hookR, 2600], ['uppercut_L', upperL, 2600],
    ['duck', () => ({ dy: 0.12, 0: [0, -0.55, -0.1] }), 800], [null, () => ({}), 3000]];
  const session = { version: 1, aspect: 4 / 3, frames: [], prompts: [] };
  let t0 = 0;
  for (const [label, pose, ms] of seq) {
    if (label) session.prompts.push({ t: label === 'calibrate' ? t0 : t0 + 250, label });
    for (const f of frames(ms, pose, { t0 })) session.frames.push({ t: f.t, w: pack(f.w), i: pack(f.img) });
    t0 += ms;
  }
  const r = evaluate([JSON.parse(JSON.stringify(session))]);
  check('evaluate round-trip', Object.values(r.recall).every((v) => v === 1) && r.falseFiresPerMin === 0 && r.continuous.duck.hit === 1,
    JSON.stringify({ recall: r.recall, ff: r.falseFiresPerMin, duck: r.continuous.duck.hit }));
}
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
