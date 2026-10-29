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

Missing (lost in a container reset, not re-uploaded): drill 09-27, drill 09-29
(first from-guard hooks), holdout drill 09-30 (other room).
