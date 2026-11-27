// Makes the game-box fixtures (spec §4l; original content): run it again
// after changing it, and commit what it writes —
//   harbor/      "Harbor Run": game.json and its 6 PNGs, drawn here with a canvas
//                (a harbour board, two boats with a transparent ground, a crate,
//                two tide cards), a deck with a text card, a die, a hidden stack
//   harbor.zip   the same game zipped in one top-level folder, "harbor-run/"
//   beacon/      "Beacon Watch": a box with rules (rules.js) and no images
// Usage: node fixtures/make-boxes.js
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../h');
const { zip } = require('../zip-lib');

const OUT = __dirname;
/** Each image: [file, w, h, drawing code run on a 2D context `c` of w × h]. */
const IMAGES = [
  ['board.png', 600, 400, `
    const g = c.createLinearGradient(0, 0, 600, 400); g.addColorStop(0, '#1e6f8a'); g.addColorStop(1, '#0b3a52');
    c.fillStyle = g; c.fillRect(0, 0, 600, 400);
    c.fillStyle = '#c8a86a';
    for (const [x, y, r] of [[90, 80, 46], [480, 300, 60], [310, 210, 28]]) { c.beginPath(); c.ellipse(x, y, r * 1.3, r, 0.4, 0, 7); c.fill(); }
    c.fillStyle = '#6b4423'; c.fillRect(0, 170, 70, 60); c.fillRect(530, 40, 70, 60);
    c.strokeStyle = '#ffffff33'; c.lineWidth = 2;
    for (let k = 1; k < 6; k++) { c.beginPath(); c.moveTo(k * 100, 0); c.lineTo(k * 100, 400); c.stroke(); }
    for (let k = 1; k < 4; k++) { c.beginPath(); c.moveTo(0, k * 100); c.lineTo(600, k * 100); c.stroke(); }`],
  ...[['boat-red.png', '#dc2626'], ['boat-blue.png', '#2563eb']].map(([f, col]) => [f, 64, 64, `
    c.fillStyle = '${col}'; c.beginPath(); c.moveTo(6, 38); c.lineTo(58, 38); c.lineTo(48, 54); c.lineTo(16, 54); c.closePath(); c.fill();
    c.fillStyle = '#f8fafc'; c.beginPath(); c.moveTo(32, 6); c.lineTo(32, 34); c.lineTo(52, 34); c.closePath(); c.fill();
    c.fillStyle = '#334155'; c.fillRect(30, 6, 3, 32);`]),
  ['crate.png', 48, 48, `
    c.fillStyle = '#a16207'; c.fillRect(0, 0, 48, 48); c.strokeStyle = '#713f12'; c.lineWidth = 4;
    c.strokeRect(2, 2, 44, 44); c.beginPath(); c.moveTo(4, 4); c.lineTo(44, 44); c.moveTo(44, 4); c.lineTo(4, 44); c.stroke();`],
  ...[['tide-calm.png', '#38bdf8', 'Calm', 0.2], ['tide-storm.png', '#475569', 'Storm', 1.4]].map(([f, col, word, amp]) => [f, 200, 280, `
    c.fillStyle = '#f1f5f9'; c.fillRect(0, 0, 200, 280); c.fillStyle = '${col}'; c.fillRect(12, 12, 176, 200);
    c.strokeStyle = '#f8fafc'; c.lineWidth = 4;
    for (let r = 0; r < 4; r++) { c.beginPath(); for (let x = 12; x <= 188; x += 4) c.lineTo(x, 60 + r * 40 + Math.sin(x / 12) * 12 * ${amp}); c.stroke(); }
    c.fillStyle = '#0f172a'; c.font = 'bold 30px sans-serif'; c.textAlign = 'center'; c.fillText('${word}', 100, 255);`]),
];

const HARBOR = {
  name: 'Harbor Run',
  players: [2, 4],
  table: { shape: 'rect', w: 1600, h: 1100, felt: '#1d4e5f' },
  backs: [{ id: 'hold', color: '#5b3a1e', label: '?' }],
  pieces: [
    { id: 'harbor', name: 'Harbor', kind: 'board', img: 'board.png', w: 600, h: 400, grid: { type: 'square', cols: 6, rows: 4, cell: 100, labels: 'chess', draw: 'none' } },
    { id: 'boat', name: 'Boat', kind: 'token', shape: 'round', w: 70, faces: [{ img: 'boat-red.png', name: 'Red boat' }, { img: 'boat-blue.png', name: 'Blue boat' }] },
    { id: 'crate', name: 'Crate', kind: 'token', shape: 'rect', w: 44, img: 'crate.png', back: 'hold' },
    { id: 'd6', kind: 'die' },
  ],
  decks: [{ name: 'Tides', back: '#0e3a4a', cards: [{ file: 'tide-calm.png', name: 'Calm', count: 3 }, { file: 'tide-storm.png', name: 'Storm', count: 2 }, { name: 'Fog', text: 'Nobody sails this turn' }] }],
  setup: [
    { piece: 'harbor', at: 'center' },
    { forEachSeat: [{ piece: 'boat', at: 'seat', owner: 'seat' }] },
    { piece: 'crate', at: 'c2', up: false },
    { piece: 'crate', at: 'd3', up: false },
    { piece: 'd6', at: [1380, 140] },
    { deck: 'Tides', at: [1380, 760] },
  ],
  meta: { goal: 'Bring three crates home' },
};

const BEACON = {
  name: 'Beacon Watch',
  players: [2, 4],
  table: { shape: 'rect', w: 1400, h: 1000 },
  pieces: [
    { id: 'coast', name: 'Coast', kind: 'board', w: 500, h: 500, faces: [{ color: '#14532d' }], grid: { type: 'square', cols: 5, rows: 5, cell: 100, labels: 'chess' } },
    { id: 'beacon', name: 'Beacon', kind: 'token', shape: 'disc', w: 60, faces: [{ color: '#78350f', label: '·', name: 'Dark beacon' }, { color: '#f59e0b', label: '🔥', name: 'Lit beacon' }] },
  ],
  setup: [{ piece: 'coast', at: 'center' }, { piece: 'beacon', at: 'a1' }, { piece: 'beacon', at: 'e5' }, { forEachSeat: [{ piece: 'beacon', at: 'seat', owner: 'seat' }] }],
  rules: 'rules.js',
  rulesState: { data: { watches: 0 }, public: {}, asks: {}, secret: {} },
};
const BEACON_RULES = `// Beacon Watch: keep watch, and light the beacons. (A fixture of the game-box suites.)
({
  name: 'Beacon Watch',
  setup(t) { t.data.watches = (t.data.watches || 0) + 1; },
  buttons(t) { return [{ id: 'watch', label: '🔥 Keep watch' }]; },
  onButton(t, id, p) { t.data.watches += 1; t.say(\`kept watch \${t.data.watches} times\`); },
})
`;

(async () => {
  const browser = await h.playwright.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  fs.mkdirSync(path.join(OUT, 'harbor'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'beacon'), { recursive: true });
  const files = [];
  for (const [f, w, hgt, code] of IMAGES) {
    const url = await page.evaluate(([w, hgt, code]) => {
      const cv = Object.assign(document.createElement('canvas'), { width: w, height: hgt });
      new Function('c', code)(cv.getContext('2d')); // eslint-disable-line no-new-func
      return cv.toDataURL('image/png');
    }, [w, hgt, code]);
    const b = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    fs.writeFileSync(path.join(OUT, 'harbor', f), b);
    files.push({ name: `harbor-run/${f}`, data: b, store: true });
  }
  await browser.close();
  const json = `${JSON.stringify(HARBOR, null, 2)}\n`;
  fs.writeFileSync(path.join(OUT, 'harbor', 'game.json'), json);
  fs.writeFileSync(path.join(OUT, 'harbor.zip'), zip([{ name: 'harbor-run/game.json', data: json }, ...files]));
  fs.writeFileSync(path.join(OUT, 'beacon', 'game.json'), `${JSON.stringify(BEACON, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'beacon', 'rules.js'), BEACON_RULES);
  console.log('wrote harbor/ (game.json + 6 PNGs), harbor.zip, beacon/ (game.json + rules.js)');
})().catch(h.crash);
