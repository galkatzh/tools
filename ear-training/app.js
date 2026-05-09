// Entry: tab routing, settings persistence, stats view rendering.
// Other modules (`MelodyQuiz`, `ChordQuiz`, `Stats`, `Theory`, `EarAudio`)
// are exposed as globals via their own files.
(function () {
  'use strict';

  var SETTINGS_KEY = 'ear-training-settings';

  var DEFAULT_SETTINGS = {
    melodyLength: 4,
    melodyScale: 'major',
    melodyVariant: 'all',           // 'first' | 'last' | 'all'
    melodyInputMode: 'degrees',     // 'degrees' | 'keyboard'
    cadenceOn: false,
    enabledChordTypes: ['maj', 'min', '7', 'm7', 'dim', 'maj7'],
    arpeggiateChords: false
  };

  var settings = loadSettings();

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
      var parsed = JSON.parse(raw);
      // shallow-merge so new defaults appear for old users
      return Object.assign({}, DEFAULT_SETTINGS, parsed);
    } catch (err) {
      console.error('Settings load failed:', err);
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      console.error('Settings save failed:', err);
    }
  }

  // ───── Routing ─────
  var ROUTES = ['melody', 'chords', 'stats', 'settings'];

  function currentRoute() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    return ROUTES.indexOf(h) >= 0 ? h : 'melody';
  }

  function navigate(route) {
    if (location.hash !== '#/' + route) location.hash = '#/' + route;
    else render();
  }

  // ───── Render ─────
  var viewEl;

  function render() {
    var route = currentRoute();
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('tab-active', b.dataset.route === route);
    });
    viewEl.innerHTML = '';
    var sub = document.createElement('div');
    sub.className = 'view view-' + route;
    viewEl.appendChild(sub);

    switch (route) {
      case 'melody':   window.MelodyQuiz.init(sub); break;
      case 'chords':   window.ChordQuiz.init(sub); break;
      case 'stats':    renderStats(sub); break;
      case 'settings': renderSettings(sub); break;
    }
  }

  // ───── Stats view ─────
  function renderStats(rootEl) {
    rootEl.appendChild(h('h2', '', 'Weekly Stats'));
    var loading = h('p', 'muted', 'Loading…');
    rootEl.appendChild(loading);

    window.Stats.weeklyAggregate().then(function (agg) {
      loading.remove();
      // Streaks
      var streaks = h('div', 'stats-streaks');
      streaks.appendChild(stat('Day streak', agg.streak.dayStreak + ' day' + (agg.streak.dayStreak === 1 ? '' : 's')));
      streaks.appendChild(stat('Current correct streak', String(agg.streak.current)));
      rootEl.appendChild(streaks);

      // Totals
      var totals = h('div', 'stats-totals');
      totals.appendChild(stat('Melody', agg.totals.melody.correct + ' / ' + agg.totals.melody.n
        + (agg.totals.melody.n ? ' (' + Math.round(100 * agg.totals.melody.correct / agg.totals.melody.n) + '%)' : '')));
      totals.appendChild(stat('Chord', agg.totals.chord.correct + ' / ' + agg.totals.chord.n
        + (agg.totals.chord.n ? ' (' + Math.round(100 * agg.totals.chord.correct / agg.totals.chord.n) + '%)' : '')));
      rootEl.appendChild(totals);

      // Per-day bars
      rootEl.appendChild(h('h3', '', 'Last 7 days'));
      var dayList = h('div', 'stats-days');
      var maxN = Math.max.apply(null, agg.days.map(function (d) { return d.melody.n + d.chord.n; }).concat([1]));
      agg.days.forEach(function (d) {
        var row = h('div', 'stats-day');
        row.appendChild(h('div', 'stats-day-label', d.label));
        var bars = h('div', 'stats-day-bars');
        var melW = (d.melody.n / maxN) * 100;
        var chdW = (d.chord.n / maxN) * 100;
        var melBar = h('div', 'stats-bar stats-bar-melody');
        melBar.style.width = melW + '%';
        melBar.title = 'Melody: ' + d.melody.correct + '/' + d.melody.n;
        var chdBar = h('div', 'stats-bar stats-bar-chord');
        chdBar.style.width = chdW + '%';
        chdBar.title = 'Chord: ' + d.chord.correct + '/' + d.chord.n;
        bars.appendChild(melBar);
        bars.appendChild(chdBar);
        row.appendChild(bars);
        var counts = h('div', 'stats-day-counts',
          (d.melody.n + d.chord.n) === 0
            ? '—'
            : (d.melody.n + d.chord.n) + ' attempts');
        row.appendChild(counts);
        dayList.appendChild(row);
      });
      rootEl.appendChild(dayList);

      // Per-chord-type accuracy
      var ctNames = Object.keys(agg.byChordType);
      if (ctNames.length) {
        rootEl.appendChild(h('h3', '', 'Chord types (last 7 days)'));
        var ctList = h('div', 'stats-chordtypes');
        ctNames.sort().forEach(function (id) {
          var info = agg.byChordType[id];
          var label = (window.Theory.CHORD_TYPES[id] && window.Theory.CHORD_TYPES[id].label) || id;
          var pct = info.n ? Math.round(100 * info.correct / info.n) : 0;
          var row = h('div', 'stats-ct-row');
          row.appendChild(h('div', 'stats-ct-label', label));
          var barWrap = h('div', 'stats-ct-bar-wrap');
          var bar = h('div', 'stats-ct-bar');
          bar.style.width = pct + '%';
          barWrap.appendChild(bar);
          row.appendChild(barWrap);
          row.appendChild(h('div', 'stats-ct-count', info.correct + '/' + info.n + ' · ' + pct + '%'));
          ctList.appendChild(row);
        });
        rootEl.appendChild(ctList);
      }

      // Export / clear
      var actions = h('div', 'stats-actions');
      var expBtn = h('button', 'btn-ghost', 'Export JSON');
      expBtn.addEventListener('click', function () {
        window.Stats.exportAll().then(function (rows) {
          var blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'ear-training-stats-' + new Date().toISOString().slice(0, 10) + '.json';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        });
      });
      var clrBtn = h('button', 'btn-ghost btn-danger', 'Clear all stats');
      clrBtn.addEventListener('click', function () {
        if (!confirm('Delete all stats? This cannot be undone.')) return;
        window.Stats.clearAll().then(function () { render(); });
      });
      actions.appendChild(expBtn);
      actions.appendChild(clrBtn);
      rootEl.appendChild(actions);
    }).catch(function (err) {
      console.error('Stats render failed:', err);
      loading.textContent = 'Failed to load stats: ' + err.message;
    });
  }

  function stat(label, value) {
    var d = h('div', 'stat-card');
    d.appendChild(h('div', 'stat-label', label));
    d.appendChild(h('div', 'stat-value', value));
    return d;
  }

  // ───── Settings view ─────
  function renderSettings(rootEl) {
    rootEl.appendChild(h('h2', '', 'Settings'));

    // Melody section
    rootEl.appendChild(h('h3', '', 'Melody'));
    rootEl.appendChild(numField('Melody length', 'melodyLength', 2, 8, 1));
    rootEl.appendChild(selectField('Scale', 'melodyScale', [
      { value: 'major', label: 'Major' },
      { value: 'minor', label: 'Minor (natural)' },
      { value: 'chromatic', label: 'Chromatic' }
    ]));
    rootEl.appendChild(selectField('Variant', 'melodyVariant', [
      { value: 'all',   label: 'Identify every note' },
      { value: 'first', label: 'First note only' },
      { value: 'last',  label: 'Last note only' }
    ]));
    rootEl.appendChild(selectField('Default input', 'melodyInputMode', [
      { value: 'degrees',  label: 'Scale-degree buttons' },
      { value: 'keyboard', label: 'On-screen keyboard' }
    ]));
    rootEl.appendChild(checkboxField('Play I-IV-V-I cadence before melody', 'cadenceOn'));

    // Chord section
    rootEl.appendChild(h('h3', '', 'Chords'));
    rootEl.appendChild(checkboxField('Arpeggiate chord (also play block)', 'arpeggiateChords'));

    rootEl.appendChild(h('div', 'muted', 'Enabled chord types (each round picks from these):'));
    var grid = h('div', 'chord-toggle-grid');
    Object.keys(window.Theory.CHORD_TYPES).forEach(function (id) {
      var label = window.Theory.CHORD_TYPES[id].label;
      var btn = h('button', 'chord-toggle');
      btn.textContent = label;
      var on = settings.enabledChordTypes.indexOf(id) >= 0;
      if (on) btn.classList.add('chord-toggle-on');
      btn.addEventListener('click', function () {
        var idx = settings.enabledChordTypes.indexOf(id);
        if (idx >= 0) settings.enabledChordTypes.splice(idx, 1);
        else settings.enabledChordTypes.push(id);
        saveSettings();
        btn.classList.toggle('chord-toggle-on');
      });
      grid.appendChild(btn);
    });
    rootEl.appendChild(grid);
  }

  function numField(label, key, min, max, step) {
    var w = h('label', 'field');
    w.appendChild(h('span', 'field-label', label));
    var input = document.createElement('input');
    input.type = 'number';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(settings[key]);
    input.addEventListener('change', function () {
      var v = parseInt(input.value, 10);
      if (!isNaN(v)) {
        settings[key] = Math.max(min, Math.min(max, v));
        saveSettings();
      }
    });
    w.appendChild(input);
    return w;
  }

  function selectField(label, key, options) {
    var w = h('label', 'field');
    w.appendChild(h('span', 'field-label', label));
    var sel = document.createElement('select');
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      if (settings[key] === o.value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      settings[key] = sel.value;
      saveSettings();
    });
    w.appendChild(sel);
    return w;
  }

  function checkboxField(label, key) {
    var w = h('label', 'field field-check');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings[key];
    cb.addEventListener('change', function () {
      settings[key] = cb.checked;
      saveSettings();
    });
    w.appendChild(cb);
    w.appendChild(h('span', 'field-label', label));
    return w;
  }

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ───── Wake lock during a quiz session (best-effort) ─────
  var wakeLock = null;
  async function tryWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.error('wakeLock request failed:', err);
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !wakeLock) tryWakeLock();
  });

  // ───── Boot ─────
  document.addEventListener('DOMContentLoaded', function () {
    viewEl = document.getElementById('view');

    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { navigate(b.dataset.route); });
    });

    window.addEventListener('hashchange', render);
    render();
    tryWakeLock();

    // Register service worker.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function (err) {
        console.error('SW register failed:', err);
      });
    }
  });

  // Public API for other modules.
  window.App = {
    getSettings: function () { return settings; },
    saveSettings: saveSettings,
    navigate: navigate
  };
}());
