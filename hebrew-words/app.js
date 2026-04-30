/** @type {string[]} */
let WORDS = [];
let lastWord = null;
let history = [];

const card = document.getElementById('card');
const wordHebrew = document.getElementById('word-hebrew');
const historyEl = document.getElementById('history');

/** Pick a random word, avoiding immediate repeat. */
function pickWord() {
  if (WORDS.length === 0) return null;
  if (WORDS.length === 1) return WORDS[0];
  let word;
  do { word = WORDS[Math.floor(Math.random() * WORDS.length)]; }
  while (word === lastWord);
  return word;
}

function showWord(word) {
  lastWord = word;
  wordHebrew.textContent = word;

  card.classList.remove('flash');
  void card.offsetWidth; // force reflow to restart animation
  card.classList.add('flash');

  addToHistory(word);
}

function addToHistory(word) {
  if (history[0] === word) return;
  history = [word, ...history.slice(0, 9)];
  renderHistory();
}

function renderHistory() {
  historyEl.innerHTML = '';
  history.slice(1).forEach(word => {
    const chip = document.createElement('button');
    chip.className = 'history-chip';
    chip.textContent = word;
    chip.setAttribute('lang', 'he');
    chip.addEventListener('click', e => { e.stopPropagation(); showWord(word); });
    historyEl.appendChild(chip);
  });
}

function next() {
  const word = pickWord();
  if (word) showWord(word);
}

card.addEventListener('click', next);
card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') next(); });

fetch('words.json')
  .then(r => r.json())
  .then(words => {
    WORDS = words;
    next();
  })
  .catch(err => console.error('Failed to load words.json:', err));
