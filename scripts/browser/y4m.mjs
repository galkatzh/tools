// Usage: node scripts/browser/y4m.mjs <dir with pose.jpg>  → <dir>/pose.y4m, a fake-camera clip for Chromium.
// pose.jpg: https://storage.googleapis.com/mediapipe-assets/pose.jpg (a person, arms out; never in guard).
// pose.jpg → pose.y4m (640x480 letterboxed, 30 identical frames) for Chromium's fake camera.
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright'); // e.g. PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.mjs
import fs from 'fs';
const dir = process.argv[2], b = await chromium.launch({ channel: 'chromium' }), p = await b.newPage();
const yuv = await p.evaluate(async (src) => {
  const img = new Image(); img.src = src; await img.decode();
  const W = 640, H = 480, x = new OffscreenCanvas(W, H).getContext('2d'), k = Math.min(W / img.width, H / img.height);
  x.fillRect(0, 0, W, H); x.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
  const d = x.getImageData(0, 0, W, H).data, o = new Uint8Array(W * H * 1.5);
  for (let i = 0; i < W * H; i++) o[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  for (let y = 0; y < H / 2; y++) for (let c = 0; c < W / 2; c++) {
    const i = 4 * (2 * y * W + 2 * c), [r, g, bl] = [d[i], d[i + 1], d[i + 2]];
    o[W * H + y * W / 2 + c] = 128 - 0.1687 * r - 0.3313 * g + 0.5 * bl;
    o[W * H * 1.25 + y * W / 2 + c] = 128 + 0.5 * r - 0.4187 * g - 0.0813 * bl;
  }
  return Array.from(o);
}, `data:image/jpeg;base64,${fs.readFileSync(`${dir}/pose.jpg`).toString('base64')}`);
const frame = Buffer.concat([Buffer.from('FRAME\n'), Buffer.from(yuv)]);
fs.writeFileSync(`${dir}/pose.y4m`, Buffer.concat([Buffer.from('YUV4MPEG2 W640 H480 F30:1 Ip A1:1 C420jpeg\n'), ...Array(30).fill(frame)]));
await b.close();
