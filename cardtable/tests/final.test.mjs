// Final review, fix-up B (D311, D312, D315), in Node: the engine side of what the phone
// and desktop reviews found.
//   (1) endSeats: the host's way back from named seats to automatic seating —
//       every watcher sits, the gone seats' pieces belong to nobody, the log
//       says so; a guest's is refused; with no named seats it changes nothing.
//   (2) Dominoes' rules keep the boneyard and the tiles: a delete is refused
//       (one tap on 🗑 ended the round for both players).
//   (3) the facade's errors name the call (§0.2): t.newDeck() with nothing,
//       an empty deck, t.schedule('soon') are TypeErrors saying "t.newDeck:"
//       or "t.schedule:".
//   (4) a refused setup (D318): the savepoint puts back whether the next
//       patch carries the table and the seats, so it carries neither, and no
//       player's view starts afresh (D317) for a game that never began.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, core, ok, section, report, crash, guard, HOST, BOB, CAROL, env } from './node-lib.mjs';

const { BOXES } = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')));
const { createTable } = core;

/** Runs fn with console.warn / console.error collected, not printed. */
function quietly(fn) {
  const keep = [console.warn, console.error];
  console.warn = console.error = () => {};
  try { return fn(); } finally { [console.warn, console.error] = keep; }
}
/** A table hosted by Ann with Bo and Cy joined (the script runner in this realm). */
function room(seed) {
  const T = quietly(() => createTable({}, env(seed)));
  T.open('Ann');
  for (const [p, n] of [[BOB, 'Bo'], [CAROL, 'Cy']]) quietly(() => T.apply(p, { t: '_join', name: n }));
  T.drain();
  return T;
}
/** Applies action a as p; {changed, notes (p's), lines (new log texts)}. */
function run(T, p, a) {
  const n = T.state.log.length, changed = quietly(() => T.apply(p, a));
  return { changed, notes: T.drain().filter((e) => e.t === 'note' && e.p === p).map((e) => e.msg), lines: T.state.log.slice(n).map((e) => e.txt) };
}

try {
  await guard('(1) endSeats', () => {
    section('(1) endSeats: back to automatic seating, every watcher seated');
    const T = room(1);
    run(T, HOST, { t: 'loadBox', box: BOXES.draughts, setup: true, clear: true });
    const pl = () => Object.values(T.state.players);
    ok(T.state.seats?.length === 2 && pl().filter((x) => x.seat == null).length === 1, 'Draughts: two named seats, one of three watches');
    const mine = Object.values(T.state.items).filter((it) => it.owner === 'seat:light').length;
    const bo = run(T, BOB, { t: 'endSeats' });
    ok(!bo.changed && bo.notes.join() === '🚫 Only the host can do that' && T.state.seats?.length === 2, `a guest's is refused (${bo.notes})`);
    const r = run(T, HOST, { t: 'endSeats' });
    ok(r.changed && T.state.seats == null && pl().every((x) => x.seat != null && x.seatId === undefined), 'the host\'s: no named seats, everyone sits (the watcher too)');
    ok(r.lines.includes('removed the named seats: everyone sits where they like') && r.lines.includes(`released ${mine} items of Light: that seat is gone`), `the log says so (${r.lines.join(' | ')})`);
    ok(!Object.values(T.state.items).some((it) => typeof it.owner === 'string' && it.owner.startsWith('seat:')), "the gone seats' men belong to nobody: anyone may take them off");
    ok(!run(T, HOST, { t: 'endSeats' }).changed, 'again, with no named seats: nothing changes');
  });

  await guard('(2) Dominoes keeps its boneyard', () => {
    section('(2) Dominoes: a delete is refused, the boneyard and the tiles stay');
    const T = room(2);
    run(T, HOST, { t: 'loadBox', box: BOXES.dominoes, setup: true, clear: true });
    run(T, HOST, { t: 'setRules', enabled: true, code: BOXES.dominoes.rules });
    ok(T.state.rules?.enabled && T.state.rules.name === 'Dominoes', '(the Dominoes rules run)');
    const bag = Object.keys(T.state.items).find((id) => T.state.items[id].k === 'b'), n = T.state.items[bag].of.length;
    const tile = Object.keys(T.state.items).find((id) => T.state.items[id].k === 'g' && T.state.items[id].z >= 0);
    const seatedGuest = [BOB, CAROL].find((p) => T.state.players[p].seatId);
    for (const [p, who] of [[HOST, 'the host'], [seatedGuest, 'a seated guest']]) {
      const r = run(T, p, { t: 'del', id: bag });
      ok(T.state.items[bag]?.of.length === n && r.notes.join() === '🚫 The tiles and the boneyard stay on the table', `${who} deleting the boneyard: refused, all ${n} stay (${r.notes})`);
    }
    if (tile) {
      const r = run(T, HOST, { t: 'del', id: tile });
      ok(!!T.state.items[tile] && /^🚫/.test(r.notes.join()), `a tile: refused too (${r.notes})`);
    }
  });

  await guard('(3) the facade names its call', () => {
    section('(3) t.newDeck and t.schedule throw TypeErrors that name the call');
    const T = room(3);
    const code = `({ name: 'Probe', setup(t) {
      const e = (f) => { try { f(); return 'none'; } catch (x) { return x.name + ': ' + x.message; } };
      t.data.r = [e(() => t.newDeck()), e(() => t.newDeck({ name: 'Empty', cards: [] })), e(() => t.schedule('soon', 'x'))];
    } })`;
    const decks0 = Object.keys(T.state.decks).length;
    run(T, HOST, { t: 'setRules', enabled: true, code });
    const [none, empty, soon] = T.state.rules.data.r;
    ok(none === 'TypeError: t.newDeck: give it {name, cards, back?}', `t.newDeck(): "${none}"`);
    ok(/^TypeError: t\.newDeck: /.test(empty), `t.newDeck({cards: []}): "${empty}"`);
    ok(/^TypeError: t\.schedule: seconds must be a number/.test(soon), `t.schedule('soon'): "${soon}"`);
    ok(Object.keys(T.state.decks).length === decks0, 'and no deck was minted by the calls that failed');
  });

  await guard('(4) a refused setup sends no seats', () => {
    section('(4) a refused setup leaves the next patch without the table and the seats (D318)');
    const T = room(4);
    const box = { ...structuredClone(BOXES.draughts), name: 'Draughts for four' };
    box.setup = [...box.setup, { ...box.setup[0], owner: '#4' }]; // (three are seated: it is refused)
    T.takeDirty();
    const r = run(T, HOST, { t: 'loadBox', box, setup: true, clear: false }), c = T.patchContent(T.takeDirty());
    ok(/needs 4 seated players/.test(r.notes.join()) && T.state.seats == null, `the setup is refused, the seats as they were (${r.notes})`);
    ok(!('seats' in c) && !('table' in c), `the next patch carries neither the seats nor the table (${Object.keys(c)}): nobody's view starts afresh (D317)`);
    const go = run(T, HOST, { t: 'loadBox', box: BOXES.draughts, setup: true, clear: true }), c2 = T.patchContent(T.takeDirty());
    ok(go.changed && c2.seats?.length === 2, '(control: a setup that goes ahead carries its seats)');
  });
} catch (e) { crash(e); }
report();
