'use strict';

/* Niche Radar — client-side market-demand research dashboard.
 * Everything is fetched live from free, CORS-enabled public APIs:
 * Wikimedia pageviews, HN Algolia, GitHub search, npm registry,
 * Datamuse, and Google autocomplete (JSONP, since it has no CORS).
 * Reddit and Google News RSS block browser CORS, so those panels work
 * through a user-supplied CORS proxy (e.g. a free Cloudflare Worker)
 * configured in ⚙ settings; without one they explain how to set it up.
 * Comma-separated queries switch to a side-by-side comparison view.
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
const PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#f778ba'];

async function fetchRes(url, retries = 2) {
  const res = await fetch(url);
  if (res.status === 429 && retries > 0) {
    // Rate-limited (Wikipedia does this on busy IPs) — back off and retry.
    await new Promise(r => setTimeout(r, (3 - retries) * 1500));
    return fetchRes(url, retries - 1);
  }
  if (!res.ok) {
    const detail = await res.text().then(t => JSON.parse(t).message).catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${detail ? `(${detail}) ` : ''}— ${url}`);
  }
  return res;
}
const fetchJSON = async url => (await fetchRes(url)).json();
const fetchText = async url => (await fetchRes(url)).text();

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

// ---------- CORS proxy (for Reddit & Google News) ----------

const PROXY_KEY = 'nicheRadar.proxy';
const getProxy = () => localStorage.getItem(PROXY_KEY) || '';

/** Wrap a URL with the configured proxy: `{url}` placeholder or prefix style. */
function proxied(url) {
  const p = getProxy();
  if (!p) throw new Error('No CORS proxy configured');
  return p.includes('{url}') ? p.replace('{url}', enc(url)) : p + enc(url);
}

const PROXY_HINT = `<div class="muted">Reddit and Google News don't allow direct browser requests.
  <a href="#" class="open-settings">Configure a CORS proxy</a> (a free Cloudflare Worker works) to enable this panel.</div>`;

// ---------- tiny SVG charts ----------

const CHART = { W: 300, H: 80, P: 4 };

function chartFrame(inner, firstLabel, lastLabel) {
  const { W, H, P } = CHART;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${inner}
    <text x="${P}" y="${H - P + 2}" font-size="9" fill="#8b949e">${esc(firstLabel)}</text>
    <text x="${W - P}" y="${H - P + 2}" font-size="9" fill="#8b949e" text-anchor="end">${esc(lastLabel)}</text>
  </svg>`;
}

function linePoints(values, max) {
  const { W, H, P } = CHART;
  const bottom = H - P - 12; // keep clear of the label strip
  return values.map((v, i) => [
    P + (i * (W - 2 * P)) / Math.max(values.length - 1, 1),
    bottom - (v / max) * (bottom - P),
  ].map(n => n.toFixed(1)).join(',')).join(' ');
}

function lineChart(values, firstLabel, lastLabel) {
  const { W, H, P } = CHART;
  const bottom = H - P - 12;
  const pts = linePoints(values, Math.max(...values, 1));
  return chartFrame(`
    <polygon points="${P},${bottom} ${pts} ${W - P},${bottom}" fill="rgba(88,166,255,.15)"/>
    <polyline points="${pts}" fill="none" stroke="#58a6ff" stroke-width="2"/>`, firstLabel, lastLabel);
}

/** Overlay several series on one shared-scale chart. series: [{values, color}] */
function multiLineChart(series, firstLabel, lastLabel) {
  const max = Math.max(1, ...series.flatMap(s => s.values));
  return chartFrame(series.map(s =>
    `<polyline points="${linePoints(s.values, max)}" fill="none" stroke="${s.color}" stroke-width="2"/>`
  ).join(''), firstLabel, lastLabel);
}

function barChart(values, firstLabel, lastLabel) {
  const { W, H, P } = CHART;
  const gap = 3;
  const max = Math.max(...values, 1);
  const bw = (W - 2 * P) / values.length - gap;
  return chartFrame(values.map((v, i) => {
    const h = (v / max) * (H - 2 * P - 12);
    return `<rect x="${(P + i * (bw + gap)).toFixed(1)}" y="${(H - P - 12 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#58a6ff"/>`;
  }).join(''), firstLabel, lastLabel);
}

function legendHTML(entries) {
  return `<div class="legend">${entries.map(e =>
    `<span><i class="dot" style="background:${e.color}"></i>${esc(e.label)}${e.note ? ` <span class="muted">· ${esc(e.note)}</span>` : ''}</span>`).join('')}</div>`;
}

// ---------- panel plumbing ----------

// Generation counter: a new search invalidates renders from older, slower fetches.
let gen = 0;

/** Run an async renderer for one panel; failures are logged AND shown in the panel. */
async function runPanel(id, myGen, renderer) {
  const body = $(`#${id} .body`);
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

// ---------- shared data fetchers (single + comparison views) ----------

/** Keys ("yyyymm") and API bounds for the last 24 complete months. */
function monthRange() {
  const now = new Date();
  const keys = [];
  for (let i = 24; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // last day of previous month
  return { keys, start: `${keys[0]}0100`, end: `${keys.at(-1)}${String(end.getUTCDate()).padStart(2, '0')}00` };
}
const monthKeyLabel = k => `${k.slice(4)}/${k.slice(2, 4)}`;

/** Best-matching Wikipedia article title, or undefined. Full-text search ranks by relevance. */
async function wikiBestTitle(q) {
  const data = await fetchJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(q)}&srlimit=1&format=json&origin=*`);
  return data.query.search[0]?.title;
}

/** Monthly pageviews aligned to monthRange keys (0 for missing months). */
async function wikiMonthly(title, range) {
  const data = await fetchJSON(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${enc(title.replace(/ /g, '_'))}/monthly/${range.start}/${range.end}`);
  const byMonth = Object.fromEntries(data.items.map(i => [i.timestamp.slice(0, 6), i.views]));
  return range.keys.map(k => byMonth[k] ?? 0);
}

/** Eight 90-day [from, to) unix-second windows ending now. */
function hnWindows() {
  const DAY = 86400, now = Math.floor(Date.now() / 1000);
  return Array.from({ length: 8 }, (_, i) => {
    const a = now - (8 - i) * 90 * DAY;
    return [a, a + 90 * DAY];
  });
}

function hnCounts(q, windows) {
  return Promise.all(windows.map(([a, b]) =>
    fetchJSON(`https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story&hitsPerPage=0&numericFilters=created_at_i>=${a},created_at_i<${b}`)
      .then(r => r.nbHits)));
}

const ghSearch = params => fetchJSON(`https://api.github.com/search/repositories?${params}`);
const daysAgo = days => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

/** Most relevant npm packages: registry search is fuzzy and returns unrelated
 * packages for non-dev queries, so require every query word in the metadata. */
async function npmTopPkgs(q) {
  const found = await fetchJSON(`https://registry.npmjs.org/-/v1/search?text=${enc(q)}&size=20`);
  const words = q.toLowerCase().split(/\s+/);
  return found.objects.map(o => o.package).filter(p => {
    const hay = `${p.name} ${p.description || ''} ${(p.keywords || []).join(' ')}`.toLowerCase();
    return words.every(w => hay.includes(w));
  }).slice(0, 5);
}

/** Trailing 7-day download sums for the last year (oldest incomplete week dropped). */
async function npmWeekly(name) {
  const range = await fetchJSON(`https://api.npmjs.org/downloads/range/last-year/${enc(name)}`);
  const daily = range.downloads.map(x => x.downloads);
  const weeks = [];
  for (let end = daily.length; end - 7 >= 0; end -= 7) weeks.unshift(daily.slice(end - 7, end).reduce((s, x) => s + x, 0));
  return { weeks, first: range.start.slice(0, 7), last: range.end.slice(0, 7) };
}

// ---------- single-query panels ----------

async function wikiPanel(q) {
  const title = await wikiBestTitle(q);
  if (!title) { setBadge('panel-wiki', null); return '<div class="muted">No matching Wikipedia article — too niche for an encyclopedia, or try a broader term.</div>'; }
  const range = monthRange();
  const views = await wikiMonthly(title, range);
  setBadge('panel-wiki', pctChange(views, 3), 'last 3 mo');
  return `
    <div>Article: <a href="https://en.wikipedia.org/wiki/${enc(title.replace(/ /g, '_'))}" target="_blank" rel="noopener">${esc(title)}</a>
      — <b>${fmt(views.at(-1) ?? 0)}</b> views last month</div>
    ${lineChart(views, monthKeyLabel(range.keys[0]), monthKeyLabel(range.keys.at(-1)))}
    <div class="note">Monthly Wikipedia pageviews — an open, rate-limit-free proxy for topic interest (a Google Trends alternative).</div>`;
}

async function hnPanel(q) {
  const windows = hnWindows();
  const now = windows.at(-1)[1];
  const [counts, top] = await Promise.all([
    hnCounts(q, windows),
    fetchJSON(`https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story&hitsPerPage=5&numericFilters=created_at_i>=${now - 365 * 86400}`),
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
  const [topRepos, fresh, prior] = await Promise.all([
    ghSearch(`q=${enc(`${q} in:name,description`)}&sort=stars&order=desc&per_page=5`),
    ghSearch(`q=${enc(`${q} created:>${daysAgo(90)}`)}&sort=stars&order=desc&per_page=5`),
    ghSearch(`q=${enc(`${q} created:${daysAgo(180)}..${daysAgo(90)}`)}&per_page=1`),
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
  const pkgs = await npmTopPkgs(q);
  if (!pkgs.length) { setBadge('panel-npm', null); return '<div class="muted">No npm packages match — probably not a developer-tool niche.</div>'; }
  const { weeks, first, last } = await npmWeekly(pkgs[0].name);
  setBadge('panel-npm', pctChange(weeks, 12), 'last quarter');
  return `
    <div>Weekly downloads of top match <a href="https://www.npmjs.com/package/${enc(pkgs[0].name)}" target="_blank" rel="noopener">${esc(pkgs[0].name)}</a>:</div>
    ${lineChart(weeks, first, last)}
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

async function redditSubsPanel(q) {
  if (!getProxy()) return PROXY_HINT;
  const data = await fetchJSON(proxied(`https://www.reddit.com/subreddits/search.json?q=${enc(q)}&limit=8&raw_json=1`));
  const subs = data.data.children.map(c => c.data).filter(s => !s.over18);
  if (!subs.length) return '<div class="muted">No matching subreddits.</div>';
  return listHTML(subs.map(s => ({
    title: `r/${s.display_name}`,
    url: `https://www.reddit.com${s.url}`,
    meta: `${fmt(s.subscribers ?? 0)} members`,
  }))) + '<div class="note">Community size ≈ addressable audience. Adjacent subreddits hide sub-niches.</div>';
}

async function redditPostsPanel(q) {
  if (!getProxy()) return PROXY_HINT;
  const data = await fetchJSON(proxied(`https://www.reddit.com/search.json?q=${enc(q)}&sort=top&t=year&limit=8&raw_json=1`));
  const posts = data.data.children.map(c => c.data).filter(p => !p.over_18);
  if (!posts.length) return '<div class="muted">No Reddit posts in the past year.</div>';
  return listHTML(posts.map(p => ({
    title: p.title,
    url: `https://www.reddit.com${p.permalink}`,
    meta: `r/${p.subreddit} · ${fmt(p.score)}▲`,
  }))) + '<div class="note">Top posts of the year — pain points and recommendations in the community\'s own words.</div>';
}

async function newsPanel(q) {
  if (!getProxy()) return PROXY_HINT;
  const xml = await fetchText(proxied(`https://news.google.com/rss/search?q=${enc(q)}&hl=en-US&gl=US&ceid=US:en`));
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse Google News RSS (is the proxy returning the raw response?)');
  const items = [...doc.querySelectorAll('item')].slice(0, 8).map(it => ({
    title: it.querySelector('title')?.textContent || '(untitled)',
    url: it.querySelector('link')?.textContent || '#',
    meta: new Date(it.querySelector('pubDate')?.textContent || '').toLocaleDateString('en', { month: 'short', day: 'numeric' }),
  }));
  if (!items.length) return '<div class="muted">No recent news coverage.</div>';
  return listHTML(items) + '<div class="note">Press coverage signals mainstream momentum (Google News).</div>';
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

// ---------- comparison panels (query = "a, b, c") ----------

async function cmpWikiPanel(terms) {
  const range = monthRange();
  const series = await Promise.all(terms.map(async (t, i) => {
    const title = await wikiBestTitle(t);
    if (!title) return { label: t, color: PALETTE[i], values: range.keys.map(() => 0), note: 'no article' };
    const values = await wikiMonthly(title, range);
    return { label: t, color: PALETTE[i], values, note: `${title} · ${fmt(values.at(-1))}/mo` };
  }));
  return legendHTML(series)
    + multiLineChart(series, monthKeyLabel(range.keys[0]), monthKeyLabel(range.keys.at(-1)))
    + '<div class="note">Monthly Wikipedia pageviews, shared scale.</div>';
}

async function cmpHNPanel(terms) {
  const windows = hnWindows();
  const series = await Promise.all(terms.map(async (t, i) => {
    const values = await hnCounts(t, windows);
    return { label: t, color: PALETTE[i], values, note: `${values.at(-1)} last 90d` };
  }));
  const monthLabel = ts => new Date(ts * 1000).toLocaleDateString('en', { month: 'short', year: '2-digit' });
  return legendHTML(series)
    + multiLineChart(series, monthLabel(windows[0][0]), monthLabel(windows.at(-1)[1]))
    + '<div class="note">Hacker News stories per 90-day window.</div>';
}

async function cmpNpmPanel(terms) {
  const series = await Promise.all(terms.map(async (t, i) => {
    const pkgs = await npmTopPkgs(t);
    if (!pkgs.length) return { label: t, color: PALETTE[i], values: [], note: 'no package' };
    const { weeks } = await npmWeekly(pkgs[0].name);
    return { label: t, color: PALETTE[i], values: weeks, note: `${pkgs[0].name} · ${fmt(weeks.at(-1))}/wk` };
  }));
  const withData = series.filter(s => s.values.length);
  if (!withData.length) return '<div class="muted">No npm packages match any term.</div>';
  return legendHTML(series)
    + multiLineChart(withData, 'a year ago', 'now')
    + '<div class="note">Weekly downloads of each term\'s top npm package, shared scale.</div>';
}

async function cmpGitHubPanel(terms) {
  const stats = await Promise.all(terms.map(async t => {
    const [all, fresh] = await Promise.all([
      ghSearch(`q=${enc(`${t} in:name,description`)}&per_page=1`),
      ghSearch(`q=${enc(`${t} created:>${daysAgo(90)}`)}&per_page=1`),
    ]);
    return { total: all.total_count, fresh: fresh.total_count };
  }));
  return `<table class="cmp"><thead><tr><th></th><th>repos</th><th>new (90d)</th></tr></thead><tbody>${terms.map((t, i) =>
    `<tr><td><i class="dot" style="background:${PALETTE[i]}"></i>${esc(t)}</td><td>${fmt(stats[i].total)}</td><td>${fmt(stats[i].fresh)}</td></tr>`).join('')}</tbody></table>
    <div class="note">Matching repositories and how many were created in the last 90 days.</div>`;
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
  const data = await ghSearch(`q=${enc(`created:>${daysAgo(14)}`)}&sort=stars&order=desc&per_page=10`);
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

function showView(name) {
  for (const id of ['pulse', 'results', 'compare']) $(`#${id}`).hidden = id !== name;
}

function research(q) {
  q = q.trim();
  $('#q').value = q;
  const myGen = ++gen;
  const terms = q.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);

  if (!terms.length) {
    history.replaceState(null, '', location.pathname);
    showView('pulse');
    runPanel('pulse-wiki', myGen, pulseWiki);
    runPanel('pulse-hn', myGen, pulseHN);
    runPanel('pulse-gh', myGen, pulseGitHub);
    return;
  }

  history.replaceState(null, '', `#q=${enc(q)}`);
  rememberSearch(q);

  if (terms.length > 1) {
    showView('compare');
    runPanel('cmp-wiki', myGen, () => cmpWikiPanel(terms));
    runPanel('cmp-hn', myGen, () => cmpHNPanel(terms));
    runPanel('cmp-npm', myGen, () => cmpNpmPanel(terms));
    runPanel('cmp-gh', myGen, () => cmpGitHubPanel(terms));
    return;
  }

  showView('results');
  document.querySelectorAll('#results .badge').forEach(b => { b.className = 'badge'; b.textContent = ''; });
  runPanel('panel-wiki', myGen, () => wikiPanel(q));
  runPanel('panel-hn', myGen, () => hnPanel(q));
  runPanel('panel-gh', myGen, () => githubPanel(q));
  runPanel('panel-npm', myGen, () => npmPanel(q));
  runPanel('panel-questions', myGen, () => questionsPanel(q));
  runPanel('panel-related', myGen, () => relatedPanel(q));
  runPanel('panel-reddit-subs', myGen, () => redditSubsPanel(q));
  runPanel('panel-reddit-posts', myGen, () => redditPostsPanel(q));
  runPanel('panel-news', myGen, () => newsPanel(q));
  runPanel('panel-links', myGen, async () => linksPanel(q));
}

// ---------- settings dialog ----------

const settingsDialog = $('#settings');

function openSettings() {
  $('#proxy-input').value = getProxy();
  settingsDialog.showModal();
}

$('#settings-btn').addEventListener('click', openSettings);
$('#proxy-save').addEventListener('click', () => {
  const value = $('#proxy-input').value.trim();
  if (value) localStorage.setItem(PROXY_KEY, value);
  else localStorage.removeItem(PROXY_KEY);
  settingsDialog.close();
  research($('#q').value); // re-run so proxy-gated panels pick up the change
});
$('#proxy-cancel').addEventListener('click', () => settingsDialog.close());

// ---------- events ----------

$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  research($('#q').value);
});

// Clicking any chip (recent search / related concept) researches it;
// "configure proxy" links open settings.
document.addEventListener('click', e => {
  const chip = e.target.closest('.chip[data-q]');
  if (chip) research(chip.dataset.q);
  const open = e.target.closest('.open-settings');
  if (open) { e.preventDefault(); openSettings(); }
});

window.addEventListener('hashchange', () => {
  const q = new URLSearchParams(location.hash.slice(1)).get('q') || '';
  if (q !== $('#q').value.trim()) research(q);
});

renderRecent();
research(new URLSearchParams(location.hash.slice(1)).get('q') || '');
