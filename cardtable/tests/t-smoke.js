// Harness smoke test: host + guest connect over the local relay; a draw syncs.
const h = require('./h');
(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  h.ok(true, 'guest connected and received the table');
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 1);
  await h.logHas(host, 'Bob drew a card');
  h.ok(true, 'guest draw is applied by the host and logged');
  await env.done();
})().catch(h.crash);
