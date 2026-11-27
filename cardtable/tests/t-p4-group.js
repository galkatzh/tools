// Phase 4B part 1, in real tabs (spec §4c, §3c, §4 Hexfront): the group
// engine through window.__ct.act — Hexfront set up from 📦's Built-in
// section (its turn script starting at once, no trust dialog: built in), two
// players playing it through __ct.act and the page's own controls (the phase
// buttons, a double-click draw); a group move, a group whose members the
// rules veto or the engine skips, a group roll, all in the host's rules
// Worker, the host's and the Worker's digests agreeing; a group drag relayed
// as one `drag {ids, dx, dy}`, the dragger's name riding the first member on
// the other screen, the drop's group ending the glide; and with the rules
// off, a group on the host's own table. The UI of multi-select, the group
// bar and the stack inspector is part 2's (t-p4-select).
'use strict';
const h = require('./h');
const { ok, section } = h;
const { until, view, act } = require('./p1-lib');

const J = JSON.stringify;
/** Page p's notices since `from` (its #toast's texts, as they came). */
async function toasts(p) {
  await p.evaluate(() => {
    if (window.__toasts) return;
    window.__toasts = [];
    new MutationObserver(() => { const t = document.getElementById('toast').textContent; if (t && window.__toasts.at(-1) !== t) window.__toasts.push(t); })
      .observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true });
  });
}
const said = (p, re) => until(() => p.evaluate((src) => (window.__toasts || []).some((t) => new RegExp(src, 'u').test(t)), re.source), 10000, 100);

(async () => {
  const env = await h.start();
  const { host: alice, guest: bob } = await h.hostAndGuest(env);
  for (const p of [alice, bob]) await toasts(p);

  section('Hexfront from 📦\'s Built-in section: set up, its turn script running at once (built in: no trust dialog)');
  alice.on('dialog', (d) => d.accept()); // (the table has the standard deck: pickCleared asks before clearing it)
  await alice.click('#box-btn');
  await alice.waitForSelector('#box-dialog[open]');
  const row = await alice.evaluate(() => { const b = document.querySelector('#box-builtins [data-builtin="hexfront"]'); return b && b.closest('.box-row').textContent.replace(/\s+/g, ' ').trim(); });
  ok(/Hexfront/.test(row) && /hex-map wargame skeleton/.test(row), `the Built-in section lists Hexfront, with its pitch ("${row}")`);
  await alice.click('#box-builtins [data-builtin="hexfront"]');
  ok(await until(async () => { const v = await view(bob); return Object.keys(v.items).length === 44 && v.rules?.enabled && v.rules.name === 'Hexfront'; }, 20000),
    'both screens: 44 items, the rules «Hexfront» on');
  ok(!(await alice.$('#box-ask[open]')) && !(await alice.$('#box-dialog[open]')), 'no trust dialog (a built-in box), and the 📦 dialog closed');
  const st = await alice.evaluate(() => window.__ct.hostState());
  ok(st.rules.box === st.lastSetup && st.boxes[st.lastSetup].name === 'Hexfront', 'the rules running are the box\'s own (rules.box): Reset restarts them');
  const v0 = await view(bob), items = Object.entries(v0.items);
  const counters = items.reduce((n, [, it]) => n + (it.k === 'g' ? it.n || 0 : 0), 0), stacks = items.filter(([, it]) => it.k === 'g' && it.n === 10).length;
  ok(counters === 400 && stacks === 40, `a guest sees 400 counters in 40 stacks (${counters}, ${stacks})`);
  const pidOf = (name) => Object.keys(v0.players).find((q) => v0.players[q].name === name), A = pidOf('Alice'), B = pidOf('Bob');
  const side = { [v0.players[A].seatId]: alice, [v0.players[B].seatId]: bob }, az = side.azure, em = side.ember;
  ok(az && em && az !== em, `Alice and Bob sit as Azure and Ember (${v0.players[A].seatId}, ${v0.players[B].seatId})`);
  ok(await until(async () => (await view(em)).rules.public?.turn === (az === alice ? A : B), 10000), "the turn cue: Azure's");
  await alice.screenshot({ path: `${__dirname}/shots/p4-hexfront-desktop.png` });
  const mine = (sd) => items.filter(([, it]) => it.owner === `seat:${sd}`).map(([id]) => id), AZ = mine('azure'), EM = mine('ember');
  const dice = items.filter(([, it]) => it.k === 'g' && /\/d6$/.test(it.t)).map(([id]) => id), events = items.find(([, it]) => it.name === 'Events')[0];
  const dy = 1.5 * (100 / Math.sqrt(3)), it = async (p, id) => (await view(p)).items[id];

  section('the turn script in two tabs: only the side to play moves its units; a group move; the phase buttons; dice; an event card');
  await act(em, { t: 'move', id: EM[0], x: v0.items[EM[0]].x, y: v0.items[EM[0]].y + dy });
  ok(await said(em, /🚫 It's Azure's turn/), "Ember's move out of turn: refused, said on Ember's screen");
  await act(az, { t: 'group', op: 'move', ids: AZ.slice(0, 5), dx: 0, dy: -dy });
  ok(await until(async () => { const v = await view(em); return AZ.slice(0, 5).every((id) => v.items[id].at !== v0.items[id].at && v.items[id].at); }, 10000),
    'Azure moves five stacks a row up as one group: every one on a new hex, on the other screen too');
  ok(await until(async () => (await view(em)).log.some((e) => e.txt === 'moved 5 items'), 10000), 'one line in the log: "moved 5 items"');
  ok(await until(async () => (await az.evaluate(() => window.__ct.digest())) === (await az.evaluate(() => window.__ct.workerDigest())), 10000), "the host's table and its rules Worker agree (digest)");
  await act(em, { t: 'group', op: 'move', ids: EM.slice(0, 3), dx: 0, dy });
  ok(await said(em, /🚫 3 of 3 were skipped: It's Azure's turn/), "Ember's group out of turn: one notice for the three");
  await act(az, { t: 'split', id: AZ[6], n: 4, x: v0.items[AZ[6]].x + 100, y: v0.items[AZ[6]].y });
  ok(await until(async () => (await it(em, AZ[6]))?.n === 6, 10000), 'a stack split: four off, six stay');
  await az.click('#rules-btns button[data-rbtn="combat"]');
  ok(await until(async () => (await view(em)).rules.public?.badges?.[az === alice ? A : B] === '⚔ Combat', 10000), '⚔ To combat (the page\'s own button): the phase moves on, on both screens');
  await act(az, { t: 'group', op: 'roll', ids: [...dice, AZ[0]] });
  ok(await until(async () => (await view(em)).log.some((e) => /^rolled 2 dice: \d · \d$/.test(e.txt)), 10000), 'a group with the two dice and a stack: one roll of the dice (the stack is no die)');
  await az.dblclick(`.item[data-id="${events}"]`);
  ok(await until(async () => (await az.evaluate(() => window.__ct.hand().length)) === 1, 10000), 'a double-click on the Events pile: an event card into the hand');
  ok(await until(async () => (await az.locator('#hand .hcard').count()) === 1, 5000) && /\S/.test(await az.locator('#hand .hcard').first().textContent()), 'drawn in the hand bar, its text showing');
  await az.dblclick(`.item[data-id="${events}"]`);
  ok(await said(az, /🚫 One event a turn/), 'a second draw: "One event a turn"');
  await az.click('#rules-btns button[data-rbtn="end"]');
  ok(await until(async () => (await view(az)).rules.public?.turn === (em === alice ? A : B), 10000), '⏭ End turn: the turn cue is Ember\'s');

  section('a group in the Worker: members the engine skips (another side\'s), the rest moved; the digests agree');
  await act(em, { t: 'group', op: 'move', ids: [EM[1], EM[2], AZ[8]], dx: 0, dy });
  ok(await said(em, /^1 of 3 was skipped: That belongs to Azure$/), 'one notice: Azure\'s stack skipped (the engine\'s owner check)');
  ok(await until(async () => { const v = await view(az); return v.items[EM[1]].at !== v0.items[EM[1]].at && v.items[AZ[8]].at === v0.items[AZ[8]].at; }, 10000), "Ember's two moved; Azure's stayed");
  ok(await until(async () => (await alice.evaluate(() => window.__ct.digest())) === (await alice.evaluate(() => window.__ct.workerDigest())), 10000), 'the digests agree');

  section('a group drag: one `drag {ids, dx, dy}`, relayed; the dragger\'s name on the first member; the drop ends the glide');
  const g = [EM[3], EM[4], EM[5]], other = em === bob ? alice : bob, emName = em === bob ? 'Bob' : 'Alice';
  const base = await view(other);
  await act(em, { t: 'drag', ids: g, dx: 40, dy: 30 });
  ok(await until(async () => { const L = await other.evaluate(() => window.__ct.lives()); return g.every((id) => L[id] && Math.abs(L[id].x - (base.items[id].x + 40)) < 0.01 && Math.abs(L[id].y - (base.items[id].y + 30)) < 0.01); }, 10000),
    'the other screen shows the three members gliding by (40, 30)');
  ok(await until(() => other.evaluate((n) => [...document.querySelectorAll('.fx-bulb')].some((b) => b.textContent === n && !b.classList.contains('fade')), emName), 5000), `${emName}'s name rides the group`);
  await act(em, { t: 'group', op: 'move', ids: g, dx: 0, dy });
  ok(await until(async () => { const L = await other.evaluate(() => window.__ct.lives()); const v = await view(other); return g.every((id) => !L[id] && v.items[id].at !== base.items[id].at); }, 10000),
    'the drop: one group move, committed; no glide left on the other screen');

  section('the rules off: a group on the host\'s own table (no Worker)');
  await act(alice, { t: 'setRules', enabled: false });
  ok(await until(async () => !(await view(bob)).rules?.enabled, 10000), 'the rules switched off');
  await act(bob, { t: 'group', op: 'flip', ids: [AZ[0], EM[0], EM[1]] });
  const flipped = em === bob ? [EM[0], EM[1]] : [AZ[0]];
  ok(await until(async () => { const v = await view(alice); return flipped.every((id) => v.items[id].f === 1); }, 10000), 'Bob flips his own stacks (one group)');
  ok(await said(bob, /^1 of 3 was skipped: That belongs to /) || await said(bob, /^2 of 3 were skipped: That belongs to /), "the other side's skipped, said once");
  ok(await until(async () => (await alice.evaluate(() => window.__ct.jobs())) === 0, 5000) && await alice.evaluate(() => window.__ct.workerDigest()) === null, 'no Worker runs: the host\'s own table took it');
  await env.done();
})().catch(h.crash);
