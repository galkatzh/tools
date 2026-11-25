// Zips for the game-box suites (t-p4-boxes.js, t-p4-bench.js, fixtures/make-boxes.js);
// not a suite itself. A minimal writer — each entry stored or deflated, its
// local header and central directory declaring whatever size it is told to —
// and the hostile zips of spec §4j's attacker cases, each a tiny game.json
// naming one board image ("map.png"), and that image bad in its own way.
'use strict';
const zlib = require('zlib');
const { png } = require('./img-lib');
const { prng } = require('./p1-lib');

/** A .zip of `entries` [{name, data (Buffer | string), store?, declared?}]:
 *  each deflated unless `store`, its headers declaring `declared` bytes
 *  unzipped (default: the truth) — a lie a crafted directory tells. Names
 *  are written as given ("../x", "/x" included), UTF-8. */
function zip(entries) {
  const parts = [], dir = [];
  let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), name = Buffer.from(e.name);
    const body = e.store ? data : zlib.deflateRawSync(data), crc = zlib.crc32(data), size = e.declared ?? data.length, method = e.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(off, 42);
    parts.push(local, name, body);
    dir.push(central, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(dir), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** A real PNG of w × h px, RGB, from fill(row, y) writing each row's 3·w bytes (rows unfiltered, deflated). */
function rgbPNG(w, h, fill) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((3 * w + 1) * h), ihdr = Buffer.alloc(13);
  for (let y = 0; y < h; y++) fill(raw.subarray(y * (3 * w + 1) + 1, (y + 1) * (3 * w + 1)), y);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A "photograph" of w × h: a sky-to-sand gradient with soft grain in 4 × 4 blocks (opaque; a big PNG that compresses as photos do). */
function photoPNG(w, h, seed = 7) {
  const rnd = prng(seed), grain = new Int8Array(Math.ceil(w / 4));
  return rgbPNG(w, h, (row, y) => {
    if (y % 4 === 0) for (let k = 0; k < grain.length; k++) grain[k] = Math.floor(rnd() * 16) - 8;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2, g = grain[x >> 2];
      row[3 * x] = 40 + 170 * t + g;
      row[3 * x + 1] = 110 + 60 * t + g;
      row[3 * x + 2] = 160 - 70 * t + g;
    }
  });
}

/** The game.json of every hostile zip: one board whose face is `img`. */
const game = (img = 'map.png') => JSON.stringify({ name: 'Hostile', pieces: [{ id: 'map', kind: 'board', w: 600, h: 400, img }], setup: [{ piece: 'map', at: 'center' }] });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>parent.HACKED = 1</script><rect width="10" height="10"/></svg>';

/** Spec §4j's attacker cases, as zips. */
const HOSTILE = {
  /** 1: a bomb — map.png, 100 MB of zeros in about 100 KB, its directory honest: refused before it is inflated. */
  bomb: () => zip([{ name: 'game.json', data: game() }, { name: 'map.png', data: Buffer.alloc(100e6) }]),
  /** 9: the same bomb, its directory saying map.png is 1 KB: the streamed inflate stops at 1 KB. */
  liar: () => zip([{ name: 'game.json', data: game() }, { name: 'map.png', data: Buffer.alloc(100e6), declared: 1024 }]),
  /** 2: entries outside the zip, "../../evil.png" and "/abs.png". */
  slip: () => zip([{ name: 'game.json', data: game('../../evil.png') }, { name: '../../evil.png', data: png(8, 8) }, { name: '/abs.png', data: png(8, 8) }]),
  /** 3: an SVG with a script, named map.png. */
  svg: () => zip([{ name: 'game.json', data: game() }, { name: 'map.png', data: SVG }]),
  /** 4: a game.json naming a file the zip doesn't hold. */
  missing: () => zip([{ name: 'game.json', data: game('gone.png') }, { name: 'map.png', data: png(8, 8) }]),
  /** 12: a 30,000 × 30,000 PNG (its header alone). */
  huge: () => zip([{ name: 'game.json', data: game() }, { name: 'map.png', data: png(30000, 30000, undefined, { pixels: false }) }]),
};

module.exports = { zip, photoPNG, game, SVG, HOSTILE };
