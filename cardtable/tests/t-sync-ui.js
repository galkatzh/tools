// E2E (sync cluster): what each screen shows while state flows.
//   NET-7   a guest's drag lands where the pointer was released (not the last throttled spot)
//   NET-12  a host drag the rules veto snaps back for everyone
//   NET-11  a rename the host never received syncs on the next contact
//   NET-3   hand cards render once deck data arrives after the state
//   NET-9   guests see that the host left (hint + greyed seat), and its return
const h = require('./h');
const { ok, section, logHas } = h;
const PILE = '.item.pile';
const left = (p, sel = PILE) => p.$eval(sel, (el) => [el.style.left, el.style.top].join());

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);

  section('NET-7: a guest drag lands under the pointer');
  const b = await guest.locator(PILE).boundingBox();
  const sx = b.x + b.width / 2, sy = b.y + b.height / 2;
  await guest.mouse.move(sx, sy);
  await guest.mouse.down();
  await guest.mouse.move(sx + 10, sy, { steps: 1 });  // past the threshold: a live move goes out
  await guest.mouse.move(sx + 150, sy, { steps: 2 }); // within 60 ms: not sent yet
  await h.sleep(400);                                  // hold still; the echo of the first move arrives
  const mid = await guest.locator(PILE).boundingBox();
  await guest.mouse.up();
  await h.sleep(1500);
  const end = await guest.locator(PILE).boundingBox();
  ok(Math.abs(end.x - mid.x) < 2, `the pile stays where it was released (under pointer ${mid.x | 0}, after release ${end.x | 0})`);
  const g = await left(guest);
  await host.waitForFunction(({ s, v }) => { const e = document.querySelector(s); return [e.style.left, e.style.top].join() === v; }, { s: PILE, v: g }, { timeout: 10000 })
    .then(() => ok(true, 'and the host has it at the same spot'), () => ok(false, 'and the host has it at the same spot'));

  section('NET-12: a vetoed host drag snaps back');
  await h.enableRules(host, { code: "({ name: 'No moving', validate(t, a) { if (a.t === 'move') return 'no moving'; } })" });
  await logHas(host, '«No moving» enabled');
  const before = await left(host);
  const hb = await host.locator(PILE).boundingBox();
  await host.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await host.mouse.down();
  await host.mouse.move(hb.x + hb.width / 2 + 160, hb.y + hb.height / 2 + 60, { steps: 10 });
  await host.mouse.up();
  await h.toastHas(host, 'no moving');
  await h.sleep(1000);
  ok((await left(host)) === before, `the host's pile is back where it was (${before})`);
  ok((await left(guest)) === before, 'and the guest never sees it moved');
  await host.click('#rules-btn');
  await host.click('#rules-disable');
  await host.click('#rules-dialog button[value="cancel"]');

  section('NET-11: a rename the host missed syncs on the next contact');
  await guest.evaluate(() => localStorage.setItem('ct-name', 'Robert')); // e.g. renamed in another room
  await guest.reload();
  await guest.waitForSelector(`${PILE} .count`, { timeout: 30000 });
  ok(await guest.$eval('#name-input', (el) => el.value) === 'Robert', "the guest's toolbar says Robert");
  await logHas(host, 'Bob is now known as "Robert"', 15000).then(() => ok(true, 'the host applies (and logs) the rename'), () => ok(false, 'the host applies (and logs) the rename'));
  await host.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.startsWith('Robert')), null, { timeout: 10000 })
    .then(() => ok(true, 'the seat label follows'), () => ok(false, 'the seat label follows'));
  await h.sleep(5200); // a fresh flood-control window
  const floods = [];
  host.on('console', (m) => { if (m.text().startsWith('flood control: dropped a name')) floods.push(m.text()); });
  await guest.evaluate(() => {
    const el = document.getElementById('name-input');
    for (let k = 0; k < 6; k++) { el.value = `Rob${k}`; el.dispatchEvent(new Event('change')); }
  });
  const pb = await guest.locator(PILE).boundingBox(); // a drag: a stream of move actions
  await guest.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await guest.mouse.down();
  for (let k = 1; k <= 10; k++) { await guest.mouse.move(pb.x + pb.width / 2 + 8 * k, pb.y + pb.height / 2); await h.sleep(80); }
  await guest.mouse.up();
  await h.sleep(1000);
  ok(floods.length === 1, `a rename refused by flood control isn't retried with every later action (${floods.length} refusal${floods.length === 1 ? '' : 's'})`);
  await h.sleep(5200);
  await guest.evaluate(() => { const el = document.getElementById('name-input'); el.value = 'Robert'; el.dispatchEvent(new Event('change')); });
  await logHas(host, 'is now known as "Robert"');

  section('NET-3: hand faces render when deck data lands after the state');
  const N = 24;
  const pngs = await host.evaluate(async (n) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      const c = document.createElement('canvas'); c.width = c.height = 560;
      const g = c.getContext('2d'), d = g.createImageData(560, 560);
      for (let j = 0; j < d.data.length; j++) d.data[j] = (j % 4 === 3) ? 255 : Math.random() * 256;
      g.putImageData(d, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      out.push(await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); }));
    }
    return out;
  }, N);
  await host.click('#add-deck-btn');
  await host.check('input[name="deck-kind"][value="img"]');
  await host.setInputFiles('#deck-files', pngs.map((b64, k) => ({ name: `c${k}.png`, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') })));
  await host.click('#deck-add');
  await logHas(host, `(${N} cards)`, 60000);
  await guest.waitForSelector(`.item.pile:has(.count:text-is("${N}"))`, { timeout: 60000 });
  const imgPile = `.item[data-id="${await guest.$eval(`.item.pile:has(.count:text-is("${N}"))`, (el) => el.dataset.id)}"]`;
  for (let k = 0; k < 3; k++) { await guest.dblclick(imgPile); await h.waitHand(guest, k + 1); }
  await guest.waitForFunction(() => document.querySelectorAll('.hcard img').length === 3, null, { timeout: 30000 });
  await guest.reload();
  await h.waitHand(guest, 3, 40000);
  await guest.waitForFunction(() => document.querySelectorAll('.hcard img').length === 3, null, { timeout: 20000 })
    .then(() => ok(true, 'after a reload the hand shows the 3 image faces (no stuck placeholders)'),
      async () => ok(false, `after a reload the hand shows the 3 image faces (loading: ${await guest.locator('.hcard .loading').count()})`));

  section('NET-9: the host leaving is visible');
  const hostUrl = host.url(), ctx = host.context();
  await host.close();
  await guest.waitForFunction(() => !document.getElementById('table-hint').classList.contains('hidden'), null, { timeout: 20000 })
    .then(() => ok(true, 'the guest sees a hint once the host is gone'), () => ok(false, 'the guest sees a hint once the host is gone'));
  ok(/host left/.test(await guest.$eval('#table-hint', (el) => el.textContent)), 'it says the host left and the table is paused');
  ok(await guest.$$eval('.seat.offline', (els) => els.some((e) => e.textContent.startsWith('Alice'))), "the host's seat is greyed out");
  const back = await ctx.newPage();
  await back.goto(hostUrl);
  await guest.waitForFunction(() => document.getElementById('table-hint').classList.contains('hidden'), null, { timeout: 40000 })
    .then(() => ok(true, 'the hint goes away when the host returns'), () => ok(false, 'the hint goes away when the host returns'));
  ok(!(await guest.$$eval('.seat.offline', (els) => els.some((e) => e.textContent.startsWith('Alice')))), "and the host's seat is live again");
  await env.done();
})().catch(h.crash);
