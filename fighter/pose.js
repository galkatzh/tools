// @ts-check
// Pose → ActionEvent pipeline: normalise → One Euro filter → heuristic recognisers.
// No DOM here, so the exact same code runs live, in the replay evaluator, and
// headless in node (`import { evaluate } from './pose.js'`).

/** @typedef {{x:number, y:number, z:number, visibility?:number}} Landmark */
/** A discrete attack. `side` is the player's own body side (not screen side);
 *  mapping to the fighter's lead/rear hand is the game's job.
 *  @typedef {{type:'hook'|'uppercut', side:'L'|'R', power:number, time:number}} ActionEvent */
/** Continuous posture, sent as state every tick rather than as events.
 *  lean: -1 (player's left) .. 1 (player's right); duck: 0..1.
 *  @typedef {{guard:boolean, duck:number, lean:number}} Posture */
/** @typedef {{t:number, w:number[], i:number[]}} Frame  flat [x,y,z,visibility]×33, world then image */
/** @typedef {{version:number, aspect:number, frames:Frame[], prompts:{t:number, label:string}[]}} Session */

export const DISCRETE = ['hook_L', 'hook_R', 'uppercut_L', 'uppercut_R'];
export const CONTINUOUS = ['guard', 'duck', 'lean_L', 'lean_R'];

/** Tunables. Distances are in torso lengths, speeds in torso lengths per second. */
export const DEFAULTS = {
  minCutoff: 1.5, beta: 1.0,  // One Euro: jitter smoothing at rest vs. lag at speed
  minVis: 0.5,                // ignore an arm whose wrist/elbow MediaPipe is unsure of
  velMs: 30,                  // velocity baseline: newest frame at least this old (1 frame at 30 fps)
  refractoryMs: 400,          // per-hand dead time after firing
  dirRatio: 1.5,              // dominant axis must beat the other by this factor
  hookSpeed: 4, hookMinY: 0.4, hookElbowMax: 150,
  uppercutSpeed: 4, upperStartY: 0.75, upperLookMs: 300, bothHandsRatio: 0.5,
  guardOn: 1.0, guardOff: 0.85, guardX: 0.5,
  duckDepth: 0.5,             // head drop, in baseline shoulder widths, for duck = 1
  leanFull: 0.25, leanDead: 0.25,
  calibMs: 2000,
};

// BlazePose landmark indices
const NOSE = 0, SH = { L: 11, R: 12 }, EL = { L: 13, R: 14 }, WR = { L: 15, R: 16 }, HIP = { L: 23, R: 24 };

const sub = (a, b) => a.map((v, i) => v - b[i]);
const scale = (a, k) => a.map((v) => v * k);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => Math.hypot(...a);
const unit = (a) => scale(a, 1 / norm(a));
const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

/** One Euro filter (Casiez et al. 2012): a low-pass whose cutoff rises with speed,
 *  so it removes jitter at rest but barely lags fast motion, i.e. keeps punches. */
export class OneEuro {
  constructor(minCutoff = 1.5, beta = 1, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    /** @type {number|null} */ this.x = null;
    this.dx = 0;
  }
  /** @param {number} x @param {number} dt seconds since the previous sample */
  filter(x, dt) {
    if (this.x === null || !(dt > 0)) return (this.x = x);
    const alpha = (fc) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
    this.dx += alpha(this.dCutoff) * ((x - this.x) / dt - this.dx);
    return (this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x));
  }
}

/**
 * Raw per-frame features.
 * Arm joints are expressed in a body frame: origin at the hip centre, `up` towards
 * the shoulder centre, `right` along the hip line (the player's own right), `fwd`
 * out of the chest; units are torso lengths, so any body size reads the same.
 * The hips, not the shoulders, define `right`: shoulder rotation is a large part of
 * a hook's wind-up, and a frame that rotated with the shoulders would cancel it out.
 * Shoulders therefore sit near y≈1, and the left arm at x<0.
 * Lean and duck can't use that frame (it tilts and crouches with the player), so
 * they come from the hip→shoulder tilt and from the head's height in the image.
 * @param {Landmark[]} w worldLandmarks (metres, hip-origin)
 * @param {Landmark[]} img image landmarks (0..1)
 * @param {number} aspect video width / height, to measure image distances in one unit
 */
export function features(w, img, aspect) {
  const v = (i) => [w[i].x, w[i].y, w[i].z];
  const hip = mid(v(HIP.L), v(HIP.R)), torso = sub(mid(v(SH.L), v(SH.R)), hip);
  const len = norm(torso), up = scale(torso, 1 / len), hipLine = unit(sub(v(HIP.R), v(HIP.L)));
  const right = unit(sub(hipLine, scale(up, dot(hipLine, up))));
  const fwd = cross(up, right);
  const local = (i) => { const d = sub(v(i), hip); return [dot(d, right), dot(d, up), dot(d, fwd)].map((c) => c / len); };
  const f = /** @type {Record<string, number[]>} */ ({ lean: [dot(up, hipLine)], nose: [img[NOSE].y] });
  f.shW = [Math.hypot((img[SH.L].x - img[SH.R].x) * aspect, img[SH.L].y - img[SH.R].y)];
  for (const s of /** @type {const} */ (['L', 'R'])) {
    f['sh' + s] = local(SH[s]); f['el' + s] = local(EL[s]); f['wr' + s] = local(WR[s]);
  }
  return f;
}

/** Elbow angle in degrees (180 = straight arm). */
const elbowAngle = (sh, el, wr) => {
  const a = unit(sub(sh, el)), b = unit(sub(wr, el));
  return (Math.acos(clamp(dot(a, b), -1, 1)) * 180) / Math.PI;
};

/** Stateful recogniser: feed it one pose per video frame, get events + posture back. */
export class Recogniser {
  constructor(cfg = { ...DEFAULTS }) {
    this.cfg = cfg;
    /** @type {Map<string, OneEuro>} */ this.filters = new Map();
    /** @type {{t:number, f:Record<string, number[]>}[]} filtered features, last ~0.5 s */
    this.hist = [];
    this.lastFire = { L: -Infinity, R: -Infinity };
    this.guard = false;
    /** @type {{lean:number, nose:number, shW:number}|null} */ this.base = null;
    /** @type {{until:number, samples:Record<string, number>[]}|null} */ this.calib = null;
  }

  /** Collect a neutral-stance baseline (for lean and duck) from frames in [t, t+calibMs].
   *  The old baseline is dropped, so a failed calibration can't leave a stale one in use. */
  startCalibration(t) { this.base = null; this.calib = { until: t + this.cfg.calibMs, samples: [] }; }

  /**
   * @param {Landmark[]} world @param {Landmark[]} img
   * @param {number} t frame time, ms @param {number} aspect video width / height
   * @returns {{events:ActionEvent[], posture:Posture, feats:Record<string, number[]>}}
   */
  update(world, img, t, aspect) {
    const { cfg } = this, prev = this.hist.at(-1), dt = prev ? (t - prev.t) / 1000 : 0;
    const raw = features(world, img, aspect), f = {};
    for (const k in raw) {
      f[k] = raw[k].map((x, i) => {
        const id = k + i;
        if (!this.filters.has(id)) this.filters.set(id, new OneEuro(cfg.minCutoff, cfg.beta));
        return /** @type {OneEuro} */ (this.filters.get(id)).filter(x, dt);
      });
    }
    this.hist.push({ t, f });
    while (this.hist[0].t < t - 500) this.hist.shift();
    this.#calibrate(t, f);

    const past = this.hist.findLast((h) => h.t <= t - cfg.velMs);
    const vel = (k) => (past ? scale(sub(f[k], past.f[k]), 1000 / (t - past.t)) : [0, 0, 0]);
    const vL = vel('wrL'), vR = vel('wrR');
    /** @type {ActionEvent[]} */ const events = [];
    for (const [s, v, vOther, inward] of /** @type {const} */ ([['L', vL, vR, 1], ['R', vR, vL, -1]])) {
      if (!past || t - this.lastFire[s] < cfg.refractoryMs) continue;
      if (Math.min(img[WR[s]].visibility ?? 1, img[EL[s]].visibility ?? 1) < cfg.minVis) continue;
      const wr = f['wr' + s], vin = inward * v[0], vy = v[1];
      let type = null, speed = 0;
      if (vin > cfg.hookSpeed && vin > cfg.dirRatio * Math.abs(vy) && wr[1] > cfg.hookMinY
          && elbowAngle(f['sh' + s], f['el' + s], wr) < cfg.hookElbowMax) {
        type = 'hook'; speed = vin;
      } else if (vy > cfg.uppercutSpeed && vy > cfg.dirRatio * Math.abs(v[0])
          // An uppercut starts low; both hands rising together is a guard being raised.
          && this.hist.some((h) => h.t >= t - cfg.upperLookMs && h.f['wr' + s][1] < cfg.upperStartY)
          && vOther[1] < cfg.bothHandsRatio * vy) {
        type = 'uppercut'; speed = vy;
      }
      if (type) {
        this.lastFire[s] = t;
        events.push({ type, side: s, power: clamp(speed / (2 * cfg[type + 'Speed']), 0, 1), time: t });
      }
    }
    return { events, posture: this.#posture(f), feats: f };
  }

  #calibrate(t, f) {
    const c = this.calib;
    if (!c) return;
    if (t <= c.until) { c.samples.push({ lean: f.lean[0], nose: f.nose[0], shW: f.shW[0] }); return; }
    this.calib = null;
    if (c.samples.length < 10) throw new Error(`Calibration failed: only ${c.samples.length} pose frames in ${this.cfg.calibMs} ms — is your upper body in view?`);
    this.base = { lean: median(c.samples.map((s) => s.lean)), nose: median(c.samples.map((s) => s.nose)), shW: median(c.samples.map((s) => s.shW)) };
  }

  /** @returns {Posture} */
  #posture(f) {
    const { cfg, base } = this, [l, r] = [f.wrL, f.wrR];
    const high = Math.min(l[1], r[1]);
    // Hysteresis so the guard doesn't flicker at the threshold.
    this.guard = this.guard ? high > cfg.guardOff : high > cfg.guardOn && Math.max(Math.abs(l[0]), Math.abs(r[0])) < cfg.guardX;
    const duck = base ? clamp((f.nose[0] - base.nose) / base.shW / cfg.duckDepth, 0, 1) : 0;
    const lean = clamp((f.lean[0] - (base?.lean ?? 0)) / cfg.leanFull, -1, 1);
    const dead = Math.max(0, Math.abs(lean) - cfg.leanDead) / (1 - cfg.leanDead);
    return { guard: this.guard, duck, lean: Math.sign(lean) * dead };
  }
}

/** Flatten landmarks to [x,y,z,visibility]×n, rounded, for compact recordings. */
export const pack = (lms) => lms.flatMap((l) => [l.x, l.y, l.z, l.visibility ?? 1].map((v) => Math.round(v * 1e4) / 1e4));
/** @returns {Landmark[]} */
export const unpack = (a) => Array.from({ length: a.length / 4 }, (_, j) => ({ x: a[4 * j], y: a[4 * j + 1], z: a[4 * j + 2], visibility: a[4 * j + 3] }));

/** Whether a posture satisfies a continuous prompt label. */
const postureMatches = (label, p) => ({ guard: p.guard, duck: p.duck > 0.5, lean_L: p.lean < -0.5, lean_R: p.lean > 0.5 })[label];

/**
 * Replay recorded drill sessions through a fresh recogniser and score it against
 * the prompts. A discrete prompt owns the events in [GO, GO+1.5 s]; any event
 * outside every discrete window is a false fire. Continuous prompts are scored on
 * the fraction of frames in [GO+0.5 s, GO+2 s] where the posture matches, versus
 * how often it is active when nothing was prompted.
 * @param {Session[]} sessions
 */
export function evaluate(sessions, cfg = { ...DEFAULTS }) {
  const confusion = Object.fromEntries(DISCRETE.map((l) => [l, {}]));
  const falseFires = {}, cont = Object.fromEntries(CONTINUOUS.map((l) => [l, { in: 0, inHit: 0, out: 0, outHit: 0 }]));
  let ms = 0;
  const bump = (o, k) => (o[k] = (o[k] || 0) + 1);
  for (const s of sessions) {
    const rec = new Recogniser(cfg), calibs = s.prompts.filter((p) => p.label === 'calibrate');
    const disc = s.prompts.filter((p) => DISCRETE.includes(p.label)).map((p) => ({ ...p, hits: [] }));
    const conts = s.prompts.filter((p) => CONTINUOUS.includes(p.label));
    for (const fr of s.frames) {
      while (calibs.length && calibs[0].t <= fr.t) rec.startCalibration(calibs.shift().t);
      const { events, posture } = rec.update(unpack(fr.w), unpack(fr.i), fr.t, s.aspect);
      for (const e of events) {
        const label = `${e.type}_${e.side}`, owner = disc.find((p) => e.time >= p.t && e.time <= p.t + 1500);
        owner ? owner.hits.push(label) : bump(falseFires, label);
      }
      const active = conts.find((p) => fr.t >= p.t + 500 && fr.t <= p.t + 2000);
      for (const l of CONTINUOUS) {
        const hit = postureMatches(l, posture) ? 1 : 0, c = cont[l];
        if (active?.label === l) { c.in++; c.inHit += hit; } else if (!active) { c.out++; c.outHit += hit; }
      }
    }
    for (const p of disc) {
      bump(confusion[p.label], p.hits[0] ?? 'miss');
      p.hits.slice(1).forEach(() => bump(confusion[p.label], 'extra'));
    }
    ms += (s.frames.at(-1)?.t ?? 0) - (s.frames[0]?.t ?? 0);
  }
  const minutes = ms / 60000, nFalse = Object.values(falseFires).reduce((a, b) => a + b, 0);
  return {
    minutes, confusion, falseFires, falseFiresPerMin: minutes ? nFalse / minutes : 0,
    recall: Object.fromEntries(DISCRETE.map((l) => {
      const row = confusion[l], n = Object.entries(row).reduce((a, [k, v]) => a + (k === 'extra' ? 0 : v), 0);
      return [l, n ? (row[l] || 0) / n : NaN];
    })),
    continuous: Object.fromEntries(CONTINUOUS.map((l) => [l, { hit: cont[l].inHit / cont[l].in, falseActive: cont[l].outHit / cont[l].out }])),
  };
}
