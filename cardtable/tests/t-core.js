// E2E: the free-form simulator (no rules) with 2–3 players — every basic table
// op, its sync to the other screen and its log line, plus reload/resume,
// late joiners and offline seats.
const h = require('./h');
const { ok, section, logHas } = h;

// --- DOM helpers (all state is read from the DOM each page renders) ----------
const IT = (id) => `.item[data-id="${id}"]`;
const PILE = '.item.pile:has(.pname)'; // the named "Standard" deck pile
const ids = (p) => p.$$eval('.item', (els) => els.map((e) => e.dataset.id));
/** Waits for an item that wasn't in `before` (and matches the `pred` expression over `el`); returns its id. */
async function newItem(p, before, pred = 'true') {
  const handle = await p.waitForFunction(({ b, pred }) => {
    const el = [...document.querySelectorAll('.item')].find((e) => !b.includes(e.dataset.id) && new Function('el', `return ${pred}`)(e));
    return el?.dataset.id;
  }, { b: before, pred }, { timeout: 15000 });
  return handle.jsonValue();
}
const hasItem = (p, id, yes = true) => p.waitForFunction(({ s, yes }) => !!document.querySelector(s) === yes, { s: IT(id), yes }, { timeout: 15000 });
/** "7♥" for a face-up standard card element (table item or hand card). */
const faceName = (p, sel) => p.$eval(sel, (el) => el.querySelector('.mr').textContent + el.querySelector('.ms').textContent);
const pileCount = (p, sel = PILE) => p.$eval(`${sel} .count`, (el) => +el.textContent);
const waitCount = (p, n, sel = PILE) => p.waitForFunction(({ s, n }) => +document.querySelector(`${s} .count`)?.textContent === n, { s: sel, n }, { timeout: 15000 });
const logText = (p) => p.$eval('#log', (el) => el.textContent);
const center = async (p, sel) => { const b = await p.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
/** Drags a table item to an [x, y] screen point (or onto another selector). */
async function drag(p, sel, to) {
  const [x, y] = await center(p, sel);
  const [tx, ty] = typeof to === 'string' ? await center(p, to) : to;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(tx, ty, { steps: 12 });
  await p.mouse.up();
}
/** Screen point at fractions of the table's bounding box. */
const spot = async (p, fx, fy) => { const b = await p.locator('#table').boundingBox(); return [b.x + b.width * fx, b.y + b.height * fy]; };
/** Selects an item (a click on the selected one would deselect it) and presses an action-bar button. */
async function cmd(p, sel, c) {
  if (!(await p.$eval(sel, (el) => el.classList.contains('selected')))) await p.click(sel);
  await p.click(`#action-bar:not(.hidden) [data-cmd="${c}"]`);
}
const seats = (p) => p.$$eval('.seat', (els) => els.map((e) => ({ t: e.textContent, me: e.classList.contains('me'), off: e.classList.contains('offline') })));
/** Every table item as "id|sig|left|top" — equal snapshots mean identical tables. */
const SNAP = () => [...document.querySelectorAll('.item')].map((e) => `${e.dataset.id}|${e.dataset.sig}|${e.style.left}|${e.style.top}`).sort().join('\n');
const snap = (p) => p.evaluate(SNAP);
const pos = (p, id) => p.$eval(IT(id), (el) => [el.style.left, el.style.top, el.style.transform]);

(async () => {
  const env = await h.start();

  section('join, seats, nickname');
  const { host, guest } = await h.hostAndGuest(env, 'Alice', 'Bob');
  for (const [n, p] of [['host', host], ['guest', guest]]) {
    await p.waitForFunction(() => document.querySelectorAll('.seat').length === 2 && /Bob/.test(document.querySelector('.seat:not(.me)')?.textContent + document.querySelector('.seat.me')?.textContent));
    const s = await seats(p);
    ok(s.some((x) => x.t.startsWith('Alice')) && s.some((x) => x.t.startsWith('Bob')) && s.filter((x) => x.me).length === 1, `${n} sees both named seats, one marked as its own`);
  }
  ok((await seats(guest)).find((x) => x.me).t.startsWith('Bob'), "the guest's own seat is Bob's");
  ok(await guest.$eval('#name-input', (el) => el.value) === 'Bob', 'chosen nickname fills the toolbar name field');
  await logHas(host, 'Bob joined the table');
  await logHas(guest, 'opened the table');
  ok(true, 'join is logged and the guest receives the existing log');
  // regression (fixed in fix-sync), was: a joiner's log shows "Player" for every actor until the next log entry
  ok(await logHas(guest, 'Alice opened the table', 5000).then(() => true, () => false), "the joiner's log names the actors");
  ok(await host.isVisible('#size-sel') && !(await guest.isVisible('#size-sel')), 'only the host gets the table-size control');
  ok(await pileCount(guest) === 52, 'guest sees the 52-card Standard pile');

  section('draw');
  await guest.dblclick(PILE);
  await h.waitHand(guest, 1);
  await logHas(host, 'Bob drew a card from the Standard pile');
  await waitCount(host, 51);
  await host.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => /^Bob 🂠1/.test(s.textContent)));
  ok(true, 'double-click draws into the hand; pile shrinks and the seat shows 🂠1 on the host');
  ok(await h.handCount(host) === 0, "the guest's card is not in the host's hand row");

  section('deal face up / face down');
  let before = await ids(guest);
  await cmd(host, PILE, 'dealup');
  const up1 = await newItem(guest, before, "!!el.querySelector('.face.std')");
  const up1Name = await faceName(guest, IT(up1));
  await logHas(guest, `Alice dealt ${up1Name} from the Standard pile`);
  ok(true, `Deal↑ shows the face on the guest and logs its name (${up1Name})`);
  await drag(host, IT(up1), await spot(host, 0.3, 0.3)); // clear the deal spot
  before = await ids(guest);
  await cmd(host, PILE, 'dealdn');
  const dn1 = await newItem(guest, before, "!!el.querySelector('.back')");
  await logHas(guest, 'Alice dealt a card face down from the Standard pile');
  ok(!(await guest.$(`${IT(dn1)} .face`)), 'Deal↓ shows only the back on the guest');
  await waitCount(guest, 49);
  ok(true, 'pile count is 49 on the guest after one draw and two deals');

  section('drag-move syncs');
  await drag(host, IT(dn1), await spot(host, 0.7, 0.3));
  await host.waitForFunction((s) => document.querySelector(s).style.left !== '', IT(dn1));
  const hp = await pos(host, dn1);
  await guest.waitForFunction(({ s, l, t }) => { const e = document.querySelector(s); return e.style.left === l && e.style.top === t; }, { s: IT(dn1), l: hp[0], t: hp[1] }, { timeout: 15000 });
  ok(true, `host drag lands at the same table position on the guest (${hp[0]}, ${hp[1]})`);
  await logHas(guest, 'Alice moved a face-down card');
  const gp = await spot(guest, 0.6, 0.6); // guest view is rotated 180°: this is near the host's (0.4, 0.4)
  const l0 = (await pos(host, up1))[0];
  await drag(guest, IT(up1), gp);
  await host.waitForFunction(({ s, l }) => document.querySelector(s).style.left !== l, { s: IT(up1), l: l0 }, { timeout: 15000 });
  await logHas(host, `Bob moved ${up1Name}`);
  ok(true, 'guest drag moves the card on the host too');

  section('flip, rotate');
  await guest.dblclick(IT(dn1));
  await host.waitForSelector(`${IT(dn1)} .face.std`);
  const dn1Name = await faceName(host, IT(dn1));
  await logHas(host, `Bob flipped ${dn1Name} face up`);
  ok(true, 'guest double-click flips a card face up for everyone');
  await cmd(guest, IT(dn1), 'flip');
  await host.waitForSelector(`${IT(dn1)} .back`);
  await logHas(host, `Bob flipped ${dn1Name} face down`);
  ok(true, 'action-bar Flip turns it back down');
  const rot0 = (await pos(host, dn1))[2];
  await cmd(guest, IT(dn1), 'rr');
  await host.waitForFunction(({ s, r }) => document.querySelector(s).style.transform !== r, { s: IT(dn1), r: rot0 });
  const rot1 = (await pos(host, dn1))[2];
  ok(+rot1.match(/-?\d+/)[0] === (+rot0.match(/-?\d+/)[0] + 90) % 360, `⟳90 rotates the card by 90° on the host (${rot0} → ${rot1})`);
  await logHas(host, 'Bob rotated a face-down card');

  section('play from hand: face up and face down');
  const handName = await faceName(guest, '.hcard');
  before = await ids(host);
  await h.playFromHand(guest, 0, 0.7, 0.7);
  await h.waitHand(guest, 0);
  const g1 = await newItem(host, before);
  await host.waitForSelector(`${IT(g1)} .face.std`);
  ok(await faceName(host, IT(g1)) === handName, `face-up play shows ${handName} on the host`);
  await logHas(host, `Bob played ${handName} from hand`);
  await host.dblclick(PILE); // Alice draws a secret card and plays it face down
  await h.waitHand(host, 1);
  const secret = await faceName(host, '.hcard');
  await host.click('#facedown-toggle');
  before = await ids(guest);
  await h.playFromHand(host, 0, 0.3, 0.7);
  await h.waitHand(host, 0);
  const fd = await newItem(guest, before);
  await logHas(guest, 'Alice played a card face down from hand');
  await host.click('#facedown-toggle');
  ok(await host.$(`${IT(fd)} .back`) && await guest.$(`${IT(fd)} .back`), 'face-down play shows the back on both screens');
  ok(!(await logText(guest)).includes(secret), `the guest's log never names the hidden card (${secret})`);
  ok(await guest.$eval(IT(fd), (el) => !el.querySelector('.face') && !/\b(mr|ms)\b/.test(el.innerHTML)), "the guest's DOM for it holds no face markup");
  // regression (fixed in fix-sync), was: face-down card identity is broadcast to every guest (state.items + data-sig)
  ok(await guest.$eval(IT(fd), (el) => !/^c\|[^|]+\|\d+\|/.test(el.dataset.sig)), "the guest's DOM doesn't carry the hidden card's deck index");

  section('stacking: card on card → pile, card onto pile, merge piles');
  before = await ids(host);
  await drag(guest, IT(up1), IT(g1)); // Bob drops one face-up card on another
  const st = await newItem(host, before, "el.classList.contains('pile')");
  await waitCount(host, 2, IT(st));
  ok(!(await host.$(IT(up1))) && !(await host.$(IT(g1))), 'card dropped on a card makes a 2-card pile (both cards absorbed)');
  await logHas(host, `Bob stacked ${up1Name} onto ${handName}`);
  await drag(host, IT(dn1), IT(st));
  await waitCount(guest, 3, IT(st));
  await hasItem(guest, dn1, false);
  await logHas(guest, 'Alice put a face-down card onto the stacked pile');
  ok(true, 'card dropped onto a pile joins it (count 3 on the guest)');
  const deckN = await pileCount(host);
  await drag(guest, IT(st), PILE);
  await hasItem(host, st, false);
  await waitCount(host, deckN + 3);
  await logHas(host, 'Bob merged the stacked pile (3 cards) into the Standard pile');
  ok(true, `pile dropped on a pile merges (${deckN} → ${deckN + 3})`);

  section('shuffle, take into hand, delete');
  await cmd(guest, PILE, 'shuffle');
  await logHas(host, `Bob shuffled the Standard pile (${deckN + 3} cards)`);
  ok(true, 'shuffle is applied and logged with the card count');
  before = await ids(guest);
  await cmd(host, PILE, 'dealup');
  const t1 = await newItem(guest, before);
  const t1Name = await faceName(guest, IT(t1));
  await drag(guest, IT(t1), '#hand-bar');
  await h.waitHand(guest, 1);
  await hasItem(host, t1, false);
  ok(await faceName(guest, '.hcard') === t1Name, `dragging a table card to the hand bar takes ${t1Name} into hand`);
  await logHas(host, `Bob took ${t1Name} from the table into hand`);
  before = await ids(guest);
  await cmd(host, PILE, 'dealup');
  const t2 = await newItem(guest, before);
  const t2Name = await faceName(guest, IT(t2));
  await cmd(guest, IT(t2), 'hand');
  await h.waitHand(guest, 2);
  await logHas(host, `Bob took ${t2Name} from the table into hand`);
  ok(true, 'the Hand button takes a card too');
  before = await ids(guest);
  await cmd(host, PILE, 'dealdn');
  const del = await newItem(guest, before);
  await cmd(guest, IT(del), 'del');
  await hasItem(host, del, false);
  await hasItem(guest, del, false);
  await logHas(host, 'Bob removed a face-down card');
  ok(true, '🗑 deletes the card for everyone');

  section('peek');
  before = await ids(guest);
  await cmd(host, PILE, 'dealdn');
  const pk = await newItem(guest, before);
  await drag(host, IT(pk), await spot(host, 0.35, 0.6));
  const logLen = (await logText(host)).length;
  await cmd(guest, IT(pk), 'peek');
  await guest.waitForSelector('#peek:not(.hidden) .face.std');
  const peeked = await guest.$eval('#peek-inner', (el) => el.querySelector('.mr').textContent + el.querySelector('.ms').textContent);
  ok(await host.$eval('#peek', (el) => el.classList.contains('hidden')), `the peek overlay (${peeked}) shows only on the peeker's screen`);
  await logHas(host, 'Bob peeked at a face-down card');
  await logHas(guest, 'Bob peeked at a face-down card');
  ok(!(await logText(host)).slice(logLen).includes(peeked), 'the log records that Bob peeked, not what he saw');
  ok(await guest.$(`${IT(pk)} .back`), 'the card stays face down on the table');
  await guest.click('#peek');
  await guest.waitForSelector('#peek.hidden', { state: 'attached' });
  await cmd(host, PILE, 'peek');
  await host.waitForSelector('#peek:not(.hidden)');
  await logHas(guest, 'Alice peeked at the top card of the Standard pile');
  await host.click('#peek');
  ok(true, 'peeking a pile top is logged for everyone');

  section('chat, rename');
  await guest.fill('#chat-input', 'gg all');
  await guest.press('#chat-input', 'Enter');
  await host.waitForFunction(() => [...document.querySelectorAll('#log .lg.chat')].some((e) => e.textContent.includes('Bob: gg all')), null, { timeout: 15000 });
  ok(await guest.$eval('#chat-input', (el) => el.value) === '', 'chat reaches the host log as a chat line and clears the input');
  await guest.fill('#name-input', 'Bobby');
  await guest.press('#name-input', 'Enter');
  await logHas(host, 'is now known as "Bobby"');
  // regression (fixed in fix-sync), was: the rename entry reads 'Bobby is now known as "Bobby"' (log names are live, the old name is lost)
  ok((await logText(host)).includes('Bob is now known as "Bobby"'), 'the rename entry keeps the old name');
  await host.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.startsWith('Bobby')));
  ok(true, 'rename is logged and the seat label follows');

  section('host reload resumes the table');
  const tableBefore = await snap(host);
  const bobHand = await guest.$$eval('.hcard', (els) => els.map((e) => e.innerHTML).join());
  await host.reload();
  await logHas(host, 'Alice resumed the table', 30000);
  ok(await snap(host) === tableBefore, 'the host gets back every item at the same place');
  ok(await host.isVisible('#size-sel'), 'the reloaded tab is host again');
  await host.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => /^Bobby 🂠2/.test(s.textContent)), null, { timeout: 30000 });
  await logHas(guest, 'Alice resumed the table', 30000);
  ok(await guest.$$eval('.hcard', (els) => els.map((e) => e.innerHTML).join()) === bobHand, 'the guest keeps its hand across the host reload');
  await guest.dblclick(PILE);
  await h.waitHand(guest, 3);
  ok(true, 'the guest can still act on the resumed table');

  section('guest reload reclaims its hand');
  const hand3 = await guest.$$eval('.hcard', (els) => els.map((e) => e.innerHTML).join());
  await guest.reload();
  await guest.waitForFunction((x) => [...document.querySelectorAll('.hcard')].map((e) => e.innerHTML).join() === x, hand3, { timeout: 30000 });
  ok(true, 'same three cards after reload');
  ok(!(await guest.isVisible('#name-dialog')) && await guest.$eval('#name-input', (el) => el.value) === 'Bobby', 'no nickname prompt; the renamed name sticks');
  await host.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.startsWith('Bobby') && !s.classList.contains('offline')));
  ok(true, "the host shows Bobby's seat online again");
  // regression (fixed in fix-sync), was: a returning player is never logged "is back at the table" (and onJoin never re-fires)
  ok(await logHas(host, 'Bobby is back at the table', 5000).then(() => true, () => false), 'the return is logged');
  ok((await seats(host)).length === 2, 'no duplicate seat for the returning guest');

  section('late joiner catches up');
  const carol = await env.page('Carol');
  await carol.goto(host.url());
  await h.joinAs(carol, 'Carol');
  const hostSnap = await snap(host);
  await carol.waitForFunction(`(${SNAP})() === ${JSON.stringify(hostSnap)}`, null, { timeout: 30000 });
  ok(true, `Carol sees the same ${hostSnap.split('\n').length} items as the host, same places`);
  await logHas(carol, 'opened the table');
  await logHas(carol, 'is now known as "Bobby"');
  ok((await logText(carol)).includes('gg all'), 'Carol receives the history log (incl. chat)');
  await carol.waitForFunction(() => document.querySelectorAll('.seat').length === 3);
  await guest.waitForFunction(() => [...document.querySelectorAll('.seat')].some((s) => s.textContent.startsWith('Carol')), null, { timeout: 15000 });
  ok((await seats(carol)).some((s) => /^Bobby 🂠3/.test(s.t)) && await h.handCount(carol) === 0, "Carol sees Bobby's hand count, not his cards");
  await guest.waitForFunction(() => document.getElementById('log').textContent.split('joined the table').length === 3, null, { timeout: 15000 });
  ok(true, 'everyone sees three seats and the join');
  // regression (fixed in fix-sync), was: same stale-name bug — Bobby's log reads "Player joined the table" for Carol
  ok(await logHas(guest, 'Carol joined the table', 5000).then(() => true, () => false), "the join names Carol in Bobby's log");

  section('offline seat marking');
  await carol.close();
  for (const [n, p] of [['host', host], ['guest', guest]]) {
    await p.waitForFunction(() => [...document.querySelectorAll('.seat.offline')].some((s) => s.textContent.startsWith('Carol')), null, { timeout: 30000 });
    await logHas(p, 'Carol left the table');
    ok(true, `${n} greys out Carol's seat and logs her leaving`);
  }
  ok((await seats(host)).filter((s) => s.off).length === 1, 'only Carol is offline');

  await env.done();
})().catch(h.crash);
