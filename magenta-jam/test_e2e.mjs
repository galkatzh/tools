// End-to-end test of the Magenta Jam app in headless Chromium (Playwright).
//   node test_e2e.mjs [wasm|webgpu] [seconds]
// Starts a static server for the repo root, presses Start, plays notes, swaps
// the prompt, and checks that audio is generated without errors. WebGPU runs
// on SwiftShader when there is no GPU. Optional env for sandboxes without CDN /
// Hugging Face access: E2E_LITERT_DIR (dir with litert-core.esm.js,
// wasm-utils.esm.js and the @litertjs/core wasm/ files) and E2E_MUSICCOCA_DIR
// (dir with the three MusicCoCa files).
import { chromium } from 'playwright';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LITERT = process.env.E2E_LITERT_DIR, MUSICCOCA = process.env.E2E_MUSICCOCA_DIR;
const backend = process.argv[2] || 'wasm';
const seconds = Number(process.argv[3] || 60);
const PORT = 8770 + Math.floor(Math.random() * 200);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = MUSICCOCA && p.startsWith('/__musiccoca/') ? join(MUSICCOCA, p.slice('/__musiccoca/'.length)) : join(ROOT, p);
  try {
    const size = statSync(f).size;
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
    res.end(readFileSync(f));
  } catch (e) { res.writeHead(404); res.end('404 ' + p); }
}).listen(PORT);

const browser = await chromium.launch({
  headless: true, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', chromiumSandbox: false,
  args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--enable-features=Vulkan', '--use-angle=swiftshader',
    '--use-gl=angle', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
const page = await ctx.newPage();
if (LITERT) {   // serve the LiteRT.js bundle + wasm from disk instead of jsDelivr
  const local = {
    'https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/+esm': [`${LITERT}/litert-core.esm.js`, 'text/javascript'],
    'https://cdn.jsdelivr.net/wasm-utils.esm.js': [`${LITERT}/wasm-utils.esm.js`, 'text/javascript'],
  };
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (local[url]) return route.fulfill({ status: 200, contentType: local[url][1], headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(local[url][0]) });
    if (url.startsWith('https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/wasm/')) {
      const f = `${LITERT}/wasm/` + url.split('/wasm/')[1];
      if (!existsSync(f)) return route.fulfill({ status: 404 });
      return route.fulfill({ status: 200, contentType: f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(f) });
    }
    if (url.startsWith('https://')) { console.log('[unexpected external]', url); return route.abort(); }
    return route.continue();
  });
}
const errors = [];
const isNoise = (t) => /^(INFO|WARNING): \[/.test(t) || /could not cache|Quota exceeded/.test(t);   // LiteRT chatter, storage quota
page.on('console', (m) => { const t = m.text(); if ((m.type() === 'error' || /error/i.test(t)) && !isNoise(t)) { errors.push(t); console.log('[console.' + m.type() + ']', t.slice(0, 400)); } });
page.on('response', (r) => { if (r.status() >= 400) console.log('[http ' + r.status() + ']', r.url()); });
page.on('worker', (w) => w.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /error|ready|compiled|downloaded|generating|style tokens/i.test(t)) console.log('[worker.' + m.type() + ']', t.slice(0, 300)); }));
setInterval(async () => { try { console.log('[status]', await page.textContent('#status'), '| log tail:', (await page.textContent('#log')).trim().split('\n').slice(-3).join(' // ').slice(0, 400)); } catch (e) { console.log('[status] unavailable', e.message.split('\n')[0]); } }, 30000).unref();
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });

await page.goto(`http://localhost:${PORT}/magenta-jam/` + (MUSICCOCA ? `?hf=http://localhost:${PORT}/__musiccoca/` : ''));
await page.selectOption('#backend', backend);
await page.click('#start');
const t0 = Date.now();
await page.waitForFunction(() => /Playing|error/i.test(document.getElementById('status').textContent), null, { timeout: 30 * 60 * 1000 });
console.log(`status after start (${((Date.now() - t0) / 1000).toFixed(0)} s):`, await page.textContent('#status'));
if (/error/i.test(await page.textContent('#status'))) { console.log('--- log ---\n' + (await page.textContent('#log'))); await browser.close(); server.kill(); process.exit(1); }

// Play some notes and change the prompt while generating.
await page.keyboard.down('KeyA'); await page.keyboard.down('KeyD');
await new Promise((r) => setTimeout(r, seconds * 1000 / 2));
await page.keyboard.up('KeyA'); await page.keyboard.up('KeyD');
await page.click('.preset:nth-child(2)');
await page.click('[data-note="67"]');
await new Promise((r) => setTimeout(r, seconds * 1000 / 2));
console.log('stats:', await page.textContent('#stats'));
await page.click('#stop');
await page.waitForFunction(() => /Stopped|error/i.test(document.getElementById('status').textContent), null, { timeout: 120000 });
console.log('status:', await page.textContent('#status'));
console.log('--- log ---\n' + (await page.textContent('#log')));
await page.screenshot({ path: `e2e_${backend}.png`, fullPage: true });
console.log('errors:', errors.length);
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
