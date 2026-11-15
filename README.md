# fighter recordings

Labelled pose recordings from `fighter/` (the pose recogniser spike), kept here so
they survive outside any one machine. Not part of the published site.

Each file is a gzipped session saved by the page's **Record drill** / **Record
negatives** buttons: raw MediaPipe world + image landmarks per frame, plus the
prompts (labels). Replay them through the recogniser from a checkout of the main
code:

```js
import fs from 'fs';
import zlib from 'zlib';
import { evaluate } from './fighter/pose.js';
const s = JSON.parse(zlib.gunzipSync(fs.readFileSync('recordings/<file>.json.gz')));
console.log(evaluate([s]));
```

Or gunzip a file and load it with the page's **Evaluate recordings…** button.

| File | What |
|---|---|
| drill_2026-09-26T14-33 | landscape; hands-down starts, "hooks" were front punches |
| drill_2026-09-26T21-08 | portrait; same protocol |
| negatives_2026-09-26 (×2), 09-27 | early negatives, hands mostly down |
| negatives_2026-10-29T23-01 | partly in guard |
| negatives_2026-10-29T23-07 | in guard, includes walking back (false ducks/hooks) |
| drill_2026-11-14T23-18 | landscape, from guard; slow hooks (peak 1.6–2.9 torso/s), hooks 1/6 |
| hooks_2026-11-14T23-51 | hook drill, 7.6 min: 62 hooks, 22 uppercuts, 11 fidget, 20 leans; rule: hooks 97/87%, uppercuts 45/9% |

Missing (lost in a container reset, not re-uploaded): drill 09-27, drill 09-29
(first from-guard hooks), holdout drill 09-30 (other room).

## Scripts

Run from this branch's root, pointing `POSE` at `fighter/pose.js` in a checkout of the main
code (they import the recogniser from there, so results always match that version):

```sh
POSE=../tools/fighter/pose.js node scripts/replay.mjs [regex]   # score recordings with evaluate()
POSE=../tools/fighter/pose.js node scripts/synth-test.mjs       # synthetic-motion unit tests
POSE=../tools/fighter/pose.js node scripts/learn.mjs            # learned-classifier experiment
```

`learn.mjs` trains a per-frame attack classifier (logistic regression, or a one-hidden-layer
net with `HID=12`) on the `fighter_hooks_*` session(s) plus all negatives, and compares it
with the hand-tuned rules: a time-split within the hook session, then every other recording
(negatives held out one file at a time). It writes `model.json` to the current directory.
Takes ~3 min (logistic regression) to ~30 min (`HID=12`).

`scripts/browser/` drives the page in Playwright with a fake camera (`y4m.mjs` builds the
clip from a still photo; `hookdrill.mjs` runs the hook drill). Set `PLAYWRIGHT` to the
playwright module path if it isn't resolvable as `playwright`.
