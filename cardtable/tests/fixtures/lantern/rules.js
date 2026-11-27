// Lantern Watch: light the lanterns, one by one. (A fixture of the game-box suites; original.)
({
  name: 'Lantern Watch',
  setup(t) {
    t.data.lit ??= 0;
    t.data.box ??= t.boxes().find((b) => b.name === 'Lantern Watch')?.id ?? null;
  },
  buttons(t) { return [{ id: 'light', label: '🏮 Light a lantern' }]; },
  onButton(t, id) {
    if (id !== 'light') return;
    t.data.lit += 1;
    t.public.lit = t.data.lit;
    t.say(`lanterns lit: ${t.data.lit}`);
  },
})
