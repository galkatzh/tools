// Phase 4A's budgets (spec §4k), run alone (run-all.sh SERIAL: wall clocks):
//  B20  a 64-image zip of about 20 MB (photographs, as a camera's JPEGs)
//       imported from 📦 on the desktop: ≤ 10 s from the pick to the box on
//       the table, its progress shown file by file;
//  B21  that box set up and exported with its images (a .zip): ≤ 5 s from
//       the press to the download. (A generated board game: Hexfront, the
//       spec's own, is Phase 4B's.)
// The 64 images are drawn here, in the page (gradients, discs and grain;
// original), and zipped by zip-lib.js; the game: a board (the first image,
// encoded as a board) and 63 counters, each its own picture.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const { zip } = require('./zip-lib');

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-bench-'));
  const alice = await P.join(env, 'Alice', env.url);
  const jpegs = await alice.evaluate(async () => {
    const out = [];
    for (let k = 0; k < 64; k++) {
      const c = Object.assign(document.createElement('canvas'), { width: 1200, height: 900 }), x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 1200, 900);
      g.addColorStop(0, `hsl(${(k * 37) % 360} 60% 40%)`);
      g.addColorStop(1, `hsl(${(k * 37 + 120) % 360} 50% 70%)`);
      x.fillStyle = g;
      x.fillRect(0, 0, 1200, 900);
      for (let r = 0; r < 40; r++) {
        x.fillStyle = `hsl(${(k * 13 + r * 29) % 360} 70% ${30 + (r % 40)}%)`;
        x.beginPath();
        x.arc((r * 197 + k * 31) % 1200, (r * 113 + k * 17) % 900, 20 + ((r * 7) % 90), 0, 7);
        x.fill();
      }
      const d = x.getImageData(0, 0, 1200, 900), a = d.data;
      for (let i = 0, s = k + 1; i < a.length; i += 4) { // (grain: what a photograph's JPEG spends its bytes on)
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const n = ((s >>> 28) - 8) * 1.4;
        a[i] += n; a[i + 1] += n; a[i + 2] += n;
      }
      x.putImageData(d, 0, 0);
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      out.push(await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result.slice(f.result.indexOf(',') + 1)); f.readAsDataURL(b); })); // (base64, for the trip to Node)
    }
    return out;
  });
  const names = jpegs.map((_, k) => (k ? `images/counter-${k}.jpg` : 'images/board.jpg'));
  const game = {
    name: 'Bench Valley',
    table: { shape: 'rect', w: 3200, h: 2200 },
    pieces: [
      { id: 'board', kind: 'board', w: 2000, h: 1500, img: names[0], grid: { type: 'hex', cols: 20, rows: 14, cell: 100 } },
      ...names.slice(1).map((f, k) => ({ id: `c${k + 1}`, kind: 'token', shape: 'rect', w: 60, img: f })),
    ],
    setup: [{ piece: 'board', at: 'center' }, ...names.slice(1).map((_, k) => ({ piece: `c${k + 1}`, at: [300 + (k % 8) * 80, 300 + Math.floor(k / 8) * 80] }))],
  };
  const bytes = zip([{ name: 'game.json', data: JSON.stringify(game) }, ...jpegs.map((b, k) => ({ name: names[k], data: Buffer.from(b, 'base64'), store: true }))]);
  const file = path.join(tmp, 'bench-valley.zip');
  fs.writeFileSync(file, bytes);

  section(`B20: a zip of 64 photographs, ${(bytes.length / 1e6).toFixed(1)} MB, imported from 📦 on the desktop`);
  await alice.click('#box-btn');
  await alice.waitForSelector('#box-dialog[open]');
  await alice.setChecked('#box-now', false);
  await alice.evaluate(() => { // every progress line the dialog shows
    const el = document.getElementById('box-progress');
    window.__said = [];
    new MutationObserver(() => window.__said.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  const t0 = Date.now();
  await alice.setInputFiles('#box-files', file);
  await alice.waitForFunction(() => /^Added|^Couldn't/.test(document.getElementById('box-progress').textContent + document.getElementById('box-err').textContent), null, { timeout: 60000 });
  const ms = Date.now() - t0, said = await alice.evaluate(() => window.__said), err = await alice.textContent('#box-err');
  const reads = said.filter((s) => /^Reading images\/(board|counter-\d+)\.jpg \(\d+\/64\)…$/.test(s));
  ok(!err && said.at(-1) === 'Added «Bench Valley»' && reads.length === 64 && reads.at(-1).endsWith('(64/64)…'), `imported, and said so file by file: ${reads.length} lines ("${reads[0]}" … "${reads.at(-1)}"), then "${said.at(-1)}"${err ? ` — ${err}` : ''}`);
  ok(!err && ms <= 10000, `B20: ${ms} ms from the pick to the box on the table (budget 10,000)`);

  section('B21: the box set up, then exported with its images');
  const [id] = await alice.evaluate(() => Object.entries(window.__ct.hostState().boxes).filter(([, b]) => b.name === 'Bench Valley').map(([k]) => k));
  await alice.click(`.box-row[data-box="${id}"] [data-act="setup"]`);
  await alice.waitForSelector('#box-ask[open][data-kind="setup"]');
  await alice.click('#box-ask-btns button[value="ok"]');
  await alice.waitForFunction(() => !document.querySelector('#box-dialog[open]') && Object.keys(window.__ct.hostState().items).length === 64 && window.__ct.jobs() === 0, null, { timeout: 20000 });
  await alice.click('#box-btn');
  const t1 = Date.now(), [dl] = await Promise.all([alice.waitForEvent('download', { timeout: 30000 }), alice.click('#box-x-go')]), ms2 = Date.now() - t1;
  const out = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(out);
  ok(dl.suggestedFilename() === 'Bench Valley.zip' && fs.statSync(out).size > 64 * 1000, `exported: ${dl.suggestedFilename()}, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB (64 items, 64 images)`);
  ok(ms2 <= 5000, `B21: ${ms2} ms from the press to the download (budget 5,000)`);
  fs.rmSync(tmp, { recursive: true, force: true });
  await env.done();
})().catch(h.crash);
