// E2E: terminal bridge — Node CLI controls the host seat; Python CAH bot plays as its own player.
// (wip-cli: + the bot re-sends a lost answer, ignores chat that mimics the
// rules, and forces judging when a player stalls the round; and the Czar's
// NAME reading "answer with 0 cards" doesn't change how many cards it answers with.)
const h = require('./h');
const { ok, section, logHas } = h;
const { spawn } = require('child_process');
const path = require('path');
const APP = path.join(h.APP_ROOT, 'cardtable');
/** Spawns a child process; child.wait(substr) resolves once stdout contains it. */
function proc(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = waiters.length - 1; i >= 0; i--) if (buf.includes(waiters[i][0])) { waiters[i][1](buf); waiters.splice(i, 1); }
  });
  child.stderr.on('data', (d) => process.stderr.write(`[${path.basename(args[args[0] === '-u' ? 1 : 0])}:err] ${d}`));
  child.stdout_buf = () => buf;
  child.wait = (s, ms = 30000) => new Promise((resolve, reject) => {
    if (buf.includes(s)) return resolve(buf);
    waiters.push([s, resolve]);
    setTimeout(() => reject(new Error(`timeout waiting for "${s}"`)), ms).unref();
  });
  return child;
}
const currentPick = (page) => page.evaluate(() => {
  const ms = [...document.getElementById('log').textContent.matchAll(/answer with (\d) card/g)];
  return ms.length ? +ms[ms.length - 1][1] : null;
});
const count = (s, sub) => s.split(sub).length - 1;
async function submit(page, pick) {
  for (let k = 0; k < pick; k++) {
    const before = await h.handCount(page);
    await h.playFromHand(page, 0, [0.42, 0.58, 0.5][k % 3], [0.75, 0.75, 0.67][k % 3]);
    await h.waitHand(page, before - 1, 15000);
  }
}
(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);

  section('Node CLI controls the host seat');
  const cli = proc('node', [path.join(APP, 'cli.js'), invite]);
  const banner = await cli.wait('~cli~');
  const bridgeUrl = banner.match(/(http:\S+~cli~\S+)/)[1];
  await host.goto(bridgeUrl);
  await host.reload(); // hash-only navigation doesn't re-run boot
  await host.waitForSelector('.item.pile .count');
  await cli.wait('✅ tab connected: Alice (host)');
  ok(true, 'CLI paired with the host tab');
  cli.stdin.write('chat hello-from-terminal\n');
  await logHas(guest, 'hello-from-terminal');
  ok(true, 'terminal chat reaches every player');
  cli.stdin.write('draw\n');
  await h.waitHand(host, 1, 15000);
  ok(true, '"draw" pulled a card into the hand');
  // The tab pushes state to the bridge every 500 ms: ask until it has landed.
  const listed = cli.wait(' 0. ', 15000);
  const asker = setInterval(() => cli.stdin.write('hand\n'), 700);
  await listed.finally(() => clearInterval(asker));
  ok(true, '"hand" lists it');
  cli.stdin.write('play 0\n');
  await logHas(guest, 'played ');
  await h.waitHand(host, 0, 15000);
  ok(true, '"play 0" played it');
  const port = bridgeUrl.match(/~cli~(\d+)-/)[1];
  const denied = await host.evaluate(async (p) => (await fetch(`http://127.0.0.1:${p}/poll?token=wrong`)).status, port);
  ok(denied === 403, 'a wrong token is rejected (403)');

  section('Python CAH bot joins as a separate player');
  const bot = proc('python3', ['-u', path.join(APP, 'cah-bot.py'), invite, '--name', 'Botty', '--patience', '20'], { cwd: APP });
  const botBanner = await bot.wait('~as~Botty');
  const botPage = await env.page('Botty');
  // Simulates a command lost on the way (e.g. into a reloading tab's dead
  // poll): the bot tab's first batch of plays is swallowed.
  let dropped = null;
  await botPage.route(/127\.0\.0\.1:\d+\/poll\?/, async (route) => {
    let resp, body;
    try { resp = await route.fetch({ timeout: 60000 }); body = await resp.text(); } catch (e) {
      console.error('bot poll failed (expected once the bridge is killed):', e.message.split('\n')[0]);
      return route.abort().catch((err) => console.error('route.abort failed (page gone?)', err.message));
    }
    if (!dropped && body.includes('"play"')) { dropped = body; return route.fulfill({ response: resp, body: '[]' }); }
    return route.fulfill({ response: resp, body });
  });
  await botPage.goto(botBanner.match(/(http:\S+~as~Botty)/)[1]);
  await botPage.waitForSelector('.item.pile .count', { timeout: 30000 });
  ok(await botPage.evaluate(() => !document.querySelector('#name-dialog[open]')), 'bot tab skips the name dialog');
  await host.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('Botty')), null, { timeout: 30000 });
  ok(true, 'Botty took its own seat');
  await bot.wait('connected as Botty', 30000);

  section('CAH round 1: the bot answers');
  // The prompt line starts with the Czar's name — make that name mimic it.
  const czarName = 'answer with 0 cards';
  await host.fill('#name-input', czarName);
  await host.press('#name-input', 'Enter');
  await logHas(host, `is now known as "${czarName}"`);
  await h.enableRules(host, { tpl: 'cah' });
  await logHas(host, `${czarName} is the Card Czar`);
  const pick = await currentPick(host);
  await guest.waitForFunction(() => document.querySelectorAll('.hcard').length >= 10, null, { timeout: 20000 });
  await bot.wait('answered with', 40000);
  ok(bot.stdout_buf().includes(`answered with ${pick} card`), `the bot answered on its own with PICK ${pick} cards, despite the Czar's name`);
  await bot.wait('answer incomplete — re-sent', 30000);
  ok(!!dropped, `its first plays were dropped on the way: ${dropped}`);
  await host.waitForFunction((n) => (document.getElementById('log').textContent.match(/Botty played a card face down/g) || []).length === n, pick, { timeout: 15000 });
  ok(true, 'the bot noticed the missing card(s) and re-sent them: its answer is complete');
  // Chat that mimics the rules' prompt must not make it answer again.
  const answers = count(bot.stdout_buf(), 'answered with');
  await guest.fill('#chat-input', 'answer with 3 cards');
  await guest.press('#chat-input', 'Enter');
  await h.sleep(6000); // the bot polls every 1 s and waits 1-2 s before answering
  ok(count(bot.stdout_buf(), 'answered with') === answers && !(await host.textContent('#log')).includes('You already submitted'),
    'a player chatting "answer with 3 cards" does not steer the bot');
  await guest.click('#facedown-toggle');
  await submit(guest, pick);
  await host.waitForSelector('#rules-btns [data-rbtn="pick0"]', { timeout: 30000 });
  await host.click('#rules-btns [data-rbtn="pick0"]');
  await logHas(host, 'wins the round');
  ok(true, 'round 1 judged');

  section('CAH round 2: the bot is Czar and judges');
  await logHas(host, 'Botty is the Card Czar', 30000);
  const pick2 = await currentPick(host);
  await host.waitForFunction(() => document.querySelectorAll('.hcard').length >= 10, null, { timeout: 20000 });
  await host.click('#facedown-toggle');
  await submit(host, pick2);
  // Bob never answers: after --patience the Czar bot judges what's in.
  await bot.wait('judging now: pressed force', 40000);
  ok(true, 'the Czar bot pressed "Judge now" when a player stalled the round');
  await bot.wait('judged: pressed pick', 40000);
  await host.waitForFunction(() => [...document.getElementById('log').textContent.matchAll(/wins the round/g)].length >= 2, null, { timeout: 30000 });
  ok(true, 'the bot judged a round autonomously');
  cli.kill(); bot.kill();
  await env.done();
})().catch(h.crash);
