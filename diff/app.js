'use strict';

const $ = id => document.getElementById(id);
const inputA = $('input-a');
const inputB = $('input-b');
const output = $('output');
const modes = document.querySelectorAll('input[name="mode"]');
let timer;

/* ── Myers diff ────────────────────────────────────────
 * Optimal shortest-edit-script algorithm (same family as git diff).
 * Operates on arbitrary sequences; returns [op, value] pairs
 * where op: 0 = equal, -1 = delete, 1 = insert.
 * ───────────────────────────────────────────────────── */

function diff(a, b) {
  const n = a.length, m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map(v => [1, v]);
  if (!m) return a.map(v => [-1, v]);

  const max = n + m, off = max;
  const v = new Int32Array(2 * max + 1);
  v[off + 1] = 0;
  const trace = [];

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]))
        ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Backtrack to recover edit operations
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const tv = trace[d], k = x - y;
    const pk = (k === -d || (k !== d && tv[off + k - 1] < tv[off + k + 1]))
      ? k + 1 : k - 1;
    const px = tv[off + pk], py = px - pk;
    while (x > px && y > py) { x--; y--; ops.push([0, a[x]]); }
    if (d > 0) {
      if (x === px) { y--; ops.push([1, b[y]]); }
      else { x--; ops.push([-1, a[x]]); }
    }
  }
  return ops.reverse();
}

/** Group consecutive same-type operations for cleaner rendering */
function group(ops) {
  const g = [];
  for (const [op, val] of ops) {
    const last = g[g.length - 1];
    if (last && last[0] === op) last[1].push(val);
    else g.push([op, [val]]);
  }
  return g;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── Character-level diff ──────────────────────────── */

function renderChar(a, b) {
  const ops = diff([...a], [...b]);
  const groups = group(ops);
  let add = 0, del = 0, eq = 0;

  const html = groups.map(([op, chars]) => {
    const t = esc(chars.join(''));
    if (op === 0)  { eq  += chars.length; return t; }
    if (op === -1) { del += chars.length; return `<span class="del">${t}</span>`; }
    add += chars.length; return `<span class="ins">${t}</span>`;
  }).join('');

  return { html: `<pre class="char-diff">${html || '&nbsp;'}</pre>`, add, del, eq };
}

/* ── Intra-line character markup for paired del/ins lines ── */

function intraLine(oldLine, newLine) {
  const groups = group(diff([...oldLine], [...newLine]));
  const delParts = [], insParts = [];
  for (const [op, chars] of groups) {
    const t = esc(chars.join(''));
    if (op === 0)       { delParts.push(t); insParts.push(t); }
    else if (op === -1) delParts.push(`<span class="hl">${t}</span>`);
    else                insParts.push(`<span class="hl">${t}</span>`);
  }
  return { del: delParts.join(''), ins: insParts.join('') };
}

/* ── Line-level diff with intra-line highlighting ──── */

function renderLine(a, b) {
  const linesA = a.split('\n'), linesB = b.split('\n');
  const groups = group(diff(linesA, linesB));

  let add = 0, del = 0, eq = 0, numA = 0, numB = 0;
  const rows = [];

  for (let i = 0; i < groups.length; i++) {
    const [op, lines] = groups[i];

    if (op === 0) {
      for (const l of lines) {
        numA++; numB++; eq++;
        rows.push(`<tr class="eq"><td class="ln">${numA}</td><td class="ln">${numB}</td><td class="code">${esc(l)}</td></tr>`);
      }
    } else if (op === -1) {
      // Pair with following insert block for intra-line highlighting
      const next = groups[i + 1];
      const ins = next && next[0] === 1 ? next[1] : null;

      if (ins) {
        const pairs = Math.min(lines.length, ins.length);
        for (let j = 0; j < pairs; j++) {
          const hl = intraLine(lines[j], ins[j]);
          numA++; del++;
          rows.push(`<tr class="del"><td class="ln">${numA}</td><td class="ln"></td><td class="code">${hl.del}</td></tr>`);
          numB++; add++;
          rows.push(`<tr class="ins"><td class="ln"></td><td class="ln">${numB}</td><td class="code">${hl.ins}</td></tr>`);
        }
        for (let j = pairs; j < lines.length; j++) {
          numA++; del++;
          rows.push(`<tr class="del"><td class="ln">${numA}</td><td class="ln"></td><td class="code">${esc(lines[j])}</td></tr>`);
        }
        for (let j = pairs; j < ins.length; j++) {
          numB++; add++;
          rows.push(`<tr class="ins"><td class="ln"></td><td class="ln">${numB}</td><td class="code">${esc(ins[j])}</td></tr>`);
        }
        i++; // skip the paired insert group
      } else {
        for (const l of lines) {
          numA++; del++;
          rows.push(`<tr class="del"><td class="ln">${numA}</td><td class="ln"></td><td class="code">${esc(l)}</td></tr>`);
        }
      }
    } else {
      for (const l of lines) {
        numB++; add++;
        rows.push(`<tr class="ins"><td class="ln"></td><td class="ln">${numB}</td><td class="code">${esc(l)}</td></tr>`);
      }
    }
  }

  const html = rows.length
    ? `<table class="line-diff"><tbody>${rows.join('')}</tbody></table>`
    : '';
  return { html, add, del, eq };
}

/* ── UI wiring ─────────────────────────────────────── */

function mode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function update() {
  const a = inputA.value, b = inputB.value;

  if (!a && !b) {
    output.innerHTML = '<p class="empty">Enter text in both fields to see the diff.</p>';
    $('stat-added').textContent = '0';
    $('stat-removed').textContent = '0';
    $('stat-unchanged').textContent = '0';
    return;
  }

  const r = mode() === 'char' ? renderChar(a, b) : renderLine(a, b);

  if (r.add === 0 && r.del === 0) {
    output.innerHTML = '<p class="identical">Texts are identical.</p>';
  } else {
    output.innerHTML = r.html;
  }

  $('stat-added').textContent = r.add;
  $('stat-removed').textContent = r.del;
  $('stat-unchanged').textContent = r.eq;
}

function debounced() {
  clearTimeout(timer);
  timer = setTimeout(update, 120);
}

inputA.addEventListener('input', debounced);
inputB.addEventListener('input', debounced);
modes.forEach(r => r.addEventListener('change', update));

$('swap-btn').addEventListener('click', () => {
  [inputA.value, inputB.value] = [inputB.value, inputA.value];
  update();
});

update();
