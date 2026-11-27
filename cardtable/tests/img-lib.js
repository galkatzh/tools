// Image fixtures made in code (no binary blobs), for the Phase 1 storage and
// image checks: real PNG and GIF files (any browser or decoder opens them),
// and JPEG and WebP files whose headers follow their formats byte for byte
// (their image data is filler: they are for header readers such as
// store.js imageDims, not for decoding). Every size field is written in
// full, so a reader that skips a byte or swaps width and height is caught;
// `hdr` on each result is how many bytes the pixel size needs (any shorter
// prefix is a truncated header).
'use strict';
const zlib = require('zlib');
const crypto = require('crypto');

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const be16 = (n) => [(n >>> 8) & 255, n & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >>> 8) & 255];
const le24 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const bytes = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
const withHdr = (b, hdr) => Object.assign(b, { hdr });

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** A PNG chunk: length, type, data, CRC of type + data. */
const pngChunk = (type, data) => { const td = bytes(ascii(type), data); return bytes(be32(data.length), td, be32(crc32(td))); };

/** A real PNG of w × h px in one RGB colour (8 bits, rows unfiltered). With
 *  {pixels: false}: the signature, IHDR and IEND only — a header declaring
 *  any size (a decompression bomb's), with nothing to decode. */
function png(w, h, rgb = [200, 30, 60], { pixels = true } = {}) {
  const parts = [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk('IHDR', [...be32(w), ...be32(h), 8, 2, 0, 0, 0])];
  if (pixels) {
    const row = Buffer.alloc(1 + 3 * w);
    for (let x = 0; x < w; x++) row.set(rgb, 1 + 3 * x);
    parts.push(pngChunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))));
  }
  parts.push(pngChunk('IEND', []));
  return withHdr(bytes(...parts), 24);
}

/** A real GIF (89a, or 87a without the extension): a 2-colour global table,
 *  one frame covering the screen in stripes, LZW-coded with a clear code
 *  before every pair of pixels (so the codes stay 3 bits wide), split into
 *  sub-blocks of ≤ 255 bytes, then the trailer. */
function gif(w, h, { v87 = false } = {}) {
  const codes = [];
  for (let k = 0; k < w * h; k += 2) codes.push(4, k % 3 ? 1 : 0, ...(k + 1 < w * h ? [(k + 1) % 3 ? 1 : 0] : []));
  codes.push(5); // end of information
  const data = [];
  let acc = 0, nbits = 0;
  for (const c of codes) {
    acc |= c << nbits;
    nbits += 3;
    while (nbits >= 8) { data.push(acc & 255); acc >>>= 8; nbits -= 8; }
  }
  if (nbits) data.push(acc & 255);
  const blocks = [];
  for (let o = 0; o < data.length; o += 255) blocks.push(Math.min(255, data.length - o), ...data.slice(o, o + 255));
  return withHdr(bytes(ascii(v87 ? 'GIF87a' : 'GIF89a'), le16(w), le16(h), [0x80, 0, 0], [220, 20, 60, 30, 60, 220],
    v87 ? [] : [0x21, 0xf9, 4, 0, 10, 0, 0, 0], // a graphic control extension
    [0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 2], blocks, [0, 0x3b]), 10);
}

/** A JPEG whose frame header (SOFn: 0xC0 baseline, 0xC1 extended, 0xC2
 *  progressive) declares w × h, after the segments a real file puts first:
 *  APP0 (JFIF), an APP1 longer than 255 bytes, DQT, and DHT — 0xC4, in the
 *  SOFn range but not a frame header — then a fill byte before the frame
 *  header. A scan and EOI follow. */
function jpeg(w, h, sof = 0xc0) {
  const seg = (m, body) => [0xff, m, ...be16(body.length + 2), ...body];
  const head = [0xff, 0xd8, ...seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...ascii('Exif'), 0, 0, ...Array(300).fill(7)]), ...seg(0xdb, [0, ...Array(64).fill(1)]),
    ...seg(0xc4, [0, 1, ...Array(15).fill(0), 0]), 0xff];
  const frame = seg(sof, [8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return withHdr(bytes(head, frame, seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), [0x12, 0x34, 0xff, 0xd9]), head.length + 9);
}

/** RIFF/WEBP files. A chunk is its FourCC, a 32-bit little-endian size, the
 *  data, and a pad byte to an even size. */
const webpChunk = (cc, data) => bytes(ascii(cc), le32(data.length), data, data.length % 2 ? [0] : []);
const riff = (...chunks) => { const body = bytes(ascii('WEBP'), ...chunks); return bytes(ascii('RIFF'), le32(body.length), body); };
/** The lossy bitstream chunk: a key frame's 3-byte tag, the start code 9D 01
 *  2A, then 14 bits each of width and height — their top 2 bits are the
 *  upscaling hints, set here (a reader must mask them off). */
const vp8 = (w, h) => webpChunk('VP8 ', [0x50, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w | (1 << 14)), ...le16(h | (2 << 14)), ...Array(10).fill(0)]);
/** The lossless chunk: the signature 0x2F, then 14 bits of width − 1 and 14 of height − 1 (little-endian bits). */
const vp8l = (w, h) => webpChunk('VP8L', [0x2f, ...le32(((w - 1) | ((h - 1) << 14)) >>> 0), ...Array(6).fill(0)]);
/** WebP, lossy (`VP8 `). */
const webpVP8 = (w, h) => withHdr(riff(vp8(w, h)), 30);
/** WebP, lossless (`VP8L`). */
const webpVP8L = (w, h) => withHdr(riff(vp8l(w, h)), 25);
/** WebP, extended (`VP8X`: flags, then 24 bits each of canvas width − 1 and
 *  height − 1). A still image is its one frame; with {anim: true}, an
 *  animation (ANIM, then an ANMF frame smaller than the canvas): the canvas
 *  is the image's size, and can need all 24 bits. */
function webpVP8X(w, h, { anim = false } = {}) {
  const x = webpChunk('VP8X', [anim ? 0x12 : 0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
  const rest = anim ? [webpChunk('ANIM', [0, 0, 0, 0, 0, 0]), webpChunk('ANMF', bytes(le24(0), le24(0), le24(99), le24(99), le24(100), [0], vp8l(100, 100)))]
    : [webpChunk('ALPH', [0, 0]), vp8(w, h)];
  return withHdr(riff(x, ...rest), 30);
}

/** An image as a data URL (what an uploaded deck carries). */
const dataURL = (b, mime = 'image/png') => `data:${mime};base64,${Buffer.from(b).toString('base64')}`;
/** An image's asset id: the hex SHA-256 of its bytes. */
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

module.exports = { png, gif, jpeg, webpVP8, webpVP8L, webpVP8X, dataURL, sha256 };
