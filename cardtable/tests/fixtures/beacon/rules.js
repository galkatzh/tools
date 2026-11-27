// Beacon Watch: keep watch, and light the beacons. (A fixture of the game-box suites.)
({
  name: 'Beacon Watch',
  setup(t) { t.data.watches = (t.data.watches || 0) + 1; },
  buttons(t) { return [{ id: 'watch', label: '🔥 Keep watch' }]; },
  onButton(t, id, p) { t.data.watches += 1; t.say(`kept watch ${t.data.watches} times`); },
})
