// Usage: serve the main checkout on :8765 (python3 -m http.server 8765), then
//   node scripts/browser/hookdrill.mjs <Math.random value> <pose.y4m> <screenshot path prefix>
// Runs the hook drill with a fake camera and prints the prompts shown and saved.
// Drive the hook drill in Chromium with the fake camera; Math.random pinned via argv[2].
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright'); // e.g. PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.mjs
import { execFileSync } from 'child_process';
import fs from 'fs';
const [R, cam, out] = [+process.argv[2], process.argv[3], process.argv[4]];
const browser = await chromium.launch({ channel: 'chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cam}`] });
const ctx = await browser.newContext({ acceptDownloads: true });
// Chromium doesn't trust the sandbox proxy's CA; curl does (TLS verification stays on).
const cache = new Map();
await ctx.route(/^https:/, async (route) => {
  const url = route.request().url();
  if (!cache.has(url)) cache.set(url, execFileSync('curl', ['-sSfL', url], { maxBuffer: 1 << 26 }));
  await route.fulfill({ body: cache.get(url), contentType: url.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(url) ? 'text/javascript' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
});
await ctx.addInitScript((r) => { Math.random = () => r; }, R);
const page = await ctx.newPage(), errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8765/fighter/');
await page.click('#start');
await page.waitForFunction(() => !document.getElementById('hooks').disabled, null, { timeout: 120000 });
await page.evaluate(() => { fighter.cfg.calibMs = 6000; }); // headless runs ~3 fps
await page.keyboard.press('h');
const seen = new Set();
for (let i = 0; i < 70; i++) {
  await page.waitForTimeout(500);
  const p = await page.$eval('#prompt', (e) => (e.className ? '[GO] ' : '') + e.innerText.replace(/\n/g, ' / '));
  if (p) seen.add(p);
  if (i === 60) await page.screenshot({ path: out + '.png', clip: { x: 0, y: 90, width: 960, height: 300 } });
}
console.log('prompts shown:\n  ' + [...seen].join('\n  '));
const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
const s = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
console.log('saved', dl.suggestedFilename(), '| mode', s.mode, '| prompts', JSON.stringify(s.prompts.map((p) => p.label + (p.end ? `(${((p.end - p.t) / 1000).toFixed(1)}s)` : ''))));
console.log('errors:', errors.length ? errors : 'none', '| banner:', (await page.textContent('#error')) || '(empty)');
await browser.close();
