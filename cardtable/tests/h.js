// Shared E2E harness for cardtable suites. Parallel-safe: every suite gets its
// own in-process NIP-01 relay + static file server on random ports, so many
// suites (and many agents, even in git worktrees) can run at once.
//
//   const h = require('./h');
//   (async () => {
//     const env = await h.start();               // relay + server; env.url = app URL
//     const host = await env.page('host');      // CDN routed to local copies
//     await h.joinAs(host, 'Alice');
//     ...
//     await env.done();                          // prints summary, exits with status
//   })().catch(h.crash);
//
// The APP_ROOT env var selects the repo root to serve; by default it is this
// checkout (two levels up), so every worktree tests its own code.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
// Playwright: a local install (npm i playwright) if there is one, else the machine's global one.
const playwright = require(require.resolve('playwright', { paths: [__dirname, '/opt/node22/lib/node_modules'] }));
const { chromium } = playwright;

const CDN_DIR = path.join(__dirname, '.cdn-cache');
const APP_ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '../..'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

let failures = 0;
/** Assertion: logs ✓/✗ and counts failures (never throws, so a suite reports every check). */
function ok(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ FAIL: ${msg}`); }
}
const section = (s) => console.log(`— ${s}`);
/** Prints the summary and exits: status 1 if any check failed. */
function report() {
  console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

/** Minimal NIP-01 relay: EVENT/REQ/CLOSE with ids/authors/kinds/since/until/#tag filters. */
function startRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const events = [];
  const subs = new Map(); // ws -> Map(subId -> filters[])
  const match = (f, e) => {
    if (f.ids && !f.ids.includes(e.id)) return false;
    if (f.authors && !f.authors.includes(e.pubkey)) return false;
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    if (f.since && e.created_at < f.since) return false;
    if (f.until && e.created_at > f.until) return false;
    for (const [k, vals] of Object.entries(f)) {
      if (k[0] !== '#') continue;
      const tag = k.slice(1);
      if (!e.tags.some((t) => t[0] === tag && vals.includes(t[1]))) return false;
    }
    return true;
  };
  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (err) { console.error('relay: bad frame', err.message); return; }
      const [type, ...rest] = msg;
      if (type === 'EVENT') {
        const e = rest[0];
        events.push(e);
        if (events.length > 5000) events.splice(0, 1000);
        ws.send(JSON.stringify(['OK', e.id, true, '']));
        for (const [c, m] of subs) {
          for (const [sid, filters] of m) {
            if (filters.some((f) => match(f, e)) && c.readyState === 1) c.send(JSON.stringify(['EVENT', sid, e]));
          }
        }
      } else if (type === 'REQ') {
        const [sid, ...filters] = rest;
        subs.get(ws).set(sid, filters);
        for (const e of events) if (filters.some((f) => match(f, e))) ws.send(JSON.stringify(['EVENT', sid, e]));
        ws.send(JSON.stringify(['EOSE', sid]));
      } else if (type === 'CLOSE') {
        subs.get(ws).delete(rest[0]);
      }
    });
    ws.on('close', () => subs.delete(ws));
    ws.on('error', (err) => console.error('relay socket error', err.message));
  });
  return new Promise((resolve) => wss.on('listening', () => resolve(wss)));
}

/** Static server for APP_ROOT (no caching, so edits show up on reload). */
function startServer() {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(APP_ROOT, p);
    const rel = path.relative(APP_ROOT, f); // inside APP_ROOT, not a sibling sharing its prefix
    if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); return res.end(); }
    if (p.endsWith('/')) f = path.join(f, 'index.html');
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

const fetching = new Map(); // cache file -> its download in flight
/** The local copy of a jsdelivr file (path chars [/@+] → '_', plus '.js'):
 *  fetched with curl on first use (curl honours HTTPS_PROXY), then served
 *  from .cdn-cache/. Resolves to the file's path; rejects if it can't be had. */
function cdnFile(url) {
  const f = path.join(CDN_DIR, new URL(url).pathname.replace(/^\/npm\//, '').replace(/[/@+]/g, '_') + '.js');
  if (fs.existsSync(f)) return Promise.resolve(f);
  if (!fetching.has(f)) {
    fetching.set(f, new Promise((resolve, reject) => {
      fs.mkdirSync(CDN_DIR, { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`; // parallel suites may fetch the same file: rename is atomic
      execFile('curl', ['-fsSL', '--retry', '3', '-o', tmp, url], (err, _out, stderr) => {
        if (err) { fs.rmSync(tmp, { force: true }); reject(new Error(`curl ${url} failed: ${stderr.trim() || err.message}`)); return; }
        fs.renameSync(tmp, f);
        resolve(f);
      });
    }));
  }
  return fetching.get(f);
}

async function start(opts = {}) {
  const relay = await startRelay();
  const server = await startServer();
  const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const env = {
    browser, relayUrl, base,
    url: `${base}/cardtable/`,
    /** New isolated browser context (own localStorage = own player) + page. */
    async page(label, o = {}) {
      // Reduced motion by default: animations must never make a check flaky
      // (the app honours prefers-reduced-motion); pass ctx: { reducedMotion: 'no-preference' } to see them.
      const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 800 }, reducedMotion: 'reduce', ...(o.ctx || {}) });
      await ctx.route('https://cdn.jsdelivr.net/**', (route) => cdnFile(route.request().url()).then(
        (f) => route.fulfill({ body: fs.readFileSync(f, 'utf8'), contentType: 'text/javascript' }),
        (err) => { console.error('[cdn]', err.message); return route.abort(); }));
      await ctx.addInitScript((r) => { window.CARDTABLE_RELAYS = [r]; }, o.relay || relayUrl);
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error' && !opts.quietConsole) console.log(`[${label} console.error]`, m.text().slice(0, 200));
      });
      page.on('pageerror', (e) => { failures++; console.error(`[${label} PAGEERROR]`, e.message); });
      return page;
    },
    async done() {
      await browser.close().catch((e) => console.error(e));
      relay.close(); server.close();
      report();
    },
  };
  return env;
}

// --- common page helpers ----------------------------------------------------
const joinAs = async (page, name) => {
  await page.waitForSelector('#name-dialog[open]');
  await page.fill('#name-first', name);
  await page.click('#name-join');
};
/** Host + one guest, both seated and synced. */
async function hostAndGuest(env, a = 'Alice', b = 'Bob') {
  const host = await env.page(a);
  await host.goto(env.url);
  await joinAs(host, a);
  await host.waitForSelector('.item.pile .count');
  const guest = await env.page(b);
  await guest.goto(host.url());
  await joinAs(guest, b);
  await guest.waitForSelector('.item.pile .count', { timeout: 30000 });
  await host.waitForFunction(() => document.querySelectorAll('.seat').length >= 2, null, { timeout: 30000 });
  return { host, guest };
}
const logHas = (page, txt, timeout = 15000) =>
  page.waitForFunction((t) => document.getElementById('log').textContent.includes(t), txt, { timeout });
const toastHas = (page, txt, timeout = 10000) =>
  page.waitForFunction((t) => document.getElementById('toast').textContent.includes(t), txt, { timeout });
const handCount = (page) => page.locator('.hcard').count();
const waitHand = (page, n, timeout = 20000) =>
  page.waitForFunction((x) => document.querySelectorAll('.hcard').length === x, n, { timeout });
/** Drags hand card `idx` to a spot given as fractions of the table's bounding box.
 *  Grabs it by its left edge: in a fanned (overlapping) hand that is the part
 *  that shows; a scrolled hand is scrolled to it first. */
async function playFromHand(page, idx, fx, fy) {
  const card = page.locator('.hcard').nth(idx);
  await card.scrollIntoViewIfNeeded();
  const tbl = await page.locator('#table').boundingBox();
  const hb = await card.boundingBox();
  await page.mouse.move(hb.x + Math.min(12, hb.width / 2), hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tbl.x + tbl.width * fx, tbl.y + tbl.height * fy, { steps: 12 });
  await page.mouse.up();
}
/** Opens the rules dialog, loads a template (or code) and enables it. */
async function enableRules(page, { tpl, code }) {
  await page.click('#rules-btn');
  await page.waitForSelector('#rules-dialog[open]');
  if (tpl) await page.selectOption('#rules-tpl', tpl);
  if (code) await page.fill('#rules-code', code);
  await page.click('#rules-enable');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function crash(e) { console.error('TEST CRASHED:', e); process.exit(2); }

module.exports = { start, ok, section, report, joinAs, hostAndGuest, logHas, toastHas, handCount, waitHand, playFromHand, enableRules, sleep, crash, playwright, APP_ROOT };
