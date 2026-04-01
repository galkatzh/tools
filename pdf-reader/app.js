import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const fileInput = document.querySelector('#pdf-file');
const queryInput = document.querySelector('#query');
const thresholdInput = document.querySelector('#threshold');
const thresholdValue = document.querySelector('#threshold-value');
const resultsEl = document.querySelector('#results');
const statusEl = document.querySelector('#status');

let pages = [];

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    setStatus('Reading PDF...');
    pages = await extractPdfText(file);
    queryInput.disabled = false;
    thresholdInput.disabled = false;
    queryInput.value = '';
    resultsEl.innerHTML = '';
    setStatus(`Indexed ${pages.length} page(s). Enter a query to search.`);
  } catch (error) {
    console.error('Failed to parse PDF', error);
    pages = [];
    queryInput.disabled = true;
    thresholdInput.disabled = true;
    resultsEl.innerHTML = '';
    setStatus('Failed to read the PDF. Check console for details.');
  }
});

queryInput.addEventListener('input', renderSearchResults);
thresholdInput.addEventListener('input', () => {
  thresholdValue.textContent = thresholdInput.value;
  renderSearchResults();
});

async function extractPdfText(file) {
  const bytes = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const extractedPages = [];

  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const rawText = textContent.items.map((item) => item.str).join(' ');
    extractedPages.push({ page: i, text: normalize(rawText), rawText });
    setStatus(`Indexed page ${i}/${pdf.numPages}...`);
  }

  return extractedPages;
}

function renderSearchResults() {
  const query = normalize(queryInput.value.trim());
  const maxDistance = Number(thresholdInput.value);

  if (!query) {
    resultsEl.innerHTML = '';
    setStatus(`Indexed ${pages.length} page(s). Enter a query to search.`);
    return;
  }

  const queryTokens = query.split(/\s+/).filter(Boolean);
  const matches = [];

  for (const page of pages) {
    const pageTokens = page.text.split(/\s+/).filter(Boolean);
    const best = bestTokenWindowMatch(queryTokens, pageTokens, maxDistance);
    if (best) {
      matches.push({ page: page.page, ...best, rawText: page.rawText });
    }
  }

  matches.sort((a, b) => a.distance - b.distance || a.page - b.page);
  render(matches, queryTokens.length);
}

function bestTokenWindowMatch(queryTokens, tokens, maxDistance) {
  const length = queryTokens.length;
  if (!length || tokens.length < length) return null;

  let best = null;
  for (let i = 0; i <= tokens.length - length; i += 1) {
    const windowTokens = tokens.slice(i, i + length);
    const joinedWindow = windowTokens.join(' ');
    const joinedQuery = queryTokens.join(' ');
    const distance = levenshtein(joinedQuery, joinedWindow);

    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = {
        distance,
        startTokenIndex: i,
        endTokenIndex: i + length - 1,
        matchText: joinedWindow,
      };
    }
  }

  return best;
}

function render(matches, queryTokenCount) {
  resultsEl.innerHTML = '';
  if (!matches.length) {
    setStatus('No fuzzy matches found. Increase "Max distance" or adjust the query.');
    return;
  }

  setStatus(`Found ${matches.length} matching page(s).`);

  const fragment = document.createDocumentFragment();
  for (const match of matches.slice(0, 100)) {
    const item = document.createElement('li');
    item.className = 'result';

    const title = document.createElement('strong');
    title.textContent = `Page ${match.page}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `Distance: ${match.distance}`;

    const snippet = document.createElement('p');
    snippet.innerHTML = buildSnippet(match.rawText, match.matchText, queryTokenCount);

    item.append(title, meta, snippet);
    fragment.append(item);
  }

  resultsEl.append(fragment);
}

function buildSnippet(rawText, normalizedMatchText, queryTokenCount) {
  const rawTokens = rawText.split(/\s+/).filter(Boolean);
  const normalizedTokens = rawTokens.map(normalize);
  const needleTokens = normalizedMatchText.split(/\s+/);

  let start = normalizedTokens.findIndex((_, i) => {
    const candidate = normalizedTokens.slice(i, i + needleTokens.length);
    return candidate.join(' ') === needleTokens.join(' ');
  });

  if (start < 0) start = 0;
  const left = Math.max(0, start - 12);
  const right = Math.min(rawTokens.length, start + queryTokenCount + 12);

  const view = rawTokens.slice(left, right).join(' ');
  const escapedView = escapeHtml(view);
  const escapedNeedle = escapeRegExp(rawTokens.slice(start, start + queryTokenCount).join(' '));

  if (!escapedNeedle) return `${escapedView}${right < rawTokens.length ? '…' : ''}`;

  const highlighted = escapedView.replace(new RegExp(escapedNeedle, 'i'), '<mark>$&</mark>');
  return `${left > 0 ? '…' : ''}${highlighted}${right < rawTokens.length ? '…' : ''}`;
}

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[a.length][b.length];
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setStatus(message) {
  statusEl.textContent = message;
}
