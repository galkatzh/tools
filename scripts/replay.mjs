// Usage: POSE=../tools/fighter/pose.js node scripts/replay.mjs [filename regex]
// Scores every matching recording with pose.js evaluate(): attack recall, false fires per
// minute, and posture hit / idle-active rates.
import { pose, load } from './lib.mjs';
const p = (v) => (Number.isNaN(v) ? '  —' : `${(v * 100).toFixed(0)}%`.padStart(4));
const all = [];
for (const { f, s } of load(new RegExp(process.argv[2] ?? '.'))) {
  all.push(s);
  const r = pose.evaluate([s]), c = r.continuous;
  console.log(f.replace(/\.json(\.gz)?$/, '').padEnd(40), 'attacks', Object.values(r.recall).map(p).join(''), `| ff/min ${r.falseFiresPerMin.toFixed(2)}`,
    `| duck ${p(c.duck.hit)}/${p(c.duck.falseActive)} guard ${p(c.guard.hit)}/${p(c.guard.falseActive)} lean ${p(c.lean_L.hit)}${p(c.lean_R.hit)}/${p(c.lean_L.falseActive)}`);
}
const r = pose.evaluate(all);
console.log('ALL'.padEnd(40), 'attacks', Object.values(r.recall).map(p).join(''), `| ff/min ${r.falseFiresPerMin.toFixed(2)}`);
console.log('(attacks: hook L, hook R, uppercut L, uppercut R recall; postures: hit when prompted / active when idle)');
