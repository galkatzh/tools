'use strict';

/* Niche Radar — client-side market-demand research dashboard.
 * Everything is fetched live from free, CORS-enabled public APIs:
 * Wikimedia pageviews, HN Algolia, GitHub search, npm registry,
 * Datamuse, and Google autocomplete (JSONP, since it has no CORS).
 * Reddit blocks browser CORS entirely, so Reddit research is offered
 * as prefilled link-outs instead of live panels.
 */

// ---------- global error visibility ----------

const toastEl = document.getElementById('toast');
let toastTimer;
function showToast(msg) {
  toastEl.textContent = String(msg);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 8000);
}
window.addEventListener('error', e => { console.error(e.error || e.message); showToast(`Error: ${e.message}`); });
window.addEventListener('unhandledrejection', e => { console.error(e.reason); showToast(`Error: ${e.reason?.message || e.reason}`); });

// ---------- small utilities ----------

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const enc = encodeURIComponent;

async function fetchJSON(url, retries = 2) {
  const res = await fetch(url);
  if (res.status === 429 && retries > 0) {
    // Rate-limited (Wikipedia does this on busy IPs) — back off and retry.
    await new Promise(r => setTimeout(r, (3 - retries) * 1500));
    return fetchJSON(url, retries - 1);
  }
  if (!res.ok) {
    const detail = await res.json().then(b => b.message).catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${detail ? `(${detail}) ` : ''}— ${url}`);
  }
  return res.json();
}

// JSONP loader for APIs without CORS (Google autocomplete).
let jsonpId = 0;
function jsonp(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const cb = `__nicheRadarCb${++jsonpId}`;
    const script = document.createElement('script');
    const timer = setTimeout(() => fail(new Error(`JSONP timeout: ${url}`)), timeoutMs);
    function cleanup() { clearTimeout(timer); delete window[cb]; script.remove(); }
    function fail(err) { cleanup(); reject(err); }
    window[cb] = data => { cleanup(); resolve(data); };
    script.onerror = () => fail(new Error(`JSONP failed to load: ${url}`));
    script.src = `${url}&jsonp=${cb}`;
    document.head.appendChild(script);
  });
}

/** Percent change between the mean of the last `w` values and the `w` before them. */
function pctChange(values, w) {
  if (values.length < w * 2) return null;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const prev = mean(values.slice(-2 * w, -w));
  if (!prev) return null;
  return Math.round(((mean(values.slice(-w)) - prev) / prev) * 100);
}

/** Render a trend badge (▲/▼/≈) into a panel's <span class="badge">. */
function setBadge(panelId, pct, label) {
  const el = $(`#${panelId} .badge`);
  if (pct === null) { el.className = 'badge flat'; el.textContent = '–'; return; }
  const cls = pct > 10 ? 'up' : pct < -10 ? 'down' : 'flat';
  const arrow = pct > 10 ? '▲' : pct < -10 ? '▼' : '≈';
  el.className = `badge ${cls}`;
  el.textContent = `${arrow} ${pct > 0 ? '+' : ''}${pct}% ${label}`;
}

// ---------- tiny SVG charts ----------

function lineChart(values, firstLabel, lastLabel) {
  const W = 300, H = 80, P = 4;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [
    P + (i * (W - 2 * P)) / Math.max(values.length - 1, 1),
    H - P - (v / max) * (H - 2 * P - 12),
  ]);
  const line = pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polygon points="${P},${H - P} ${line} ${W - P},${H - P}" fill="rgba(88,166,255,.15)"/>
    <polyline points="${line}" fill="none" stroke="#58a6ff" stroke-width="2"/>
    <text x="${P}" y="${H - P + 2}" font-size="9" fill="#8b949e">${esc(firstLabel)}</text>
    <text x="${W - P}" y="${H - P + 2}" font-size="9" fill="#8b949e" text-anchor="end">${esc(lastLabel)}</text>
  </svg>`;
}

function barChart(values, firstLabel, lastLabel) {
  const W = 300, H = 80, P = 4, gap = 3;
  const max = Math.max(...values, 1);
  const bw = (W - 2 * P) / values.length - gap;
  const bars = values.map((v, i) => {
    const h = (v / max) * (H - 2 * P - 12);
    return `<rect x="${(P + i * (bw + gap)).toFixed(1)}" y="${(H - P - 12 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#58a6ff"/>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}
    <text x="${P}" y="${H - P + 2}" font-size="9" fill="#8b949e">${esc(firstLabel)}</text>
    <text x="${W - P}" y="${H - P + 2}" font-size="9" fill="#8b949e" text-anchor="end">${esc(lastLabel)}</text>
  </svg>`;
}

// ---------- panel plumbing ----------

// Generation counter: a new search invalidates renders from older, slower fetches.
let gen = 0;

function panelBody(id) { return $(`#${id} .body`); }

/** Run an async renderer for one panel; failures are logged AND shown in the panel. */
async function runPanel(id, myGen, renderer) {
  const body = panelBody(id);
  body.innerHTML = '<div class="loading">Loading</div>';
  try {
    const html = await renderer();
    if (myGen === gen) body.innerHTML = html;
  } catch (err) {
    console.error(`Panel ${id} failed:`, err);
    if (myGen === gen) body.innerHTML = `<div class="error">Failed: ${esc(err.message || err)}</div>`;
  }
}

function listHTML(items) {
  return `<ul class="list">${items.map(i =>
    `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a><span class="meta">${esc(i.meta || '')}</span></li>`
  ).join('')}</ul>`;
}

// ---------- query panels ----------

async function wikiPanel(q) {
  // Full-text search ranks by relevance (opensearch is prefix-only and picks odd articles).
  const search = await fetchJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(q)}&srlimit=1&format=json&origin=*`);
  const title = search.query.search[0]?.title;
  if (!title) { setBadge('panel-wiki', null); return '<div class="muted">No matching Wikipedia article — too niche for an encyclopedia, or try a broader term.</div>'; }

  // Last 24 complete months of pageviews for the best-matching article.
  const now = new Date();
  const ym = (d, day) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${day}00`;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 24, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // last day of previous month
  const data = await fetchJSON(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${enc(title.replace(/ /g, '_'))}/monthly/${ym(start, '01')}/${ym(end, String(end.getUTCDate()).padStart(2, '0'))}`);
  const views = data.items.map(i => i.views);
  const label = ts => `${ts.slice(4, 6)}/${ts.slice(2, 4)}`;
  setBadge('panel-wiki', pctChange(views, 3), 'last 3 mo');
  return `
    <div>Article: <a href="https://en.wikipedia.org/wiki/${enc(title.replace(/ /g, '_'))}" target="_blank" rel="noopener">${esc(title)}</a>
      — <b>${fmt(views.at(-1) ?? 0)}</b> views last month</div>
    ${lineChart(views, label(data.items[0].timestamp), label(data.items.at(-1).timestamp))}
    <div class="note">Monthly Wikipedia pageviews — an open, rate-limit-free proxy for topic interest (a Google Trends alternative).</div>`;
}

async function hnPanel(q) {
  // Story counts in eight 90-day windows + the top stories of the past year.
  const DAY = 86400, now = Math.floor(Date.now() / 1000);
  const windows = Array.from({ length: 8 }, (_, i) => {
    const a = now - (8 - i) * 90 * DAY;
    return [a, a + 90 * DAY];
  });
  const countURL = ([a, b]) =>
    `https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story&hitsPerPage=0&numericFilters=created_at_i>=${a},created_at_i<${b}`;
  const [counts, top] = await Promise.all([
    Promise.all(windows.map(w => fetchJSON(countURL(w)).then(r => r.nbHits))),
    fetchJSON(`https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story&hitsPerPage=5&numericFilters=created_at_i>=${now - 365 * DAY}`),
  ]);
  setBadge('panel-hn', pctChange(counts, 2), 'last 6 mo');
  const monthLabel = ts => new Date(ts * 1000).toLocaleDateString('en', { month: 'short', year: '2-digit' });
  const stories = top.hits.map(h => ({
    title: h.title,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    meta: `${h.points}▲ · ${h.num_comments ?? 0}💬`,
  }));
  return `
    <div>Stories mentioning “${esc(q)}”, per 90-day window:</div>
    ${barChart(counts, monthLabel(windows[0][0]), monthLabel(now))}
    ${stories.length ? `<div class="muted">Top stories, past year:</div>${listHTML(stories)}` : '<div class="muted">No HN stories in the past year.</div>'}`;
}

async function githubPanel(q) {
  const d = days => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const search = params => fetchJSON(`https://api.github.com/search/repositories?${params}`);
  const [topRepos, fresh, prior] = await Promise.all([
    search(`q=${enc(`${q} in:name,description`)}&sort=stars&order=desc&per_page=5`),
    search(`q=${enc(`${q} created:>${d(90)}`)}&sort=stars&order=desc&per_page=5`),
    search(`q=${enc(`${q} created:${d(180)}..${d(90)}`)}&per_page=1`),
  ]);
  const growth = prior.total_count ? Math.round(((fresh.total_count - prior.total_count) / prior.total_count) * 100) : null;
  setBadge('panel-gh', growth, 'new repos');
  const repoList = repos => listHTML(repos.map(r => ({ title: r.full_name, url: r.html_url, meta: `★ ${fmt(r.stargazers_count)}` })));
  return `
    <div><b>${fmt(topRepos.total_count)}</b> repos match · <b>${fmt(fresh.total_count)}</b> created in the last 90 days (vs ${fmt(prior.total_count)} the 90 before)</div>
    <div class="muted">Top repos:</div>${repoList(topRepos.items)}
    ${fresh.items.length ? `<div class="muted">Hot &amp; new (90 days):</div>${repoList(fresh.items)}` : ''}
    <div class="note">Developer attention is a leading indicator for tech niches.</div>`;
}

async function npmPanel(q) {
  const found = await fetchJSON(`https://registry.npmjs.org/-/v1/search?text=${enc(q)}&size=20`);
  // npm search is fuzzy and returns unrelated packages for non-dev queries;
  // require every query word to actually appear in the package metadata.
  const words = q.toLowerCase().split(/\s+/);
  const pkgs = found.objects.map(o => o.package).filter(p => {
    const hay = `${p.name} ${p.description || ''} ${(p.keywords || []).join(' ')}`.toLowerCase();
    return words.every(w => hay.includes(w));
  }).slice(0, 5);
  if (!pkgs.length) { setBadge('panel-npm', null); return '<div class="muted">No npm packages match — probably not a developer-tool niche.</div>'; }
  const range = await fetchJSON(`https://api.npmjs.org/downloads/range/last-year/${enc(pkgs[0].name)}`);
  // Bucket daily downloads into trailing 7-day weeks (drop the incomplete oldest one).
  const daily = range.downloads.map(x => x.downloads);
  const weeks = [];
  for (let end = daily.length; end - 7 >= 0; end -= 7) weeks.unshift(daily.slice(end - 7, end).reduce((s, x) => s + x, 0));
  setBadge('panel-npm', pctChange(weeks, 12), 'last quarter');
  return `
    <div>Weekly downloads of top match <a href="https://www.npmjs.com/package/${enc(pkgs[0].name)}" target="_blank" rel="noopener">${esc(pkgs[0].name)}</a>:</div>
    ${lineChart(weeks, range.start.slice(0, 7), range.end.slice(0, 7))}
    ${listHTML(pkgs.map(p => ({ title: p.name, url: `https://www.npmjs.com/package/${p.name}`, meta: p.description?.slice(0, 40) || '' })))}
    <div class="note">Package downloads are a clean adoption signal for developer-facing niches.</div>`;
}

async function questionsPanel(q) {
  // AnswerThePublic-style fan-out over Google autocomplete.
  const groups = [
    ['How', `how ${q}`], ['What', `what ${q}`], ['Why', `why ${q}`], ['Can', `can ${q}`],
    ['Best', `best ${q}`], ['Versus', `${q} vs`], ['For', `${q} for`], ['Alternatives', `${q} alternative`],
  ];
  const results = await Promise.all(groups.map(async ([label, seed]) => {
    const data = await jsonp(`https://suggestqueries.google.com/complete/search?client=youtube&q=${enc(seed)}`);
    const suggestions = [...new Set(data[1].map(s => s[0]).filter(s => s !== seed))].slice(0, 8);
    return [label, suggestions];
  }));
  const nonEmpty = results.filter(([, s]) => s.length);
  if (!nonEmpty.length) return '<div class="muted">No autocomplete suggestions found.</div>';
  return `<div class="columns">${nonEmpty.map(([label, suggestions]) => `
    <div class="qgroup"><h3>${esc(label)}</h3><ul>${suggestions.map(s =>
      `<li><a href="https://www.google.com/search?q=${enc(s)}" target="_blank" rel="noopener">${esc(s)}</a></li>`).join('')}</ul></div>`).join('')}</div>
    <div class="note">What people literally type into Google — the raw voice of demand.</div>`;
}

async function relatedPanel(q) {
  const words = await fetchJSON(`https://api.datamuse.com/words?ml=${enc(q)}&max=15`);
  if (!words.length) return '<div class="muted">No related concepts found.</div>';
  return `<div class="chips">${words.map(w =>
    `<span class="chip" data-q="${esc(w.word)}">${esc(w.word)}</span>`).join('')}</div>
    <div class="note">Click a concept to research it. Semantic neighbours often hide less-crowded sub-niches.</div>`;
}

function linksPanel(q) {
  const e = enc(q);
  const links = [
    ['Google Trends', `https://trends.google.com/trends/explore?q=${e}`, 'relative search interest'],
    ['Reddit search', `https://www.reddit.com/search/?q=${e}`, 'communities & pain points'],
    ['Map of Reddit', 'https://anvaka.github.io/map-of-reddit/', 'discover adjacent subreddits'],
    ['Subreddit Stats', 'https://subredditstats.com/', 'size & growth of a subreddit'],
    ['HN Algolia', `https://hn.algolia.com/?q=${e}`, 'full HN archive'],
    ['Product Hunt', `https://www.producthunt.com/search?q=${e}`, 'who is already building this'],
    ['Meta Ad Library', `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&q=${e}`, 'who is paying to sell this'],
    ['Amazon search', `https://www.amazon.com/s?k=${e}`, 'purchase-intent landscape'],
    ['Amazon Movers & Shakers', 'https://www.amazon.com/gp/movers-and-shakers', 'biggest 24h sales-rank gainers'],
    ['eBay', `https://www.ebay.com/sch/i.html?_nkw=${e}`, 'resale demand'],
    ['YouTube', `https://www.youtube.com/results?search_query=${e}`, 'content supply & views'],
    ['TikTok Creative Center', 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en', 'trending hashtags & products'],
    ['Answer Socrates', 'https://answersocrates.com/', 'deep question research'],
    ['Exploding Topics', 'https://explodingtopics.com/', 'trends before they peak'],
    ['F5Bot', 'https://f5bot.com/', 'free keyword alerts (Reddit/HN)'],
  ];
  return `<ul class="list">${links.map(([name, url, what]) =>
    `<li><a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a><span class="meta">${esc(what)}</span></li>`).join('')}</ul>`;
}

// ---------- pulse panels (no query) ----------

async function pulseWiki() {
  const d = new Date(Date.now() - 2 * 864e5); // top-views data lags ~1 day; go 2 back to be safe
  const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  const data = await fetchJSON(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${path}`);
  const articles = data.items[0].articles
    .filter(a => !a.article.includes(':') && a.article !== 'Main_Page')
    .slice(0, 10);
  return listHTML(articles.map(a => ({
    title: a.article.replace(/_/g, ' '),
    url: `https://en.wikipedia.org/wiki/${enc(a.article)}`,
    meta: `${fmt(a.views)} views`,
  })));
}

async function pulseHN() {
  const data = await fetchJSON('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10');
  return listHTML(data.hits.map(h => ({
    title: h.title,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    meta: `${h.points}▲`,
  })));
}

async function pulseGitHub() {
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const data = await fetchJSON(`https://api.github.com/search/repositories?q=${enc(`created:>${since}`)}&sort=stars&order=desc&per_page=10`);
  return listHTML(data.items.map(r => ({ title: r.full_name, url: r.html_url, meta: `★ ${fmt(r.stargazers_count)}` })));
}

// ---------- orchestration ----------

const RECENT_KEY = 'nicheRadar.recent';

function renderRecent() {
  const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  $('#recent').innerHTML = recent.map(q => `<span class="chip" data-q="${esc(q)}">${esc(q)}</span>`).join('');
}

function rememberSearch(q) {
  const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(x => x !== q);
  recent.unshift(q);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 8)));
  renderRecent();
}

function research(q) {
  q = q.trim();
  $('#q').value = q;
  const myGen = ++gen;
  if (!q) {
    history.replaceState(null, '', location.pathname);
    $('#results').hidden = true;
    $('#pulse').hidden = false;
    runPanel('pulse-wiki', myGen, pulseWiki);
    runPanel('pulse-hn', myGen, pulseHN);
    runPanel('pulse-gh', myGen, pulseGitHub);
    return;
  }
  history.replaceState(null, '', `#q=${enc(q)}`);
  rememberSearch(q);
  document.querySelectorAll('#results .badge').forEach(b => { b.className = 'badge'; b.textContent = ''; });
  $('#pulse').hidden = true;
  $('#results').hidden = false;
  runPanel('panel-wiki', myGen, () => wikiPanel(q));
  runPanel('panel-hn', myGen, () => hnPanel(q));
  runPanel('panel-gh', myGen, () => githubPanel(q));
  runPanel('panel-npm', myGen, () => npmPanel(q));
  runPanel('panel-questions', myGen, () => questionsPanel(q));
  runPanel('panel-related', myGen, () => relatedPanel(q));
  runPanel('panel-links', myGen, async () => linksPanel(q));
}

$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  research($('#q').value);
});

// Clicking any chip (recent search or related concept) researches it.
document.addEventListener('click', e => {
  const chip = e.target.closest('.chip[data-q]');
  if (chip) research(chip.dataset.q);
});

window.addEventListener('hashchange', () => {
  const q = new URLSearchParams(location.hash.slice(1)).get('q') || '';
  if (q !== $('#q').value.trim()) research(q);
});

renderRecent();
research(new URLSearchParams(location.hash.slice(1)).get('q') || '');
