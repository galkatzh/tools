// Benchmarks B20 and B21 (spec §4k), independent of the implementer's
// t-p4-bench.js; in run-all.sh's serial batch (wall clocks need a quiet
// machine). A generated board game (4B's Hexfront doesn't exist yet): a
// board (a 2,400 × 1,800 photograph) and 63 kinds of counter (580 × 430
// photographs) — 64 images, ≈ 20 MB in one zip — picked in the host's 📦
// dialog on a desktop.
//  B20  the zip imported (read, checked, every image re-encoded, the box
//       added) in ≤ 10 s, with its progress shown file by file;
//  B21  the box set up (counters in stacks), then exported with its images
//       (Export… pressed → the file downloaded) in ≤ 5 s.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const X = require('./p4-lib');

const KINDS = 63;

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-box-bench-'));
  const alice = await env.page('Alice');
  await alice.addInitScript(X.watchers);
  await X.zipSpy(alice);
  await alice.goto(env.url);
  await h.joinAs(alice, 'Alice');
  await alice.waitForFunction(() => window.__ct?.view()?.seq > 0, null, { timeout: 30000 });

  section('B20: a 64-image zip of ≈ 20 MB imported from 📦 on the desktop, in ≤ 10 s, progress shown');
  const game = {
    name: 'Bench Front', table: { shape: 'rect', w: 4000, h: 3000 },
    pieces: [{ id: 'map', kind: 'board', img: 'map.png', w: 2400, h: 1800 },
      ...Array.from({ length: KINDS }, (_, k) => ({ id: `c${k}`, kind: 'token', shape: 'rect', w: 60, img: `counters/c${k}.png` }))],
    setup: [{ piece: 'map', at: 'center' },
      ...Array.from({ length: KINDS }, (_, k) => ({ piece: `c${k}`, n: 2 + (k % 5), at: [900 + (k % 9) * 260, 900 + Math.floor(k / 9) * 180] }))],
  };
  const entries = [{ name: 'bench-front/game.json', data: JSON.stringify(game) }, { name: 'bench-front/map.png', data: X.photo(2400, 1800, 500), store: true },
    ...Array.from({ length: KINDS }, (_, k) => ({ name: `bench-front/counters/c${k}.png`, data: X.photo(580, 430, 600 + k), store: true }))];
  const zipPath = path.join(tmp, 'bench-front.zip');
  fs.writeFileSync(zipPath, X.zip(entries));
  const mb = fs.statSync(zipPath).size / 1e6;
  ok(entries.length - 1 === 64 && mb > 17 && mb < 23, `the zip: 64 images, ${mb.toFixed(1)} MB (≈ 20 MB): precondition`);
  await X.openBoxes(alice);
  await alice.setChecked('#box-now', false);
  // the clock starts when the page has the files (the input's change event), JSZip's first fetch included
  await alice.evaluate(() => document.getElementById('box-files').addEventListener('change', () => { window.__picked = performance.now(); }, { once: true, capture: true }));
  const t0 = Date.now();
  await alice.setInputFiles('#box-files', zipPath);
  await alice.waitForFunction(() => /^Added «Bench Front»/.test(document.getElementById('box-progress').textContent) || document.getElementById('box-err').textContent, null, { timeout: 60000 });
  const ms = (await alice.evaluate(() => performance.now())) - (await alice.evaluate(() => window.__picked));
  const err = await alice.evaluate(() => document.getElementById('box-err').textContent);
  ok(!err, `imported (${err || 'Added «Bench Front»'})`);
  ok(ms <= 10000, `B20: ${Math.round(ms)} ms from the pick to "Added" (≤ 10,000)`);
  const progress = (await X.boxSaid(alice, t0)).filter((s) => s.el === 'box-progress').map((s) => s.msg);
  const counted = new Set(progress.map((m) => /\((\d+)\/64\)/.exec(m)?.[1]).filter(Boolean));
  ok(counted.size === 64 && progress.some((m) => m.includes('map.png')) && progress.some((m) => m.includes('c62.png')), `the progress named the files as they were read: ${counted.size} of 64 counted ("${progress[1]}" … "${progress.at(-2)}")`);
  const st = await X.S(alice), id = Object.keys(st.boxes).find((k) => st.boxes[k].name === 'Bench Front');
  ok(id && st.boxes[id].imgs.length === 64, `the box holds its 64 images (${id && st.boxes[id].imgs.length})`);

  section('B21: the box set up, then exported with its images, in ≤ 5 s');
  await X.press(alice, `#box-list .box-row[data-box="${id}"] button[data-act="setup"]`);
  await X.asked(alice, 'setup');
  await X.reply(alice, 'Set up');
  await alice.waitForFunction((n) => Object.keys(window.__ct.hostState().items).length === n, KINDS + 1, { timeout: 30000 });
  await X.settle(alice);
  const pieces = Object.values((await X.S(alice)).items).reduce((n, it) => n + (it.n || 1), 0);
  ok(pieces === 1 + game.setup.slice(1).reduce((n, e) => n + e.n, 0), `set up: the board and ${pieces - 1} counters in ${KINDS} stacks`);
  await X.openBoxes(alice);
  const t1 = await alice.evaluate(() => performance.now());
  const [dl] = await Promise.all([alice.waitForEvent('download', { timeout: 30000 }), alice.click('#box-x-go')]);
  const ms2 = (await alice.evaluate(() => performance.now())) - t1;
  const out = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(out);
  const files = X.unzip(fs.readFileSync(out));
  const imgs = Object.keys(files).filter((n) => n.startsWith('images/'));
  ok(dl.suggestedFilename() === 'Bench Front.zip' && imgs.length === 64, `exported "${dl.suggestedFilename()}" with its ${imgs.length} images (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
  ok(ms2 <= 5000, `B21: ${Math.round(ms2)} ms from Export… to the download (≤ 5,000)`);
  fs.rmSync(tmp, { recursive: true, force: true });
  await env.done();
})().catch(h.crash);
