// Makes the "Lantern Isles" fixtures of the independent game-box suites
// (t-p4-box-ui.js, t-p4-box-files.js): `node fixtures/make-lantern.js`.
// Original content: a sea chart, two lanterns, a cache and two wind cards,
// drawn with a canvas in Chromium (so they are real browser-made PNGs, some
// with a transparent ground), and the game.json, rules.js and lantern.zip
// that go with them. Run it again after changing it, and commit what it writes.
'use strict';
const fs = require('fs');
const path = require('path');
const { playwright } = require('../h');
const { zip } = require('../p4-lib');

const OUT = path.join(__dirname, 'lantern');

/** Each image: [file name, width, height, a drawing (run in the page as draw(ctx, w, h, arg): no closure), arg]. */
const IMAGES = [
  ['board.png', 1400, 1000, (ctx, w, h) => {
    ctx.fillStyle = '#14506a'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 3;
    for (let k = 0; k < 40; k++) { ctx.beginPath(); ctx.arc((k * 197) % w, (k * 131) % h, 30 + (k % 7) * 9, 0.2, 2.4); ctx.stroke(); } // waves
    for (const [x, y, r] of [[300, 250, 90], [1050, 300, 70], [700, 720, 110], [220, 800, 60]]) { // isles
      ctx.fillStyle = '#d9c38c'; ctx.beginPath(); ctx.ellipse(x, y, r * 1.3, r, 0.3, 0, 7); ctx.fill();
      ctx.fillStyle = '#3f7d3a'; ctx.beginPath(); ctx.ellipse(x, y - 8, r * 0.9, r * 0.65, 0.3, 0, 7); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
    for (let x = 0; x <= w; x += 200) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 200) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }],
  ...['dark', 'lit'].map((kind) => [`lantern-${kind}.png`, 128, 128, (ctx, w, h, kind) => {
    const lit = kind === 'lit';
    if (lit) { const g = ctx.createRadialGradient(64, 70, 4, 64, 70, 62); g.addColorStop(0, 'rgba(255,220,120,0.95)'); g.addColorStop(1, 'rgba(255,180,60,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128); }
    ctx.fillStyle = '#3b2a1a'; ctx.fillRect(48, 14, 32, 10); ctx.fillRect(44, 100, 40, 12); // cap and foot
    ctx.fillStyle = lit ? '#ffd166' : '#4a5563'; ctx.beginPath(); ctx.moveTo(46, 26); ctx.lineTo(82, 26); ctx.lineTo(88, 98); ctx.lineTo(40, 98); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#3b2a1a'; ctx.lineWidth = 4; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(64, 26); ctx.lineTo(64, 98); ctx.stroke();
    ctx.strokeStyle = '#3b2a1a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(64, 12, 9, Math.PI, 0); ctx.stroke(); // handle
  }, kind]),
  ['cache.png', 700, 700, (ctx) => { // (larger than a piece's 560 px: the upload scales it down)
    ctx.scale(700 / 96, 700 / 96);
    ctx.fillStyle = '#e8dcc0'; ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = '#8a5a2b'; ctx.fillRect(14, 30, 68, 50); ctx.fillStyle = '#6b4220'; ctx.fillRect(14, 22, 68, 14);
    ctx.fillStyle = '#e0b84a'; ctx.fillRect(42, 40, 12, 14);
    ctx.strokeStyle = '#3b2a1a'; ctx.lineWidth = 3; ctx.strokeRect(14, 22, 68, 58);
  }],
  ...[['north', -1], ['south', 1]].map(([dir, s]) => [`wind-${dir}.png`, 250, 350, (ctx, w, h, [dir, s]) => {
    ctx.fillStyle = '#f4efe2'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#24435a'; ctx.lineWidth = 8; ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = '#24435a'; ctx.beginPath(); // an arrow, up or down
    ctx.moveTo(w / 2, h / 2 + s * 110); ctx.lineTo(w / 2 - 55, h / 2 + s * 30); ctx.lineTo(w / 2 + 55, h / 2 + s * 30); ctx.closePath(); ctx.fill();
    ctx.fillRect(w / 2 - 14, h / 2 - (s > 0 ? 90 : -30), 28, 60);
    ctx.font = 'bold 54px serif'; ctx.textAlign = 'center'; ctx.fillText(dir[0].toUpperCase(), w / 2, s > 0 ? 80 : h - 40);
  }, [dir, s]]),
];

const GAME = {
  name: 'Lantern Isles',
  players: [2, 4],
  table: { shape: 'rect', w: 1600, h: 1100, felt: '#1b3b4f' },
  backs: [{ id: 'tide', color: '#2b4a5e', label: '~' }],
  pieces: [
    { id: 'sea', name: 'Sea chart', kind: 'board', img: 'board.png', w: 700, h: 500, grid: { type: 'square', cols: 7, rows: 5, cell: 100, labels: 'chess', draw: 'none' } },
    { id: 'lantern', name: 'Lantern', kind: 'token', shape: 'round', w: 64, faces: [{ img: 'lantern-dark.png', name: 'Dark lantern' }, { img: 'lantern-lit.png', name: 'Lit lantern' }] },
    { id: 'cache', name: 'Cache', kind: 'token', shape: 'rect', w: 50, img: 'cache.png', back: 'tide' },
    { id: 'd6', kind: 'die' },
  ],
  decks: [{
    name: 'Winds', back: '#24435a', cards: [
      { file: 'wind-north.png', name: 'North wind' }, { file: 'wind-south.png', name: 'South wind' },
      { name: 'Calm', text: 'Nothing stirs' }, { name: 'Squall', text: 'Move a lantern one cell' },
      { name: 'Fog', text: 'Hide a cache' }, { name: 'Gale', text: 'Every lantern goes dark' },
    ],
  }],
  setup: [
    { piece: 'sea', at: 'center', id: '5ea0c4a7' },
    { forEachSeat: [{ piece: 'lantern', at: 'seat', owner: 'seat' }] },
    { piece: 'lantern', f: 1, at: 'd3', id: '1a7e0001' },
    { piece: 'cache', up: false, at: 'b4' },
    { piece: 'cache', up: false, at: 'f2' },
    { piece: 'd6', at: [1380, 160] },
    { pile: [1, 2, 4, 5].map((i) => ({ deck: 'Winds', i, up: false })), at: [1360, 820], name: 'Winds', id: '0dec0a11' },
    { hands: { '#1': [{ deck: 'Winds', i: 0 }], '#2': [{ deck: 'Winds', i: 3 }] } },
  ],
  meta: { goal: 'Light every lantern before the gale' },
};

const RULES = `// Lantern Watch: light the lanterns, one by one. (A fixture of the game-box suites; original.)
({
  name: 'Lantern Watch',
  setup(t) {
    t.data.lit ??= 0;
    t.data.box ??= t.boxes().find((b) => b.name === 'Lantern Watch')?.id ?? null;
  },
  buttons(t) { return [{ id: 'light', label: '🏮 Light a lantern' }]; },
  onButton(t, id) {
    if (id !== 'light') return;
    t.data.lit += 1;
    t.public.lit = t.data.lit;
    t.say(\`lanterns lit: \${t.data.lit}\`);
  },
})
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const files = {};
  for (const [name, w, h, draw, arg] of IMAGES) {
    const url = await page.evaluate(([w, h, src, arg]) => {
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
      (0, eval)(`(${src})`)(c.getContext('2d'), w, h, arg); // eslint-disable-line no-eval
      return c.toDataURL('image/png');
    }, [w, h, draw.toString(), arg]);
    files[name] = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  }
  await browser.close();
  files['game.json'] = Buffer.from(`${JSON.stringify(GAME, null, 2)}\n`);
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), data);
  fs.writeFileSync(path.join(OUT, 'rules.js'), RULES);
  // The zip: the same game in one top-level folder, as a zip tool writes it
  const names = Object.keys(files).sort();
  fs.writeFileSync(path.join(__dirname, 'lantern.zip'), zip([{ name: 'lantern-isles/', dir: true }, ...names.map((n) => ({ name: `lantern-isles/${n}`, data: files[n] }))]));
  console.log(`wrote ${names.length} files and rules.js to ${OUT}, and lantern.zip`);
})().catch((err) => { console.error(err); process.exit(1); });
