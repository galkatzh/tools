// The Phase 3B fix-up's regressions on real screens (the reviews of 3B: spec
// §3f, SPEC D132–D143). Alice hosts on a desktop; Bob and Carol play; Mallory
// is a raw peer (final-lib). Every check reads what a person would see — the
// views, the log, the toasts — and the host's __ct (digest(),
// workerDigest(), jobs(), lastRulesError, perf).
//  1. Hints start afresh on every Enable (D121): a new Worker's mirror starts
//     with the host's hints, so the Enable's clear reaches the host (D139).
//  2. The running rules crash while new ones start (an Enable): the start
//     begins again from the table as it now is and ends with the rules on,
//     or — a script whose top level never ends — its own watchdog still
//     fails it; never a silent hang (D134).
//  3. A player who reconnects while their `_leave` waits behind a slow hook
//     is online once the queue has run (lastPresence, D141).
//  4. An onLeave that never ends: the watchdog stops the rules, and the
//     departure is kept (KEPT_JOBS, D134).
//  5. A guest's flood while a hook runs never grows the host's queue (a
//     refusal re-sends at once, outside the queue: D141).
//  6. A crash's words: the host's toast and dialog say them, on one line;
//     the public log says only that the script crashed (D136).
//  7. Enable evaluates the script once, under the start's budget (D137).
//  8. Saved rules that meet a skewed rules-worker.js on a host's reload stay
//     on in the save: the reload the toast asks for runs them (D138).
//  9. An explicit address under a newer board, then a new felt: the host keeps
//     the Worker's address (D132).
// The other fixes are checked where they belong: core-p3.test.mjs (RF), and
// t-p3-attack.js (the script's own messages, the APIs taken away, close(): D140).
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./h');
const S = require('./p3-lib');
const { mallory } = require('./final-lib');
const { ok, section, toastHas, sleep } = h;
const J = JSON.stringify;

const act = (p, a) => p.evaluate((a) => window.__ct.act(a), a);
/** A bounded wait: true when `fn(arg)` held on page p within `ms`, else false. */
const until = (p, fn, arg, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const lastErr = (host) => host.evaluate(() => window.__ct.lastRulesError);
const perf = (host) => host.evaluate(() => ({ ...window.__ct.perf }));
const mark = (p) => p.evaluate(() => Date.now());
/** The texts of page p's log lines stamped at or after mark t0. */
const since = (p, t0) => p.evaluate((t0) => window.__ct.log().filter((l) => l.ts >= t0).map((l) => l.txt), t0);
/** [the Worker's digest, the host's], with no job queued or in flight. */
const digests = (host) => host.evaluate(async () => {
  const end = performance.now() + 20000;
  while (window.__ct.jobs() && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
  const hd = window.__ct.digest();
  return [await window.__ct.workerDigest(), hd];
});
/** Every toast page p shows from now on (one may replace another at once). */
const watchToasts = (p) => p.evaluate(() => {
  const el = document.getElementById('toast');
  window.__toasts = [];
  window.__toastObs?.disconnect();
  window.__toastObs = new MutationObserver(() => window.__toasts.push(el.textContent));
  window.__toastObs.observe(el, { childList: true, characterData: true, subtree: true });
});
const toasts = (p) => p.evaluate(() => window.__toasts || []);
const idle = (host, ms = 20000) => until(host, () => window.__ct.jobs() === 0, null, ms);

(async () => {
  const env = await h.start();
  const host = await S.join(env, 'Alice', env.url);
  await host.waitForSelector('.item.pile .count');
  const invite = await host.evaluate(() => location.href);
  const bob = await S.join(env, 'Bob', invite);
  const pile = await host.evaluate(() => Object.keys(window.__ct.view().items).find((id) => window.__ct.view().items[id].k === 'p'));
  const enable = (code, o = {}) => act(host, { t: 'setRules', code, enabled: true, ...o });
  const rulesOn = () => host.evaluate(() => !!window.__ct.view().rules?.enabled);
  const sameDigests = async (what) => {
    const [wd, hd] = await digests(host);
    ok(wd !== null && wd === hd, `${what}: the Worker's mirror equals the host's table (${wd} / ${hd})`);
  };

  section('1. Hints start afresh on every Enable (D121): the new Worker\'s mirror starts with the host\'s hints (D139)');
  {
    const HINTER = "({ name: 'Hinter', onSelect(t, p, id) { t.hint(p, { items: [id] }); } })";
    ok((await enable(HINTER)).ok, 'the hinting script is on');
    await act(bob, { t: 'select', id: pile });
    ok(await until(bob, (id) => window.__ct.view().hint?.items?.includes(id), pile), "Bob selects the deck: his screen's view has the hint");
    ok((await enable(HINTER)).ok, 'the host enables it again');
    ok(await until(bob, () => !window.__ct.view().hint, null, 10000), 'Bob\'s hint is gone (hint: null reached him)');
    await sameDigests('after the Enable');
  }

  section('2. The running rules crash while new ones start: the start begins again, from the table as it now is (D134)');
  {
    // the old script's chat arms a continuation that throws 1.5 s later: an unhandled rejection in its Worker
    const OLD = `({ name: 'Old', onChat(t, m) { if (m === 'arm') Atomics.waitAsync(new Int32Array(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer), 0, 0, 1500).value.then(() => { throw new Error('late crash'); }); } })`;
    const NEW = "({ name: 'New', x: (() => { const e = Date.now() + 3000; while (Date.now() < e); })(), onChat(t, m) { if (m === 'ping') t.say('new pong'); } })";
    ok((await enable(OLD)).ok, 'the old script is on');
    const p0 = await perf(host), t0 = await mark(host);
    await act(host, { t: 'chat', msg: 'arm' });
    const res = await enable(NEW); // (3 s of evaluation: the old Worker crashes 1.5 s into it)
    const lines = await since(host, t0), p1 = await perf(host);
    ok(res.ok && await rulesOn() && await host.evaluate(() => window.__ct.view().rules.name === 'New'), `the Enable resolves ${J(res)} with «New» ON — never "enabled" in the log with the rules off`);
    ok(lines.includes('rules disabled — the script crashed') && lines.indexOf('rules disabled — the script crashed') < lines.findIndex((l) => l.startsWith('«New» enabled by Alice')),
      `the log: the old rules' crash, then «New» enabled (${J(lines.filter((l) => /rules|New/.test(l)))})`);
    ok(p1.workerStarts - p0.workerStarts === 2, `the start began again from the table as it then was (${p1.workerStarts - p0.workerStarts} Workers started)`);
    await act(host, { t: 'chat', msg: 'ping' });
    ok(await until(host, () => window.__ct.log().some((l) => l.txt.includes('new pong'))), '«New» answers the next chat');
    await sameDigests('after the restarted start');

    // a new script whose top level never ends: its start's own watchdog still fails it
    ok((await enable(OLD)).ok, 'the old script is on again');
    await act(host, { t: 'chat', msg: 'arm' });
    const t1 = Date.now(), res2 = await enable("({ name: 'Hang', x: (() => { for (;;); })() })"), took = Date.now() - t1;
    ok(!res2.ok && /didn't start within 10 seconds/.test(res2.error) && took < 16000, `a top level that never ends: the Enable fails after its start's budget (${took} ms, ${J(res2)})`);
    const r = await act(bob, { t: 'rot', id: pile, rot: 90 });
    ok(r.ok && await until(host, (id) => window.__ct.view().items[id].rot === 90, pile) && await idle(host, 3000), 'the queue goes on: Bob\'s next move applies (no hang)');
    ok(!(await rulesOn()), 'the rules are off (the old ones crashed; the new ones never started)');
  }

  section('3. A reconnect while its _leave waits behind a slow hook: online once the queue has run (D141)');
  const carol = await S.join(env, 'Carol', invite);
  {
    ok((await enable("({ name: 'Slow', onAction(t, a) { if (a.t === 'rot') { const e = Date.now() + 2500; while (Date.now() < e); } } })")).ok, 'a script whose rot takes 2.5 s');
    const t0 = await mark(host);
    await bob.evaluate((id) => { for (const rot of [0, 90, 180]) window.__ct.act({ t: 'rot', id, rot }); }, pile);
    ok(await until(host, () => window.__ct.jobs() >= 2, null, 5000), 'Bob\'s three moves wait in the host\'s queue');
    carol.watchdogOK = true;
    await carol.reload();
    await carol.waitForFunction(() => window.__ct?.view().seq > 0 && !!window.__ct.view().players[localStorage.getItem('ct-pid')], null, { timeout: 30000 });
    const waiting = await host.evaluate(() => window.__ct.jobs());
    ok(await idle(host), `Carol reloaded with ${waiting} jobs in the host's queue; it ran them`);
    await sleep(4000); // (her knocks and the broadcast ticks)
    const lines = (await since(host, t0)).filter((l) => /left the table|back at the table/.test(l));
    console.log(`  (her old connection's close ${lines.includes('left the table') ? 'reached the host while her new one was up: the race' : 'was not seen before her new connection: no race this time'} — ${J(lines)})`);
    ok(await host.evaluate((p) => window.__ct.view().players[p]?.online === true, carol.pid) && (!lines.length || lines.at(-1) === 'is back at the table'),
      `Carol, connected again, is online on the host, and her presence ends with her return (${J(lines)})`);
  }

  section('4. An onLeave that never ends: the watchdog stops the rules, and the departure is kept (D134)');
  {
    ok((await enable("({ name: 'Stuck', onLeave(t, p) { for (;;); } })")).ok, 'a script whose onLeave never ends');
    await watchToasts(host);
    await carol.context().close();
    ok(await until(host, () => window.__ct.lastRulesError === 'the script took longer than 4 s (stopped)', null, 40000), `the watchdog stops the rules once Carol's departure runs onLeave ("${await lastErr(host)}")`);
    ok(await until(host, (p) => window.__ct.view().players[p]?.online === false, carol.pid, 5000), 'Carol, gone, is offline on the host — her departure was not dropped');
    ok(await host.evaluate(() => window.__ct.log().some((l) => l.txt === 'left the table')), 'the log says she left');
    ok(!(await toasts(host)).some((t) => /your action was not applied/.test(t)), 'and nobody is told an action of theirs was dropped');
  }

  section('5. A flood while a hook runs: refused actions re-send at once, and never grow the host\'s queue (D141)');
  {
    const M = await mallory(env, invite, 2);
    await M.act({ t: 'hello' });
    await M.waitForFunction(() => window.M.got.state.length > 0, null, { timeout: 20000 });
    ok((await enable("({ name: 'Busy', onButton(t, id) { const e = Date.now() + 3000; while (Date.now() < e); }, buttons: (t) => [{ id: 'slow', label: 'Slow', pid: t.hostId }] })")).ok, 'a script whose button takes 3 s');
    await host.evaluate(() => { window.__peak = 0; window.__samp = setInterval(() => { window.__peak = Math.max(window.__peak, window.__ct.jobs()); }, 20); window.__slow = window.__ct.act({ t: 'rulesBtn', id: 'slow' }); });
    const sent = await M.evaluate(async (pile) => {
      const end = Date.now() + 2500;
      let n = 0;
      while (Date.now() < end) { for (let k = 0; k < 20; k++) { window.M.act({ t: 'rot', id: pile, rot: 90, pad: 'x'.repeat(500) }); n++; } await new Promise((r) => setTimeout(r, 5)); }
      return n;
    }, pile);
    await host.evaluate(() => window.__slow);
    await sleep(1500);
    const peak = await host.evaluate(() => { clearInterval(window.__samp); return window.__peak; });
    // (her actions flood control lets through queue as they should: a burst of 40, then 20 a second — for a hook's 4 s, at most 120)
    ok(sent > 1000 && peak <= 125, `Mallory sent ${sent} actions during the hook; the host's queue peaked at ${peak} jobs: what flood control let through (it grew with her rate before)`);
    ok(await idle(host, 5000), 'and is empty soon after');
    await M.context().close();
  }

  section('6. A crash\'s words: the host\'s toast and dialog say them on one line; the public log only that the script crashed (D136)');
  {
    ok((await enable("({ name: 'Getter', get allow() { throw new Error('boom'); } })")).ok, 'a script whose `allow` getter throws');
    await watchToasts(host);
    const t0 = await mark(bob);
    await act(bob, { t: 'rot', id: pile, rot: 270 });
    ok(await until(host, () => !window.__ct.view().rules?.enabled), 'the rules are off');
    const tl = await toasts(host), err = await lastErr(host);
    ok(tl.includes('Rules disabled — the script crashed: boom') && !tl.some((t) => /\n|\bat .*\.js/.test(t)), `the host's toast: one line, no stack (${J(tl)})`);
    ok(err === 'the script crashed: boom', `the 📜 dialog's error: "${err}"`);
    ok(await until(bob, (t0) => window.__ct.log().some((l) => l.ts >= t0 && l.txt === 'rules disabled — the script crashed'), t0) && !(await since(bob, t0)).some((l) => l.includes('boom')),
      `Bob's log: "rules disabled — the script crashed", not the script's words (${J(await since(bob, t0))})`);
  }

  section('7. Enable evaluates the script once, under the start\'s budget (D137)');
  {
    const t0 = await mark(host);
    const res = await enable("({ name: 'Once', n: (self.__n = (self.__n || 0) + 1), x: (() => { const e = Date.now() + 4500; while (Date.now() < e); })(), setup(t) { t.say('evaluated ' + self.__n + ' time(s)'); } })");
    ok(res.ok && await rulesOn(), `a top level of 4.5 s (over a job's 4 s, under the start's 10): enabled (${J(res)})`);
    ok((await since(host, t0)).some((l) => l.includes('evaluated 1 time(s)')), `it was evaluated once (${J((await since(host, t0)).filter((l) => /evaluated/.test(l)))})`);
  }

  section('8. Saved rules meet a skewed rules-worker.js on a reload: off on that page, still on in the save (D138)');
  {
    ok((await enable("({ name: 'Keep', onChat(t, m) { if (m === 'ping') t.say('keep pong'); } })")).ok, 'a script is on');
    await sleep(1500); // (saved)
    const src = fs.readFileSync(path.join(h.APP_ROOT, 'cardtable/rules-worker.js'), 'utf8');
    const skewed = src.replace(/export const MODULE_V = \d+;/, `export const MODULE_V = ${h.MODULE_V + 98};`);
    const WORKER_URL = /\/cardtable\/rules-worker\.js(\?|$)/;
    await host.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('toast');
      window.__toasts = [];
      new MutationObserver(() => window.__toasts.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    }));
    await host.context().route(WORKER_URL, (r) => r.fulfill({ contentType: 'text/javascript', body: skewed }));
    await host.reload();
    ok(await until(host, () => window.__ct?.view().seq > 0 && window.__ct.jobs() === 0 && window.__ct.view().rules?.enabled === false, null, 20000), 'the reloaded host: the saved rules couldn\'t start, they are off');
    ok((await toasts(host)).includes('Card Table was updated — reload this page to run rules'), 'toast: "Card Table was updated — reload this page to run rules"');
    await act(host, { t: 'chat', msg: 'a move with the rules off, saved' });
    await sleep(1500);
    await host.context().unroute(WORKER_URL);
    await host.reload();
    ok(await until(host, () => window.__ct?.view().rules?.enabled === true && window.__ct.jobs() === 0 && window.__ct.perf.workerStarts === 1, null, 20000), 'the reload the toast asked for: the saved rules run again');
    await act(host, { t: 'chat', msg: 'ping' });
    ok(await until(host, () => window.__ct.log().some((l) => l.txt.includes('keep pong'))), '«Keep» answers a chat');
    await sameDigests('after the reload');
  }

  section('9. An explicit address under a newer board, then a new felt: the host keeps the Worker\'s address (D132)');
  {
    const MAP = `({ name: 'Map', setup(t) {
      const b = t.newBox({ name: 'Probe', pieces: [
        { id: 'map', kind: 'board', w: 520, faces: [{ color: '#556655' }], grid: { type: 'square', cols: 10, rows: 10, cell: 50, x: 10, y: 10, labels: 'chess' } },
        { id: 'rack', kind: 'board', w: 400, h: 120, faces: [{ color: '#333344' }], zones: [{ id: 'l', poly: [[0, 0], [400, 0], [400, 120], [0, 120]] }] },
        { id: 'man', kind: 'token', w: 40, stack: 'none', faces: [{ color: '#ffffff' }] }] });
      t.spawn(b + '/map', { at: 'center' }); t.spawn(b + '/rack', { at: 'center' });
      t.public.man = t.spawn(b + '/man', { at: 'e5' }); } })`;
    ok((await enable(MAP, { reset: true })).ok, 'a map with a rack over its middle rows, a man on e5 (an explicit address, under the rack)');
    const man = await host.evaluate(() => window.__ct.view().rules.public.man);
    ok(await host.evaluate((id) => window.__ct.view().items[id]?.at === 'e5', man), 'the man is on e5');
    const tb = await host.evaluate(() => window.__ct.view().table);
    ok((await act(host, { t: 'table', shape: tb.shape, w: tb.w, h: tb.h, felt: '#224466' })).ok, 'the host changes the felt alone');
    await sleep(300);
    ok(await host.evaluate((id) => window.__ct.view().items[id]?.at === 'e5', man) && await until(bob, (id) => window.__ct.view().items[id]?.at === 'e5', man),
      'the man is still on e5, on both screens (the host read nothing by containment)');
    await sameDigests('after the new felt');
  }

  await env.done();
})().catch(h.crash);
