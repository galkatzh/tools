// Harness smoke test: host + guest connect over the local relay; a draw syncs.
// Also: the state core (core.js) runs in a module Worker, as the rules will.
const h = require('./h');
(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  h.ok(true, 'guest connected and received the table');
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 1);
  await h.logHas(host, 'Bob drew a card');
  h.ok(true, 'guest draw is applied by the host and logged');
  const n = await host.evaluate(() => {
    const src = `import { createTable } from '${new URL('core.js', location.href)}';
      const T = createTable({}, { pid: 'w' });
      T.open('Worker');
      postMessage(Object.values(T.publicItems())[0].n);`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
    return new Promise((resolve, reject) => {
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => reject(new Error(`worker: ${e.message}`));
    });
  });
  h.ok(n === 52, `core.js opens a table in a module Worker (a ${n}-card deck)`);
  await env.done();
})().catch(h.crash);
