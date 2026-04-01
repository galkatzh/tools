import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const fileInput = document.querySelector('#pdf-file');
const queryInput = document.querySelector('#query');
const thresholdInput = document.querySelector('#threshold');
const thresholdValue = document.querySelector('#threshold-value');
const resultsEl = document.querySelector('#results');
const statusEl = document.querySelector('#status');
const viewerEl = document.querySelector('#viewer');
const pageLabelEl = document.querySelector('#page-label');
const matchLabelEl = document.querySelector('#match-label');
const prevPageBtn = document.querySelector('#prev-page');
const nextPageBtn = document.querySelector('#next-page');
const prevMatchBtn = document.querySelector('#prev-match');
const nextMatchBtn = document.querySelector('#next-match');

let pdfDoc = null;
let pages = [];
let matches = [];
let currentPage = 1;
let currentMatch = -1;

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    setStatus('Reading PDF...');
    const bytes = await file.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    pages = await extractPages(pdfDoc);

    currentPage = 1;
    matches = [];
    currentMatch = -1;

    queryInput.disabled = false;
    thresholdInput.disabled = false;
    prevPageBtn.disabled = false;
    nextPageBtn.disabled = false;

    await renderPage(currentPage);
    renderMatches();
    setStatus(`Indexed ${pages.length} page(s). Type a query to fuzzy-search.`);
  } catch (error) {
    console.error('Failed to parse PDF', error);
    pdfDoc = null;
    pages = [];
    matches = [];
    currentMatch = -1;
    viewerEl.innerHTML = '';
    queryInput.disabled = true;
    thresholdInput.disabled = true;
    prevPageBtn.disabled = true;
    nextPageBtn.disabled = true;
    prevMatchBtn.disabled = true;
    nextMatchBtn.disabled = true;
    setStatus('Failed to read the PDF. Check console for details.');
  }

  updateLabels();
});

queryInput.addEventListener('input', runSearch);
thresholdInput.addEventListener('input', () => {
  thresholdValue.textContent = thresholdInput.value;
  runSearch();
});
prevPageBtn.addEventListener('click', () => goToPage(currentPage - 1));
nextPageBtn.addEventListener('click', () => goToPage(currentPage + 1));
prevMatchBtn.addEventListener('click', () => goToMatch(currentMatch - 1));
nextMatchBtn.addEventListener('click', () => goToMatch(currentMatch + 1));

async function extractPages(pdf) {
  const extracted = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const rawText = textContent.items.map((item) => item.str).join(' ');
    const rawTokens = rawText.split(/\s+/).filter(Boolean);
    extracted.push({
      page: i,
      rawText,
      rawTokens,
      normalizedTokens: rawTokens.map(normalize),
    });
    setStatus(`Indexed page ${i}/${pdf.numPages}...`);
  }
  return extracted;
}

function runSearch() {
  const query = normalize(queryInput.value.trim());
  const maxDistance = Number(thresholdInput.value);

  if (!query || !pages.length) {
    matches = [];
    currentMatch = -1;
    renderMatches();
    setStatus(pages.length ? 'Enter a query to fuzzy-search the PDF.' : 'Load a PDF to begin.');
    updateLabels();
    return;
  }

  const queryTokens = query.split(/\s+/).filter(Boolean);
  const found = [];

  for (const page of pages) {
    const pageMatches = fuzzyMatchesInPage(page, queryTokens, maxDistance);
    found.push(...pageMatches);
  }

  matches = found.sort((a, b) => a.distance - b.distance || a.page - b.page || a.start - b.start);
  currentMatch = matches.length ? 0 : -1;

  renderMatches();
  if (currentMatch >= 0) {
    goToMatch(0);
  } else {
    setStatus('No fuzzy matches found. Increase max distance or change query.');
    updateLabels();
  }
}

function fuzzyMatchesInPage(page, queryTokens, maxDistance) {
  const out = [];
  const n = queryTokens.length;
  if (page.normalizedTokens.length < n) return out;

  const joinedQuery = queryTokens.join(' ');
  for (let i = 0; i <= page.normalizedTokens.length - n; i += 1) {
    const windowTokens = page.normalizedTokens.slice(i, i + n);
    const distance = levenshtein(joinedQuery, windowTokens.join(' '));
    if (distance <= maxDistance) {
      const rawNeedle = page.rawTokens.slice(i, i + n).join(' ');
      out.push({
        page: page.page,
        start: i,
        length: n,
        distance,
        needle: rawNeedle,
        snippet: buildSnippet(page.rawTokens, i, n),
      });
      i += Math.max(0, n - 2);
    }
  }

  return out;
}

function renderMatches() {
  resultsEl.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const li = document.createElement('li');
    li.className = `result${i === currentMatch ? ' active' : ''}`;
    li.innerHTML = `<strong>Page ${match.page}</strong><div class="meta">Distance: ${match.distance}</div><p>${match.snippet}</p>`;
    li.addEventListener('click', () => goToMatch(i));
    fragment.append(li);
  }

  resultsEl.append(fragment);
  prevMatchBtn.disabled = !matches.length;
  nextMatchBtn.disabled = !matches.length;
  updateLabels();
}

async function goToPage(pageNumber) {
  if (!pdfDoc) return;
  currentPage = Math.max(1, Math.min(pdfDoc.numPages, pageNumber));
  await renderPage(currentPage);
  updateLabels();
}

async function goToMatch(matchIndex) {
  if (!matches.length) return;
  const wrapped = ((matchIndex % matches.length) + matches.length) % matches.length;
  currentMatch = wrapped;

  const match = matches[currentMatch];
  currentPage = match.page;
  await renderPage(currentPage, match);

  document.querySelectorAll('.result').forEach((node, i) => {
    node.classList.toggle('active', i === currentMatch);
  });

  setStatus(`Showing result ${currentMatch + 1}/${matches.length} on page ${match.page}.`);
  updateLabels();
}

async function renderPage(pageNumber, activeMatch = null) {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.35 });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  const shell = document.createElement('article');
  shell.className = 'page-shell';
  shell.append(canvas);

  if (activeMatch && activeMatch.page === pageNumber) {
    const matchNote = document.createElement('p');
    matchNote.className = 'page-match';
    matchNote.innerHTML = `<strong>Current result:</strong> ${activeMatch.snippet}`;
    shell.append(matchNote);
  }

  viewerEl.replaceChildren(shell);
}

function buildSnippet(tokens, start, length) {
  const left = Math.max(0, start - 12);
  const right = Math.min(tokens.length, start + length + 12);
  const prefix = tokens.slice(left, start).join(' ');
  const hit = tokens.slice(start, start + length).join(' ');
  const suffix = tokens.slice(start + length, right).join(' ');

  return `${left > 0 ? '…' : ''}${escapeHtml(prefix)} ${hit ? `<mark>${escapeHtml(hit)}</mark>` : ''} ${escapeHtml(suffix)}${right < tokens.length ? '…' : ''}`.replace(/\s+/g, ' ').trim();
}

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function updateLabels() {
  const totalPages = pdfDoc?.numPages ?? 0;
  pageLabelEl.textContent = `Page ${totalPages ? currentPage : 0} / ${totalPages}`;
  matchLabelEl.textContent = `Result ${matches.length ? currentMatch + 1 : 0} / ${matches.length}`;
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
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
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

function setStatus(message) {
  statusEl.textContent = message;
}
