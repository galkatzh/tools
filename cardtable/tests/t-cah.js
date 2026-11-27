// E2E: the Cards Against Humanity template — full rounds with 3 players (+ an
// offline 4th seat): online Czar, locked face-down answers into an Answers
// pile, anonymous numbered reveal upright for the Czar, labelled 👉 buttons,
// a visible round result, Skip Czar after a host reload, newcomer notices.
// (wip-tabletop overlay of t-cah.js: face-up answers can no longer be made
// from the UI — the 🂠 toggle is locked on for the answering players.)
const h = require('./h');
const { ok, section, logHas, toastHas } = h;
// (final overlay, INT-1: ⏳ marks whoever the round waits on — the answerers,
// then the Czar — so the Czar is found by the 👑 badge)
const czarName = (page) => page.evaluate(() => {
  for (const s of document.querySelectorAll('.seat')) { const m = s.textContent.match(/(\S+) 🂠\d+ ⭐\d+ 👑/); if (m) return m[1]; }
  return null;
});
const currentPick = (page) => page.evaluate(() => {
  const ms = [...document.getElementById('log').textContent.matchAll(/answer with (\d) card/g)];
  return ms.length ? +ms[ms.length - 1][1] : null;
});
/** Drops the first hand card near the player's own rim (spots never collide). */
async function playCard(page, k) {
  await h.playFromHand(page, 0, [0.42, 0.58, 0.5][k % 3], [0.75, 0.75, 0.67][k % 3]);
}
async function submit(page, pick) {
  for (let k = 0; k < pick; k++) {
    const before = await h.handCount(page);
    await playCard(page, k);
    await h.waitHand(page, before - 1);
  }
}
async function join(env, host, name, seats) {
  const p = await env.page(name);
  await p.goto(host.url());
  await h.joinAs(p, name);
  await p.waitForSelector('.item.pile .count', { timeout: 30000 });
  await host.waitForFunction((k) => document.querySelectorAll('.seat').length === k, seats, { timeout: 30000 });
  return p;
}
/** The reveal as the Czar's screen shows it: markers (#k / 🏆) and answers, with screen geometry. */
const reveal = (page) => page.evaluate(() => [...document.querySelectorAll('.item:not(.pile)')].map((el) => {
  const r = el.getBoundingClientRect(), face = el.querySelector('.face.txt');
  const bg = face?.getAttribute('style') || '';
  return {
    id: el.dataset.id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, upright: r.height > r.width,
    rot: el.style.transform, mark: el.querySelector('.tn')?.textContent || '', text: el.querySelector('.tt')?.textContent || '',
    kind: bg.includes('#fde047') || bg.includes('#22c55e') ? 'marker' : bg.includes('#0a0a0a') ? 'black' : face ? 'answer' : 'back',
  };
}));
const banner = (page) => page.evaluate(() => {
  const el = document.getElementById('announce');
  return el.classList.contains('hidden') ? '' : el.textContent;
});
/** Piles that overlap any other table item on this screen: the draw piles must
 *  stay clear of the center deck, the prompt and the columns, wherever the Czar sits. */
const pileClashes = (page) => page.evaluate(() => {
  const its = [...document.querySelectorAll('.item')].map((el) => ({ el, r: el.getBoundingClientRect(), name: el.querySelector('.pname')?.textContent }));
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  return its.filter((a) => a.name).flatMap((a) => its.filter((b) => b !== a && hit(a.r, b.r))
    .map((b) => a.name + ' × ' + (b.name || b.el.textContent.trim().slice(0, 20))));
});
const btnLabels = (page) => page.$$eval('#rules-btns button', (bs) => bs.map((b) => b.dataset.rbtn + '=' + b.textContent));

(async () => {
  const env = await h.start();
  const pages = {};
  const { host, guest } = await h.hostAndGuest(env);
  pages.Alice = host; pages.Bob = guest;
  pages.Carol = await join(env, host, 'Carol', 3);
  // Dave takes the 0° seat (first in seat order), then leaves for good.
  const dave = await join(env, host, 'Dave', 4);
  await dave.context().close();
  await host.waitForFunction(() => [...document.querySelectorAll('.seat.offline')].some((s) => s.textContent.includes('Dave')), null, { timeout: 20000 });

  section('enable CAH');
  await h.enableRules(host, { tpl: 'cah' });
  await host.waitForFunction(() => !document.querySelector('#rules-dialog[open]'));
  await logHas(host, 'defined deck "CAH White"');
  await logHas(host, 'defined deck "CAH Black"');
  ok(true, 'both CAH decks defined');
  let pick = null;
  for (const [name, p] of Object.entries(pages)) {
    await logHas(p, 'is the Card Czar');
    pick = await currentPick(p);
    await h.waitHand(p, 10 + (pick === 3 && name !== 'Alice' ? 2 : 0));
  }
  ok(true, `everyone online dealt 10 white cards (PICK ${pick})`);
  ok((await czarName(pages.Carol)) === 'Alice', 'Alice is the first Card Czar — not Dave, whose first seat is offline (GAME-10)');

  section('submission rules');
  await host.click('#facedown-toggle');
  await playCard(host, 0);
  await toastHas(host, 'Czar does not answer');
  ok((await h.handCount(host)) === 10, 'the Czar cannot answer');
  await host.click('#facedown-toggle');
  const locked = (p) => p.$eval('#facedown-toggle', (b) => b.classList.contains('locked') && b.classList.contains('on'));
  ok(await locked(guest) && await locked(pages.Carol) && !(await locked(host)), "the answerers' 🂠 toggle is locked on, the Czar's is not");
  await guest.click('#facedown-toggle');
  await toastHas(guest, 'require face-down plays');
  ok(await locked(guest), 'a locked toggle cannot be switched off');

  section('answers go into a face-down Answers pile (GAME-11)');
  // every loose face-down card the Czar's screen ever shows (a submission left where it was dropped)
  await host.evaluate(() => {
    window.__seen = new Set();
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.item:not(.pile)')) if (el.querySelector('.back')) window.__seen.add(el.dataset.id);
    }).observe(document.getElementById('table'), { childList: true, subtree: true });
  });
  await submit(guest, pick);
  await logHas(host, 'answers in: 1/2');
  const ans = await host.waitForFunction((n) => {
    const p = [...document.querySelectorAll('.item.pile')].find((el) => el.querySelector('.pname')?.textContent === 'Answers');
    return p && p.querySelector('.count')?.textContent === String(n) && !!p.querySelector('.back');
  }, pick, { timeout: 10000 }).then(() => true, () => false);
  ok(ans, `Bob's answer sits face down in the "Answers" pile (${pick})`);
  ok((await reveal(host)).filter((c) => c.kind === 'back').length === 0, 'no loose face-down answer marks where Bob dropped it');

  section('reveal: numbered, anonymous, upright for the Czar (GAME-11, UX-3, UX-9)');
  await submit(pages.Carol, pick);
  await logHas(guest, 'judges — press 👉');
  await host.waitForSelector('#rules-btns [data-rbtn="pick1"]', { timeout: 10000 });
  ok(true, 'the Czar sees 👉 buttons');
  ok(await guest.locator('#rules-btns [data-rbtn="pick0"]').count() === 0, 'non-Czars see no pick buttons');
  await host.waitForFunction(() => ![...document.querySelectorAll('.pname')].some((el) => el.textContent === 'Answers'));
  const cards = await reveal(host), seen = await host.evaluate(() => [...window.__seen]);
  const markers = cards.filter((c) => c.kind === 'marker').sort((a, b) => a.cx - b.cx);
  const answers = cards.filter((c) => c.kind === 'answer');
  ok(markers.map((m) => m.mark).join() === '#1,#2', `columns #1, #2 run left to right on the Czar's screen (${markers.map((m) => m.mark)})`);
  ok(answers.length === 2 * pick && answers.every((c) => !seen.includes(c.id)), 'the revealed answers are new table items (no id links them to their players)');
  ok([...markers, ...answers].every((c) => c.upright && c.rot === answers[0].rot), `all columns are upright for the Czar (${answers.map((c) => c.rot)})`);
  const col = (k) => answers.filter((c) => Math.abs(c.cx - markers[k].cx) < 20 && c.cy > markers[k].cy).sort((a, b) => a.cy - b.cy);
  ok(col(0).length === pick && col(1).length === pick, 'each column holds one player\'s answer under its number');
  const clash0 = await pileClashes(host);
  ok(!clash0.length, `the draw piles overlap neither the center deck, the prompt nor the columns (${clash0.join('; ')})`);
  const labels = await btnLabels(host);
  const want = (k) => ('👉 ' + (k + 1) + ': ' + col(k).map((c) => c.text).join(' / '));
  ok([0, 1].every((k) => { const l = labels[k].split('=')[1]; return l.replace(/…$/, '') === want(k).slice(0, l.replace(/…$/, '').length) && l.length >= 8; }),
    `the 👉 buttons name their column's answer (${labels.join(' | ')})`);

  section('the round result stays up (GAME-12, UX-7)');
  await host.click('#rules-btns [data-rbtn="pick0"]');
  await logHas(host, 'wins the round with #1: "' + col(0)[0].text.slice(0, 20));
  ok(true, 'the log names the winner and the winning answer');
  await h.sleep(2500); // the result must still be up a moment later — no same-tick overwrite
  const b = await banner(guest);
  ok(b.includes('wins the round with #1'), `the winner banner is still showing 2.5 s later ("${b.slice(0, 50)}…")`);
  const after = await reveal(guest);
  ok(after.some((c) => c.mark === '🏆 Winner') && after.filter((c) => c.kind === 'answer').length === 2 * pick, 'the judged columns stay on the table, 🏆 over the winning one');
  await guest.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('⭐1')), null, { timeout: 10000 });
  ok(true, 'winner scored ⭐1');
  await logHas(pages.Carol, 'Carol is the Card Czar', 15000);
  await guest.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => /Carol 🂠\d+ ⭐\d+ 👑/.test(s.textContent)), null, { timeout: 10000 });
  ok(true, 'Czar rotated (past the offline Dave)');
  ok((await reveal(host)).filter((c) => c.kind === 'answer' || c.kind === 'marker').length === 0, 'the next round clears the table');

  section('goal 1 → game over → new game');
  const pick2 = await currentPick(host);
  for (const [name, p] of Object.entries(pages)) await h.waitHand(p, 10 + (pick2 === 3 && name !== 'Carol' ? 2 : 0));
  await host.fill('#chat-input', '!goal 1');
  await host.press('#chat-input', 'Enter');
  await logHas(host, 'the goal is now ⭐1');
  await submit(host, pick2);
  await submit(guest, pick2);
  await logHas(pages.Carol, 'judges — press 👉');
  const crot = (await reveal(pages.Carol)).filter((c) => c.kind === 'answer');
  ok(crot.every((c) => c.upright && c.rot === 'rotate(90deg)'), `Carol (seat 180°) gets her columns at 90°, upright on her screen (${crot.map((c) => c.rot)})`);
  const clash = await pileClashes(pages.Carol);
  ok(!clash.length, `with Carol (180°) as Czar the draw piles overlap nothing (${clash.join('; ')})`);
  await pages.Carol.click('#rules-btns [data-rbtn="pick1"]');
  await logHas(host, 'wins the game with ⭐');
  await guest.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('🏆')), null, { timeout: 10000 });
  ok(true, 'reaching the goal wins: 🏆');
  await host.click('#rules-btns [data-rbtn="newgame"]');
  await logHas(host, 'Bob is the Card Czar', 15000);
  ok(await host.evaluate(() => [...document.querySelectorAll('.seat')].every((s) => s.textContent.includes('⭐0'))), 'scores reset');

  section('a Czar who is away can be skipped (GAME-10); reconnects are not newcomers (ENG-13)');
  // Bob is Czar. The host goes away, Bob leaves meanwhile (so no onLeave),
  // and the host resumes: the round is stuck on an absent Czar.
  const url = host.url();
  await host.goto('about:blank');
  await guest.context().close();
  await pages.Carol.evaluate(() => { document.getElementById('toast').textContent = ''; });
  await host.goto(url);
  await pages.Carol.waitForSelector('#rules-btns [data-rbtn="skipczar"]', { timeout: 40000 });
  ok(await host.locator('#rules-btns [data-rbtn="skipczar"]').count() === 1, 'everyone sees "⏭ Skip Czar" while the Czar is away');
  ok(!(await pages.Carol.textContent('#toast')).includes('You deal in next round'), 'Carol, reconnecting mid-round, is not told to wait for the next round');
  await pages.Carol.click('#rules-btns [data-rbtn="skipczar"]');
  await logHas(host, 'The Card Czar is away — new prompt — Alice is the Card Czar');
  await pages.Carol.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => /Alice 🂠\d+ ⭐\d+ 👑/.test(s.textContent)), null, { timeout: 10000 });
  ok(true, 'Skip Czar starts a new round with the next online Czar');
  const erin = await env.page('Erin');
  await erin.goto(url);
  await h.joinAs(erin, 'Erin');
  await toastHas(erin, 'You deal in next round', 20000);
  ok(true, 'a newcomer mid-round is told to wait for the next round');
  await env.done();
})().catch(h.crash);
