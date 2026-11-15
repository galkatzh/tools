// Experiment v2: compact motion features, 2-frame confirmation, extra negatives with
// leave-one-file-out. Compares against the hand-tuned rules on identical scoring.
// Usage: POSE=../tools/fighter/pose.js [HID=12] [TH=0.8,0.9,0.95] node scripts/learn.mjs
// Needs at least one fighter_hooks_* recording (training data) in ../recordings.
import fs from 'fs';
import { pose, load } from './lib.mjs';
const { Recogniser, unpack, DEFAULTS, DISCRETE } = pose;
const CLASSES = ['none', ...DISCRETE];
const MIRROR = { none: 'none', hook_L: 'hook_R', hook_R: 'hook_L', uppercut_L: 'uppercut_R', uppercut_R: 'uppercut_L' };
const W = 10, HID = +(process.env.HID || 0); // HID > 0: one hidden layer of that size (tanh)

function replay(s) {
  const rec = new Recogniser({ ...DEFAULTS }), calibs = s.prompts.filter((p) => p.label === 'calibrate'), ruleEv = [];
  const rows = s.frames.map((fr) => {
    while (calibs.length && calibs[0].t <= fr.t) rec.startCalibration(calibs.shift().t);
    const i = unpack(fr.i), o = rec.update(unpack(fr.w), i, fr.t, s.aspect);
    for (const e of o.events) ruleEv.push({ lbl: `${e.type}_${e.side}`, t: e.time });
    return { t: fr.t, f: structuredClone(o.feats), vis: [i[15].visibility, i[16].visibility] };
  });
  return { rows, ruleEv };
}
/** Compact features at frame i, per hand (own hand first when mirrored, so features are side-relative). */
function feats(rows, i, mirror = false) {
  if (i < W) return null;
  const sides = mirror ? ['R', 'L'] : ['L', 'R'], fx = (v) => (mirror ? [-v[0], v[1], v[2]] : v);
  const vel = (k, n) => { const a = rows[i - n]; return fx(rows[i].f[k].map((c, j) => ((c - a.f[k][j]) * 1000) / (rows[i].t - a.t))); };
  const out = [];
  for (const s of sides) {
    const wr = 'wr' + s, el = 'el' + s;
    let minY = Infinity, maxSp = 0;
    for (let k = i - W + 1; k <= i; k++) {
      minY = Math.min(minY, rows[k].f[wr][1]);
      maxSp = Math.max(maxSp, Math.hypot(...rows[k].f[wr].map((c, j) => c - rows[k - 1].f[wr][j])) * 1000 / (rows[k].t - rows[k - 1].t));
    }
    out.push(...fx(rows[i].f[wr]), ...fx(rows[i].f[el]), ...vel(wr, 1), ...vel(wr, 3), ...vel(wr, 6), ...vel(el, 3), minY, maxSp);
  }
  out.push(rows[i].f.near[0] - rows[i - 3].f.near[0], rows[i].f.near[0] - rows[i - 9].f.near[0]);
  return out;
}
function labels(rows, s) {
  const y = rows.map(() => 'none');
  for (const p of s.prompts.filter((p) => DISCRETE.includes(p.label))) {
    const k = 'wr' + p.label.at(-1); let best = -1, bestSp = 0;
    rows.forEach((r, i) => {
      if (i === 0 || r.t < p.t || r.t > p.t + 2500) return;
      const sp = Math.hypot(...r.f[k].map((c, a) => c - rows[i - 1].f[k][a])) * 1000 / (r.t - rows[i - 1].t);
      if (sp > bestSp) { bestSp = sp; best = i; }
    });
    rows.forEach((r, i) => { if (r.t >= p.t - 300 && r.t <= p.t + 2800) y[i] = null; });
    if (best >= 0) rows.forEach((r, i) => { if (r.t >= rows[best].t - 150 && r.t <= rows[best].t) y[i] = p.label; });
  }
  return y;
}
// --- model: softmax regression, optionally with one tanh hidden layer; Adam, class-balanced, L2.
function train(X, Y, { epochs = 400, lr = 0.01, l2 = 1e-3, seed = 7 } = {}) {
  const d = X[0].length, C = CLASSES.length, n = X.length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (const x of X) x.forEach((v, j) => (mu[j] += v / n));
  for (const x of X) x.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / n));
  sd.forEach((v, j) => (sd[j] = Math.sqrt(v) || 1));
  const Z = X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j])), yi = Y.map((y) => CLASSES.indexOf(y));
  const cnt = CLASSES.map((_, c) => yi.filter((v) => v === c).length), cw = cnt.map((k) => (k ? n / (C * k) : 0));
  let r = seed; const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5);
  const H = HID || d, mat = (a, b, s) => Array.from({ length: a }, () => Array.from({ length: b + 1 }, () => rnd() * s));
  const P = HID ? { A: mat(H, d, 2 / Math.sqrt(d)), B: mat(C, H, 2 / Math.sqrt(H)) } : { B: mat(C, d, 0) };
  const st = Object.fromEntries(Object.entries(P).map(([k, M]) => [k, { m: M.map((row) => row.map(() => 0)), v: M.map((row) => row.map(() => 0)) }]));
  for (let ep = 1; ep <= epochs; ep++) {
    const G = Object.fromEntries(Object.entries(P).map(([k, M]) => [k, M.map((row) => row.map(() => 0))]));
    let ws = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i], h = HID ? P.A.map((a) => Math.tanh(a.reduce((s, w, j) => s + w * (j < d ? z[j] : 1), 0))) : z;
      const lg = P.B.map((b) => b.reduce((s, w, j) => s + w * (j < H ? h[j] : 1), 0)), mx = Math.max(...lg);
      const e = lg.map((l) => Math.exp(l - mx)), se = e.reduce((a, b) => a + b, 0), w = cw[yi[i]]; ws += w;
      const gl = e.map((v, c) => w * (v / se - (c === yi[i] ? 1 : 0)));
      for (let c = 0; c < C; c++) if (gl[c]) for (let j = 0; j <= H; j++) G.B[c][j] += gl[c] * (j < H ? h[j] : 1);
      if (HID) for (let k = 0; k < H; k++) {
        let gh = 0; for (let c = 0; c < C; c++) gh += gl[c] * P.B[c][k];
        gh *= 1 - h[k] * h[k]; if (gh) for (let j = 0; j <= d; j++) G.A[k][j] += gh * (j < d ? z[j] : 1);
      }
    }
    for (const [k, M] of Object.entries(P)) M.forEach((row, a) => row.forEach((wv, j) => {
      const g = G[k][a][j] / ws + (j < row.length - 1 ? l2 * wv : 0), s = st[k];
      s.m[a][j] = 0.9 * s.m[a][j] + 0.1 * g; s.v[a][j] = 0.999 * s.v[a][j] + 0.001 * g * g;
      row[j] -= lr * (s.m[a][j] / (1 - 0.9 ** ep)) / (Math.sqrt(s.v[a][j] / (1 - 0.999 ** ep)) + 1e-8);
    }));
  }
  return { mu, sd, ...P };
}
function predict(M, x) {
  const d = M.mu.length, z = x.map((v, j) => (v - M.mu[j]) / M.sd[j]);
  const h = M.A ? M.A.map((a) => Math.tanh(a.reduce((s, w, j) => s + w * (j < d ? z[j] : 1), 0))) : z, H = h.length;
  const lg = M.B.map((b) => b.reduce((s, w, j) => s + w * (j < H ? h[j] : 1), 0)), mx = Math.max(...lg), e = lg.map((v) => Math.exp(v - mx)), se = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / se);
}
/** Fire an attack once its class has been the confident winner (p > th) for 2 consecutive frames. */
function detect(M, rows, th) {
  const last = { L: -1e9, R: -1e9 }; let any = -1e9, prev = null; const ev = [];
  rows.forEach((r, i) => {
    const x = feats(rows, i); if (!x) return;
    const p = predict(M, x); let c = 1; for (let k = 2; k < p.length; k++) if (p[k] > p[c]) c = k;
    const lbl = p[c] > th ? CLASSES[c] : null, side = lbl?.at(-1);
    if (lbl && lbl === prev && r.t - last[side] >= 400 && r.t - any >= 250 && r.vis[side === 'L' ? 0 : 1] >= 0.5) { last[side] = any = r.t; ev.push({ lbl, t: r.t }); }
    prev = lbl;
  });
  return ev;
}
/** Event scoring like evaluate(); false fires split into "during fidget prompts" and "elsewhere". */
function score(rows, evs, s, tFrom = -Infinity, tTo = Infinity) {
  const disc = s.prompts.filter((p) => DISCRETE.includes(p.label) && p.t >= tFrom && p.t < tTo).map((p) => ({ ...p, hits: [] }));
  const fid = s.prompts.filter((p) => p.label === 'fidget').map((p) => [p.t, p.end ?? p.t + 3000]);
  const conf = Object.fromEntries(DISCRETE.map((l) => [l, {}])); let ff = 0, ffFid = 0;
  for (const e of evs) {
    if (e.t < tFrom || e.t >= tTo) continue;
    const o = disc.findLast((p) => e.t >= p.t && e.t <= p.t + 2500);
    if (o) o.hits.push(e.lbl); else if (fid.some(([a, b]) => e.t >= a && e.t <= b + 500)) ffFid++; else ff++;
  }
  for (const p of disc) { const k = p.hits[0] ?? 'miss'; conf[p.label][k] = (conf[p.label][k] || 0) + 1; }
  const rr = rows.filter((r) => r.t >= tFrom && r.t < tTo);
  const fidMin = fid.reduce((a, [x, y]) => a + (Math.min(y + 500, tTo) > Math.max(x, tFrom) ? Math.min(y + 500, tTo) - Math.max(x, tFrom) : 0), 0) / 60000;
  return { conf, ff, ffFid, min: (rr.at(-1).t - rr[0].t) / 60000 - fidMin, fidMin };
}
const fmt = (sc) => {
  const rc = DISCRETE.map((l) => { const r = sc.conf[l], n = Object.values(r).reduce((a, b) => a + b, 0); return n ? `${l.replace('uppercut', 'up')} ${r[l] || 0}/${n}` : ''; }).filter(Boolean).join(' ');
  return `${rc.padEnd(rc ? 44 : 0)}| ff/min ${(sc.ff / sc.min).toFixed(2)}${sc.fidMin ? `  (+${sc.ffFid} in ${(sc.fidMin * 60).toFixed(0)} s of fidget)` : ''}`;
};

const add = (D, rows, y, keep = () => true) => rows.forEach((r, i) => { if (y[i] === null || !keep(r)) return; const a = feats(rows, i); if (!a) return; D.X.push(a, feats(rows, i, true)); D.Y.push(y[i], MIRROR[y[i]]); });
const name = (f) => f.replace(/^fighter_/, '').replace(/\.json(\.gz)?$/, '').slice(0, 30).padEnd(30);
const TH = (process.env.TH || '0.8,0.9,0.95').split(',').map(Number);

const hk = load(/fighter_hooks_/)[0], H = replay(hk.s), hy = labels(H.rows, hk.s), tMid = (H.rows[0].t + H.rows.at(-1).t) / 2;
const negs = load(/fighter_negatives_/).map(({ f, s }) => ({ f, s, ...replay(s) }));
const drills = load(/fighter_drill_/).map(({ f, s }) => ({ f, s, ...replay(s) }));
console.log(`model: ${HID ? `MLP, ${HID} hidden` : 'logistic regression'}, ${feats(H.rows, W).length} features`);

console.log('\n=== hook session, time split (train one half + all negatives files, test the other half)');
for (const [name, keep, from, to] of [['test 2nd half', (r) => r.t < tMid, tMid, Infinity], ['test 1st half', (r) => r.t >= tMid, -Infinity, tMid]]) {
  const D = { X: [], Y: [] }; add(D, H.rows, hy, keep);
  for (const n of negs) add(D, n.rows, n.rows.map(() => 'none'));
  const M = train(D.X, D.Y);
  console.log(`  ${name}  RULES      :`, fmt(score(H.rows, H.ruleEv, hk.s, from, to)));
  for (const th of TH) console.log(`  ${name}  model ${th.toFixed(2)} :`, fmt(score(H.rows, detect(M, H.rows, th), hk.s, from, to)));
}

console.log('\n=== other sessions (model trained on the whole hook session + every negatives file except the one tested)');
const base = { X: [], Y: [] }; add(base, H.rows, hy);
const full = { X: [...base.X], Y: [...base.Y] }; for (const n of negs) add(full, n.rows, n.rows.map(() => 'none'));
const Mfull = train(full.X, full.Y);
fs.writeFileSync(`model${HID ? '_mlp' : ''}.json`, JSON.stringify({ W, HID, ...Mfull })); // written to the current directory
for (const d of drills) {
  console.log(`  ${name(d.f)}  RULES      :`, fmt(score(d.rows, d.ruleEv, d.s)));
  for (const th of TH) console.log(`  ${name(d.f)}  model ${th.toFixed(2)} :`, fmt(score(d.rows, detect(Mfull, d.rows, th), d.s)));
}
for (const n of negs) {
  const D = { X: [...base.X], Y: [...base.Y] }; for (const o of negs) if (o !== n) add(D, o.rows, o.rows.map(() => 'none'));
  const M = train(D.X, D.Y);
  console.log(`  ${name(n.f)}  RULES      :`, fmt(score(n.rows, n.ruleEv, n.s)));
  for (const th of TH) console.log(`  ${name(n.f)}  model ${th.toFixed(2)} :`, fmt(score(n.rows, detect(M, n.rows, th), n.s)));
}
