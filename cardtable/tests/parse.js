// Parse-checks the app's ES modules as real modules (catches what a Function()
// check misses, e.g. a stray `await` or a duplicate export): app.js, the
// rules Worker (rules-worker.js: app.js starts it by URL, never imports it)
// and every local module they import, recursively, so a new module is
// checked as soon as it is imported. Every local import, and index.html's
// app.js and style.css, must carry the code version (MODULE_V in core.js,
// "?v=1"): one left behind pairs a cached file of the previous version with
// this one after a deploy (§0.2, D306).
// Usage: node --experimental-vm-modules parse.js [entry.js ...]   (default: cardtable/app.js and rules-worker.js)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(process.env.APP_ROOT || path.join(__dirname, '../..'), 'cardtable');
const todo = process.argv.length > 2 ? process.argv.slice(2).map((f) => path.resolve(f)) : ['app.js', 'rules-worker.js'].map((f) => path.join(APP, f));
const seen = new Set();
const V = `?v=${/export const MODULE_V = (\d+);/.exec(fs.readFileSync(path.join(APP, 'core.js'), 'utf8'))[1]}`;
let bad = 0;
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
for (const f of ['app.js', 'style.css']) {
  if (!html.includes(`${f}${V}`)) { bad++; console.error(`VERSION: index.html loads ${f} without ${V}`); }
}
while (todo.length) {
  const f = todo.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  try {
    const m = new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f });
    // (a local specifier carries the module version, "./core.js?v=1": the file is the path)
    for (const s of m.dependencySpecifiers.filter((s) => /^\.\.?\//.test(s))) {
      if (!s.endsWith(V)) { bad++; console.error(`VERSION: ${path.relative(APP, f)} imports ${s} without ${V}`); }
      todo.push(path.resolve(path.dirname(f), s.replace(/\?.*$/, '')));
    }
    console.log('parses:', path.relative(APP, f));
  } catch (e) {
    bad++;
    console.error('PARSE ERROR', f, e.message, e.stack.split('\n')[1]);
  }
}
process.exit(bad ? 1 : 0);
