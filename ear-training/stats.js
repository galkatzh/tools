// IndexedDB-backed stats: each attempt is recorded; aggregations rendered
// for a 7-day window. Exposes a global `Stats` object.
(function () {
  'use strict';

  var DB_NAME = 'ear-training';
  var DB_VERSION = 1;
  var STORE = 'attempts';

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('ts', 'ts', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () {
        console.error('IndexedDB open failed:', req.error);
        reject(req.error);
      };
    });
    return dbPromise;
  }

  /**
   * Record a single attempt. `record` shape:
   *   { type: 'melody'|'chord', subtype?: string, correct: boolean, details?: any }
   * `ts` and `id` are added automatically.
   */
  function recordAttempt(record) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        var entry = Object.assign({ ts: Date.now() }, record);
        var req = store.add(entry);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () {
          console.error('recordAttempt failed:', req.error);
          reject(req.error);
        };
      });
    }).catch(function (err) {
      // Stats failures must not block gameplay, but must be logged.
      console.error('recordAttempt error:', err);
    });
  }

  /** Get all attempts in the [fromTs, toTs) window (ms). */
  function getRange(fromTs, toTs) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var idx = tx.objectStore(STORE).index('ts');
        var range = IDBKeyRange.bound(fromTs, toTs, false, true);
        var out = [];
        var cursorReq = idx.openCursor(range);
        cursorReq.onsuccess = function () {
          var cur = cursorReq.result;
          if (cur) { out.push(cur.value); cur.continue(); }
          else resolve(out);
        };
        cursorReq.onerror = function () {
          console.error('getRange failed:', cursorReq.error);
          reject(cursorReq.error);
        };
      });
    });
  }

  /** Format Date -> "YYYY-MM-DD" in the user's local timezone. */
  function dateKey(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /**
   * Aggregate the last 7 days (including today). Returns:
   *   {
   *     days: [{date, label, melody:{n, correct}, chord:{n, correct}}, ...],
   *     totals: {melody:{n, correct}, chord:{n, correct}},
   *     byChordType: { 'maj':{n, correct}, ... },  // last 7d
   *     streak: { current, dayStreak }
   *   }
   */
  function weeklyAggregate() {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var fromTs = today.getTime() - 6 * 86400000; // start of 7 days ago
    var toTs = today.getTime() + 86400000;       // end of today

    return getRange(fromTs, toTs).then(function (rows) {
      var days = [];
      for (var i = 6; i >= 0; i--) {
        var d = new Date(today.getTime() - i * 86400000);
        days.push({
          date: dateKey(d),
          label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
          melody: { n: 0, correct: 0 },
          chord: { n: 0, correct: 0 }
        });
      }
      var byDay = {};
      days.forEach(function (d) { byDay[d.date] = d; });

      var byChordType = {};
      var totals = { melody: { n: 0, correct: 0 }, chord: { n: 0, correct: 0 } };

      rows.forEach(function (r) {
        var d = new Date(r.ts);
        var key = dateKey(d);
        var bucket = byDay[key];
        if (!bucket) return;
        var bin = bucket[r.type];
        if (!bin) return;
        bin.n++;
        if (r.correct) bin.correct++;
        totals[r.type].n++;
        if (r.correct) totals[r.type].correct++;

        if (r.type === 'chord' && r.subtype) {
          var ct = byChordType[r.subtype] || (byChordType[r.subtype] = { n: 0, correct: 0 });
          ct.n++;
          if (r.correct) ct.correct++;
        }
      });

      // Streaks: trailing correct attempts; consecutive days with any attempt.
      var sorted = rows.slice().sort(function (a, b) { return a.ts - b.ts; });
      var current = 0;
      for (var j = sorted.length - 1; j >= 0; j--) {
        if (sorted[j].correct) current++; else break;
      }
      var dayStreak = 0;
      for (var k = days.length - 1; k >= 0; k--) {
        if (days[k].melody.n + days[k].chord.n > 0) dayStreak++;
        else break;
      }

      return {
        days: days,
        totals: totals,
        byChordType: byChordType,
        streak: { current: current, dayStreak: dayStreak }
      };
    });
  }

  /** Export everything as JSON (for backup). */
  function exportAll() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () {
          console.error('exportAll failed:', req.error);
          reject(req.error);
        };
      });
    });
  }

  /** Wipe all attempts. */
  function clearAll() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var req = tx.objectStore(STORE).clear();
        req.onsuccess = function () { resolve(); };
        req.onerror = function () {
          console.error('clearAll failed:', req.error);
          reject(req.error);
        };
      });
    });
  }

  window.Stats = {
    recordAttempt: recordAttempt,
    getRange: getRange,
    weeklyAggregate: weeklyAggregate,
    exportAll: exportAll,
    clearAll: clearAll
  };
}());
