/**
 * End-to-end test for audio-splitter using Playwright.
 *
 * Serves the app locally, intercepts the HuggingFace model fetch to serve
 * the local ONNX file, uploads test_song.mp3, and waits for results.
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { extname, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
};

function startServer(port) {
  const server = createServer((req, res) => {
    const filePath = resolve(__dir, req.url === '/' ? 'index.html' : req.url.slice(1));
    if (!existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const PORT     = 7777;
const ONNX_PATH = resolve(__dir, 'convert/scnet.onnx');
const MP3_PATH  = resolve(__dir, 'test_song.mp3');

for (const [label, path] of [['ONNX', ONNX_PATH], ['MP3', MP3_PATH]]) {
  if (!existsSync(path)) { console.error(`Missing ${label}: ${path}`); process.exit(1); }
}

console.log('Starting local server...');
const server = await startServer(PORT);
console.log(`  http://localhost:${PORT}`);

const browser = await chromium.launch({ headless: true });
const page    = await (await browser.newContext({ acceptDownloads: true })).newPage();

// Intercept any fetch to scnet.onnx (HuggingFace or otherwise) → serve local file
const onnxBytes = readFileSync(ONNX_PATH);
await page.route('**/scnet.onnx', (route) => {
  console.log('  [intercept] Serving local ONNX model');
  route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(onnxBytes.length) },
    body: onnxBytes,
  });
});

page.on('console', (msg) => { if (msg.type() === 'error') console.error('  [page]', msg.text()); });
page.on('pageerror', (err) => console.error('  [crash]', err.message));

await page.goto(`http://localhost:${PORT}`);
console.log('Uploading test_song.mp3...');
await page.locator('#file-input').setInputFiles(MP3_PATH);

await page.waitForSelector('#progress:not(.hidden)', { timeout: 10_000 });
console.log('Processing started — waiting for results (may take several minutes for WASM)...');

await page.waitForSelector('#results:not(.hidden)', { timeout: 20 * 60 * 1000 });

const vocalSrc = await page.locator('#vocal-player').getAttribute('src');
const instrSrc  = await page.locator('#instr-player').getAttribute('src');
const vocalDl   = await page.locator('#vocal-download').getAttribute('download');
const instrDl   = await page.locator('#instr-download').getAttribute('download');

console.log(`\nVocals src:            ${vocalSrc ? 'set ✓' : 'MISSING ✗'}`);
console.log(`Instrumental src:      ${instrSrc  ? 'set ✓' : 'MISSING ✗'}`);
console.log(`Vocals download name:  ${vocalDl}`);
console.log(`Instr download name:   ${instrDl}`);

await page.screenshot({ path: resolve(__dir, 'test_result.png'), fullPage: true });
console.log(`Screenshot: test_result.png`);

// Download the WAV files by clicking the download buttons
console.log('\nSaving audio files...');
for (const [btnId, filename] of [['#vocal-download', vocalDl], ['#instr-download', instrDl]]) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(btnId).click(),
  ]);
  const outPath = resolve(__dir, filename);
  await download.saveAs(outPath);
  console.log(`  Saved: ${outPath}`);
}

await browser.close();
server.close();

if (!vocalSrc || !instrSrc) { console.error('\n✗ FAILED'); process.exit(1); }
console.log('\n✓ PASSED');
