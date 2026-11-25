// Phase 4A, B21 (spec §4k: "Export of Hexfront (with images) ≤ 5 s", wall
// clock), run alone (run-all.sh SERIAL). Hexfront itself is Phase 4B's, so
// this exports a board game of the same build made here: "Ridgeline Clash"
// (original), a hex map (one 2,000 × 1,500 image), sixteen counter faces and
// two backs, 400 counters in forty ×10 stacks, two dice, a deck of 24 order
// cards (twelve images), two named seats and a turn script. Its images are
// drawn in the page with a canvas; the game is picked in 📦 as its files
// (game.json, rules.js, the PNGs), set up with its rules through the trust
// dialog, one turn played, then exported from 📦 → Export… with the rules
// and the game state. The clock runs from the press of Export… to the
// download; the file must be "<name>.zip" (images are involved, §4g) and
// hold game.json at its root, rules.js and every image game.json names.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const { unzip, magic } = require('./p4-lib');

const J = JSON.stringify;
const ARMS = ['inf', 'art', 'cav', 'hq'], SIDES = { r: '#b91c1c', b: '#1d4ed8' };
/** A turn script: the seat to move ends its turn with a button (t.data.turn, t.data.round). */
const RULES = `({
  name: 'Ridgeline turns',
  setup(t) { t.data.turn ||= 'red'; t.data.round ||= 1; this.show(t); },
  show(t) { t.public.turn = t.players().find((p) => p.seatId === t.data.turn)?.id ?? null; },
  buttons(t) { const p = t.public.turn; return p ? [{ id: 'end', label: 'End turn', pid: p }] : []; },
  onButton(t, id) {
    if (id !== 'end') return;
    if (t.data.turn === 'blue') t.data.round++;
    t.data.turn = t.data.turn === 'red' ? 'blue' : 'red';
    this.show(t);
    t.say('Round ' + t.data.round + ': ' + t.data.turn + ' to move');
  },
  onJoin(t) { this.show(t); },
})`;

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-resume-bench-'));
  const alice = await P.join(env, 'Alice', env.url);

  // The pictures, drawn in the page (PNG, base64 for the trip here): {name: base64}.
  const pngs = await alice.evaluate(async ({ ARMS, SIDES }) => {
    const out = {}, png = async (name, w, hgt, draw) => {
      const c = Object.assign(document.createElement('canvas'), { width: w, height: hgt }), x = c.getContext('2d');
      draw(x, w, hgt);
      const b = await new Promise((r) => c.toBlob(r, 'image/png'));
      out[name] = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result.slice(f.result.indexOf(',') + 1)); f.readAsDataURL(b); });
    };
    await png('map.png', 2000, 1500, (x, w, hgt) => { // pointy hexes of field, wood, hill and water, a river across
      const R = 100 / Math.sqrt(3), terrain = ['#7cb342', '#33691e', '#a1887f', '#4fc3f7', '#c5e1a5'];
      x.fillStyle = '#8d9f5f';
      x.fillRect(0, 0, w, hgt);
      for (let row = 0; row < 18; row++) {
        for (let col = 0; col < 21; col++) {
          const cx = col * 100 + (row % 2) * 50, cy = row * R * 1.5;
          x.beginPath();
          for (let k = 0; k < 6; k++) x.lineTo(cx + R * Math.cos(Math.PI / 6 + (k * Math.PI) / 3), cy + R * Math.sin(Math.PI / 6 + (k * Math.PI) / 3));
          x.closePath();
          x.fillStyle = terrain[(col * 7 + row * 13 + ((col * row) % 5)) % terrain.length];
          x.fill();
          x.strokeStyle = 'rgba(0,0,0,.35)';
          x.stroke();
        }
      }
      x.strokeStyle = '#0277bd';
      x.lineWidth = 14;
      x.beginPath();
      x.moveTo(0, 700);
      for (let k = 1; k <= 20; k++) x.lineTo(k * 100, 700 + Math.sin(k / 2) * 220);
      x.stroke();
      const d = x.getImageData(0, 0, w, hgt), a = d.data; // a printed map's grain: what its encoding spends bytes on
      for (let i = 0, s = 7; i < a.length; i += 4) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const n = ((s >>> 28) - 8) * 1.5;
        a[i] += n; a[i + 1] += n; a[i + 2] += n;
      }
      x.putImageData(d, 0, 0);
    });
    for (const [s, color] of Object.entries(SIDES)) {
      await png(`back-${s}.png`, 128, 128, (x) => { x.fillStyle = color; x.fillRect(0, 0, 128, 128); x.fillStyle = 'rgba(255,255,255,.5)'; x.font = 'bold 60px sans-serif'; x.textAlign = 'center'; x.fillText('?', 64, 84); });
      for (const [k, arm] of ARMS.entries()) {
        for (const [f, str] of [[0, 4 + k], [1, 2 + (k >> 1)]]) { // a full face, then a reduced one
          await png(`${s}-${arm}-${f}.png`, 128, 128, (x) => {
            x.fillStyle = color;
            x.fillRect(0, 0, 128, 128);
            x.fillStyle = f ? '#fde68a' : '#f8fafc';
            x.fillRect(24, 22, 80, 54);
            x.strokeStyle = '#111';
            x.lineWidth = 4;
            x.strokeRect(24, 22, 80, 54);
            x.beginPath();
            if (arm === 'inf') { x.moveTo(24, 22); x.lineTo(104, 76); x.moveTo(104, 22); x.lineTo(24, 76); }
            if (arm === 'cav') { x.moveTo(24, 76); x.lineTo(104, 22); }
            if (arm === 'art') x.arc(64, 49, 12, 0, 7);
            if (arm === 'hq') { x.moveTo(24, 22); x.lineTo(24, 120); }
            x.stroke();
            x.fillStyle = '#fff';
            x.font = 'bold 30px sans-serif';
            x.textAlign = 'center';
            x.fillText(String(str), 64, 116);
          });
        }
      }
    }
    for (let k = 0; k < 12; k++) {
      await png(`order-${k}.png`, 240, 336, (x) => {
        const g = x.createLinearGradient(0, 0, 240, 336);
        g.addColorStop(0, `hsl(${k * 30} 55% 85%)`);
        g.addColorStop(1, `hsl(${k * 30 + 40} 45% 60%)`);
        x.fillStyle = g;
        x.fillRect(0, 0, 240, 336);
        x.strokeStyle = '#1f2937';
        x.lineWidth = 6;
        x.strokeRect(10, 10, 220, 316);
        x.fillStyle = '#1f2937';
        x.font = 'bold 26px serif';
        x.textAlign = 'center';
        x.fillText(['Advance', 'Hold', 'Barrage', 'Flank', 'Rally', 'Scout'][k % 6], 120, 70);
        x.font = '80px serif';
        x.fillText(String(1 + (k % 4)), 120, 210);
      });
    }
    return out;
  }, { ARMS, SIDES });

  const types = Object.keys(SIDES).flatMap((s) => ARMS.map((arm) => ({
    id: `${s}-${arm}`, kind: 'token', shape: 'rect', w: 60, stack: 'count', back: `unit-${s}`,
    faces: [0, 1].map((f) => ({ img: `${s}-${arm}-${f}.png` })),
  })));
  const game = {
    name: 'Ridgeline Clash',
    players: [2, 2],
    table: { shape: 'rect', w: 3200, h: 2200, felt: '#2f3b2a' },
    seats: [{ id: 'red', name: 'Red', edge: 'bottom', color: SIDES.r }, { id: 'blue', name: 'Blue', edge: 'top', color: SIDES.b }],
    backs: Object.keys(SIDES).map((s) => ({ id: `unit-${s}`, img: `back-${s}.png` })),
    pieces: [
      { id: 'map', kind: 'board', w: 2000, h: 1500, img: 'map.png', grid: { type: 'hex', cols: 20, rows: 14, cell: 100 } },
      ...types,
      { id: 'd6', kind: 'die', faces: [1, 2, 3, 4, 5, 6] },
    ],
    decks: [{ name: 'Orders', back: '#3f2d1d', cards: Array.from({ length: 12 }, (_, k) => ({ file: `order-${k}.png`, name: `Order ${k + 1}`, count: 2 })) }],
    setup: [
      { piece: 'map', at: 'center' },
      ...Array.from({ length: 40 }, (_, k) => ({ piece: types[k % types.length].id, n: 10, at: [700 + (k % 10) * 170, 450 + Math.floor(k / 10) * 300] })),
      { piece: 'd6', at: [2750, 300], count: 2, spread: [90, 0] },
      { deck: 'Orders', at: [2750, 600] },
    ],
    rules: 'rules.js',
  };
  const files = [['game.json', J(game, null, 2)], ['rules.js', RULES], ...Object.entries(pngs).map(([n, b]) => [n, Buffer.from(b, 'base64')])].map(([n, data]) => {
    fs.writeFileSync(path.join(tmp, n), data);
    return path.join(tmp, n);
  });

  section(`the board game picked in 📦 (${files.length} files), set up with its rules, a turn played`);
  await alice.click('#box-btn');
  await alice.waitForSelector('#box-dialog[open]');
  await alice.setInputFiles('#box-files', files);
  await alice.waitForSelector('#box-ask[open][data-kind="setup"]', { timeout: 60000 });
  await alice.click('#box-ask-btns button[value="ok"]');
  await alice.waitForSelector('#box-ask[open][data-kind="trust"]');
  await alice.click('#box-ask-btns button[value="enable"]');
  const laid = await alice.waitForFunction(() => {
    const s = window.__ct.hostState(), its = Object.values(s.items);
    return !document.querySelector('#box-dialog[open]') && !window.__ct.jobs() && s.rules?.enabled
      && its.filter((it) => it.n === 10).length === 40 && its.filter((it) => it.k === 'p').length === 1;
  }, null, { timeout: 30000 }).then(() => true, () => false);
  const s0 = await alice.evaluate(() => window.__ct.hostState());
  const counters = Object.values(s0.items).filter((it) => it.n === 10).reduce((a, it) => a + it.n, 0);
  ok(laid && counters === 400, `«Ridgeline Clash» set up with its rules: ${Object.keys(s0.items).length} items, ${counters} counters in ×10 stacks (${await alice.textContent('#box-err')})`);
  await alice.click('#rules-btns button[data-rbtn="end"]');
  ok(await alice.waitForFunction(() => window.__ct.hostState().rules.data.turn === 'blue', null, { timeout: 10000 }).then(() => true, () => false), 'Red ends the turn: the game is under way (t.data.turn: blue)');

  section('B21: exported from 📦 with its images, its rules and the game state');
  await alice.click('#box-btn');
  await alice.waitForSelector('#box-dialog[open]');
  const ticked = await alice.evaluate(() => document.getElementById('box-x-rules').checked && document.getElementById('box-x-state').checked);
  const t0 = Date.now(), [dl] = await Promise.all([alice.waitForEvent('download', { timeout: 30000 }), alice.click('#box-x-go')]), ms = Date.now() - t0;
  const out = path.join(tmp, `export-${dl.suggestedFilename()}`);
  await dl.saveAs(out);
  const buf = fs.readFileSync(out), z = unzip(buf), names = Object.keys(z);
  let g = null;
  try { g = JSON.parse(z['game.json']?.toString('utf8')); } catch (err) { console.error('the exported game.json does not parse', err); }
  const named = g ? [...new Set([...(g.backs || []).flatMap((b) => [b.img, b.face?.img]), ...(g.pieces || []).flatMap((p) => [p.img, ...(p.faces || []).map((f) => f.img)]),
    ...(g.decks || []).flatMap((d) => [d.back, ...d.cards.map((c) => c.file)])].filter((x) => typeof x === 'string' && !x.startsWith('#')))] : [];
  ok(ticked && dl.suggestedFilename() === 'Ridgeline Clash.zip', `«${dl.suggestedFilename()}»: images are involved, so a .zip (§4g); the rules and the state ticked`);
  ok(g && names.includes('rules.js') && z['rules.js'].toString('utf8') === RULES && g.rulesState?.data?.turn === 'blue',
    `game.json at the zip's root with the game state (turn ${g?.rulesState?.data?.turn}), the script as rules.js`);
  ok(named.length >= 31 && named.every((n) => z[n] && magic(z[n])), `every image game.json names is in the zip, an image by its bytes (${named.length}: ${named.filter((n) => z[n]).length} found)`);
  ok(g && g.setup.filter((e) => e.n === 10).length === 40, 'the 40 stacks of ×10 are in its setup');
  ok(ms <= 5000, `B21: ${ms} ms from the press of Export… to the download (budget 5,000) — ${(buf.length / 1e6).toFixed(2)} MB, ${names.length} files`);
  fs.rmSync(tmp, { recursive: true, force: true });
  await env.done();
})().catch(h.crash);
