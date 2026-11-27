// E2E: rules engine — turn order, Hold'em with chips, novel scripts, broken scripts.
const h = require('./h');
const { ok, section, logHas, toastHas } = h;
(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);

  section('Turn order template');
  await h.enableRules(host, { tpl: 'turns' });
  await host.waitForFunction(() => !document.querySelector('#rules-dialog[open]'));
  await logHas(host, '«Turn order» enabled');
  ok(true, 'log records the rules being enabled');
  await guest.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('⏳ Alice')), null, { timeout: 10000 });
  ok(true, "guest sees ⏳ on Alice's seat");

  section('out-of-turn guest is blocked');
  await guest.dblclick('.item.pile');
  await toastHas(guest, 'not your turn');
  ok((await guest.locator('.hcard').count()) === 0, "Bob's hand stayed empty");
  await logHas(host, 'blocked Bob');
  ok(true, 'the block is on the record');

  section('in-turn host plays; the turn advances');
  await host.dblclick('.item.pile');
  await host.waitForSelector('.hcard');
  await h.playFromHand(host, 0, 0.6, 0.6);
  await guest.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('⏳ Bob')), null, { timeout: 10000 });
  ok(true, 'after Alice plays, ⏳ moves to Bob');
  await guest.dblclick('.item.pile');
  await guest.waitForSelector('.hcard', { timeout: 10000 });
  ok(true, 'Bob can draw on his turn');

  section('guest can read (not edit) the enforced script');
  await guest.click('#rules-btn');
  await guest.waitForSelector('#rules-dialog[open]');
  ok((await guest.inputValue('#rules-code')).includes('Turn order'), 'guest sees the script code');
  ok(await guest.evaluate(() => document.getElementById('rules-code').readOnly), 'guest editor is read-only');
  ok(await guest.locator('#rules-enable').isHidden(), 'guest has no Enable button');
  await guest.click('#rules-dialog button[value="cancel"]');

  section("Hold'em (chips): stacks, blinds, betting");
  await h.enableRules(host, { tpl: 'holdem' });
  await host.waitForFunction(() => !document.querySelector('#rules-dialog[open]'));
  await guest.waitForFunction(() => [...document.querySelectorAll('.seat')].every((s) => s.textContent.includes('💰1000')), null, { timeout: 10000 });
  ok(true, 'everyone starts with 💰1000');
  await host.click('#rules-btns [data-rbtn="new"]');
  await h.waitHand(host, 2); await h.waitHand(guest, 2);
  ok(true, 'both players dealt 2 hole cards');
  await guest.waitForFunction(() => {
    const t = [...document.querySelectorAll('.seat')].map((s) => s.textContent).join('|');
    return t.includes('💰995') && t.includes('💰990');
  }, null, { timeout: 10000 });
  ok(true, 'blinds posted automatically (995/990)');

  section('betting: min-raise, call/check close the round, flop deals itself');
  await host.fill('#chat-input', '!bet 12');
  await host.press('#chat-input', 'Enter');
  await toastHas(host, 'Min raise');
  ok(true, 'undersized raise rejected privately');
  await host.waitForSelector('#rules-btns [data-rbtn="call"]');
  await host.click('#rules-btns [data-rbtn="call"]');
  await guest.waitForSelector('#rules-btns [data-rbtn="check"]', { timeout: 10000 });
  await guest.fill('#chat-input', '!check');
  await guest.press('#chat-input', 'Enter');
  await host.waitForFunction(() => [...document.querySelectorAll('.item:not(.pile)')].filter((el) => el.querySelector('.std')).length === 3, null, { timeout: 10000 });
  await logHas(host, 'Flop — pot 20');
  ok(true, 'round closed — the flop dealt itself (pot 20)');

  section('rules survive a host reload (mid-hand)');
  await h.sleep(1300);
  await host.reload();
  await host.waitForSelector('.item.pile .count');
  await host.waitForFunction(() => [...document.querySelectorAll('.seat')].filter((s) => s.textContent.includes('💰990')).length === 2, null, { timeout: 10000 });
  ok(true, 'stacks survived the reload (990/990)');

  section('check it down to an automatic showdown');
  for (const street of ['Turn — pot 20', 'River — pot 20', null]) {
    await guest.waitForSelector('#rules-btns [data-rbtn="check"]', { timeout: 10000 });
    await guest.click('#rules-btns [data-rbtn="check"]');
    await host.waitForSelector('#rules-btns [data-rbtn="check"]', { timeout: 10000 });
    await host.click('#rules-btns [data-rbtn="check"]');
    if (street) await logHas(host, street);
  }
  await host.waitForFunction(() => {
    const el = document.getElementById('announce');
    return !el.classList.contains('hidden') && /wins|split/.test(el.textContent);
  }, null, { timeout: 10000 });
  ok(true, 'showdown ran automatically and announced the result');
  await guest.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('🏆')), null, { timeout: 10000 });
  ok(true, '🏆 lands on the winning seat');
  await guest.waitForFunction(() => [...document.querySelectorAll('.item:not(.pile)')].filter((el) => el.querySelector('.std')).length === 9, null, { timeout: 10000 });
  ok(true, 'hole cards revealed (5 community + 4 hole)');
  const sum = await host.evaluate(() => [...document.querySelectorAll('.seat')].map((s) => +(s.textContent.match(/💰(\d+)/)?.[1] || 0)).reduce((a, b) => a + b, 0));
  ok(sum === 2000, `chips conserved — stacks sum to 2000 (${sum})`);

  section('fold hands over the pot');
  await host.click('#rules-btns [data-rbtn="new"]');
  await h.waitHand(guest, 2);
  await guest.waitForSelector('#rules-btns [data-rbtn="fold"]', { timeout: 10000 });
  await guest.click('#rules-btns [data-rbtn="fold"]');
  await guest.waitForFunction(() => {
    const el = document.getElementById('announce');
    return !el.classList.contains('hidden') && el.textContent.includes('everyone else folded');
  }, null, { timeout: 10000 });
  ok(true, 'folding to one player awards the pot uncontested');

  section('arbitrary novel script: onJoin auto-deal + timer');
  await h.enableRules(host, { code: `({
    name: 'Custom test',
    setup(t) { t.schedule(2, 'boom'); },
    onJoin(t, p) { const d = t.piles()[0]; if (d) t.draw(p, d.id, 3); },
    onTimer(t, tag) { if (tag === 'boom') t.say('timer fired: ' + tag); },
  })` });
  await logHas(host, '«Custom test» enabled');
  await logHas(host, 'timer fired: boom', 8000);
  ok(true, 't.schedule fired onTimer');
  const carol = await env.page('Carol');
  await carol.goto(host.url());
  await h.joinAs(carol, 'Carol');
  await carol.waitForFunction(() => document.querySelectorAll('.hcard').length === 3, null, { timeout: 20000 });
  ok(true, 'onJoin auto-dealt 3 cards to the joining player');
  await logHas(host, 'to Carol');
  ok(true, 'the auto-deal is logged as 📜 Rules');

  section('broken script fails loudly and safely');
  await host.click('#rules-btn');
  await host.fill('#rules-code', '({ this is not javascript');
  await host.click('#rules-enable');
  await host.waitForFunction(() => document.getElementById('rules-err').textContent.length > 0);
  ok(true, 'syntax error surfaces in the dialog');
  ok(await host.evaluate(() => document.querySelector('#rules-dialog[open]') !== null), 'dialog stays open on error');
  await host.click('#rules-dialog button[value="cancel"]');
  // ENG-6: a broken edit must not kill the game in progress.
  ok(await host.locator('#rules-btn').evaluate((el) => el.classList.contains('on')), 'the running rules are untouched by the failed enable');
  const before = await host.locator('.hcard').count();
  await host.dblclick('.item.pile');
  await host.waitForFunction((n) => document.querySelectorAll('.hcard').length === n + 1, before, { timeout: 10000 });
  ok(true, 'the table still works');
  await env.done();
})().catch(h.crash);
