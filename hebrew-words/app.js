/** @type {Array<{hebrew: string, translit: string, meaning: string, pos: string, category: string}>} */
const WORDS = [
  // Nature
  { hebrew: 'שֶׁמֶשׁ', translit: 'shémesh', meaning: 'sun', pos: 'noun', category: 'nature' },
  { hebrew: 'יָרֵחַ', translit: 'yarē\'ach', meaning: 'moon', pos: 'noun', category: 'nature' },
  { hebrew: 'כּוֹכָב', translit: 'kokhāv', meaning: 'star', pos: 'noun', category: 'nature' },
  { hebrew: 'יָם', translit: 'yam', meaning: 'sea', pos: 'noun', category: 'nature' },
  { hebrew: 'נָהָר', translit: 'nahār', meaning: 'river', pos: 'noun', category: 'nature' },
  { hebrew: 'הָר', translit: 'har', meaning: 'mountain', pos: 'noun', category: 'nature' },
  { hebrew: 'עֵץ', translit: '\'etz', meaning: 'tree', pos: 'noun', category: 'nature' },
  { hebrew: 'פֶּרַח', translit: 'pérach', meaning: 'flower', pos: 'noun', category: 'nature' },
  { hebrew: 'שָׁמַיִם', translit: 'shamáyim', meaning: 'sky / heavens', pos: 'noun', category: 'nature' },
  { hebrew: 'מַיִם', translit: 'máyim', meaning: 'water', pos: 'noun', category: 'nature' },
  { hebrew: 'אֵשׁ', translit: '\'esh', meaning: 'fire', pos: 'noun', category: 'nature' },
  { hebrew: 'רוּחַ', translit: 'rúach', meaning: 'wind / spirit', pos: 'noun', category: 'nature' },
  { hebrew: 'עָנָן', translit: '\'anān', meaning: 'cloud', pos: 'noun', category: 'nature' },
  { hebrew: 'גֶּשֶׁם', translit: 'géshem', meaning: 'rain', pos: 'noun', category: 'nature' },
  { hebrew: 'שֶׁלֶג', translit: 'shéleg', meaning: 'snow', pos: 'noun', category: 'nature' },
  { hebrew: 'אֲדָמָה', translit: 'adamā', meaning: 'earth / soil', pos: 'noun', category: 'nature' },
  // People & Family
  { hebrew: 'אָב', translit: '\'av', meaning: 'father', pos: 'noun', category: 'people' },
  { hebrew: 'אֵם', translit: '\'em', meaning: 'mother', pos: 'noun', category: 'people' },
  { hebrew: 'אָח', translit: '\'ach', meaning: 'brother', pos: 'noun', category: 'people' },
  { hebrew: 'אָחוֹת', translit: '\'achot', meaning: 'sister', pos: 'noun', category: 'people' },
  { hebrew: 'יֶלֶד', translit: 'yéled', meaning: 'boy / child', pos: 'noun', category: 'people' },
  { hebrew: 'יַלְדָּה', translit: 'yaldā', meaning: 'girl', pos: 'noun', category: 'people' },
  { hebrew: 'אִישׁ', translit: '\'ish', meaning: 'man', pos: 'noun', category: 'people' },
  { hebrew: 'אִשָּׁה', translit: '\'ishā', meaning: 'woman', pos: 'noun', category: 'people' },
  { hebrew: 'חָבֵר', translit: 'chavēr', meaning: 'friend', pos: 'noun', category: 'people' },
  { hebrew: 'מֶלֶךְ', translit: 'mélekh', meaning: 'king', pos: 'noun', category: 'people' },
  { hebrew: 'מַלְכָּה', translit: 'malkā', meaning: 'queen', pos: 'noun', category: 'people' },
  // Body
  { hebrew: 'לֵב', translit: 'lev', meaning: 'heart', pos: 'noun', category: 'body' },
  { hebrew: 'יָד', translit: 'yad', meaning: 'hand', pos: 'noun', category: 'body' },
  { hebrew: 'עַיִן', translit: '\'áyin', meaning: 'eye', pos: 'noun', category: 'body' },
  { hebrew: 'פֶּה', translit: 'peh', meaning: 'mouth', pos: 'noun', category: 'body' },
  { hebrew: 'רֹאשׁ', translit: 'rosh', meaning: 'head', pos: 'noun', category: 'body' },
  { hebrew: 'רֶגֶל', translit: 'régel', meaning: 'foot / leg', pos: 'noun', category: 'body' },
  { hebrew: 'אֹזֶן', translit: '\'ózen', meaning: 'ear', pos: 'noun', category: 'body' },
  { hebrew: 'אַף', translit: '\'af', meaning: 'nose / anger', pos: 'noun', category: 'body' },
  // Animals
  { hebrew: 'כֶּלֶב', translit: 'kélev', meaning: 'dog', pos: 'noun', category: 'animals' },
  { hebrew: 'חָתוּל', translit: 'chatúl', meaning: 'cat', pos: 'noun', category: 'animals' },
  { hebrew: 'צִפּוֹר', translit: 'tsipór', meaning: 'bird', pos: 'noun', category: 'animals' },
  { hebrew: 'דָּג', translit: 'dag', meaning: 'fish', pos: 'noun', category: 'animals' },
  { hebrew: 'סוּס', translit: 'sus', meaning: 'horse', pos: 'noun', category: 'animals' },
  { hebrew: 'אַרְיֵה', translit: 'aryēh', meaning: 'lion', pos: 'noun', category: 'animals' },
  { hebrew: 'נָחָשׁ', translit: 'nachāsh', meaning: 'snake', pos: 'noun', category: 'animals' },
  { hebrew: 'פִּיל', translit: 'pil', meaning: 'elephant', pos: 'noun', category: 'animals' },
  // Places
  { hebrew: 'בַּיִת', translit: 'báyit', meaning: 'house / home', pos: 'noun', category: 'places' },
  { hebrew: 'עִיר', translit: '\'ir', meaning: 'city', pos: 'noun', category: 'places' },
  { hebrew: 'דֶּרֶךְ', translit: 'dérekh', meaning: 'road / way', pos: 'noun', category: 'places' },
  { hebrew: 'שׁוּק', translit: 'shuk', meaning: 'market', pos: 'noun', category: 'places' },
  { hebrew: 'גָּן', translit: 'gan', meaning: 'garden', pos: 'noun', category: 'places' },
  { hebrew: 'בֵּית סֵפֶר', translit: 'beit séfer', meaning: 'school', pos: 'noun', category: 'places' },
  { hebrew: 'בֵּית חוֹלִים', translit: 'beit cholím', meaning: 'hospital', pos: 'noun', category: 'places' },
  // Abstract
  { hebrew: 'שָׁלוֹם', translit: 'shalóm', meaning: 'peace / hello', pos: 'noun', category: 'abstract' },
  { hebrew: 'אַהֲבָה', translit: 'ahavā', meaning: 'love', pos: 'noun', category: 'abstract' },
  { hebrew: 'חַיִּים', translit: 'chayyím', meaning: 'life', pos: 'noun', category: 'abstract' },
  { hebrew: 'שִׂמְחָה', translit: 'simchā', meaning: 'joy', pos: 'noun', category: 'abstract' },
  { hebrew: 'תִּקְוָה', translit: 'tikvā', meaning: 'hope', pos: 'noun', category: 'abstract' },
  { hebrew: 'אֱמוּנָה', translit: '\'emunā', meaning: 'faith / trust', pos: 'noun', category: 'abstract' },
  { hebrew: 'אֱמֶת', translit: '\'emet', meaning: 'truth', pos: 'noun', category: 'abstract' },
  { hebrew: 'חָכְמָה', translit: 'chokhmā', meaning: 'wisdom', pos: 'noun', category: 'abstract' },
  { hebrew: 'כָּבוֹד', translit: 'kavód', meaning: 'honor / glory', pos: 'noun', category: 'abstract' },
  { hebrew: 'חֵרוּת', translit: 'cherút', meaning: 'freedom', pos: 'noun', category: 'abstract' },
  { hebrew: 'שַׁלְוָה', translit: 'shalvā', meaning: 'tranquility', pos: 'noun', category: 'abstract' },
  // Objects
  { hebrew: 'סֵפֶר', translit: 'séfer', meaning: 'book', pos: 'noun', category: 'objects' },
  { hebrew: 'לֶחֶם', translit: 'léchem', meaning: 'bread', pos: 'noun', category: 'objects' },
  { hebrew: 'כֶּסֶף', translit: 'késef', meaning: 'money / silver', pos: 'noun', category: 'objects' },
  { hebrew: 'זָהָב', translit: 'zahāv', meaning: 'gold', pos: 'noun', category: 'objects' },
  { hebrew: 'שִׁיר', translit: 'shir', meaning: 'song / poem', pos: 'noun', category: 'objects' },
  { hebrew: 'אוֹר', translit: '\'or', meaning: 'light', pos: 'noun', category: 'objects' },
  { hebrew: 'כֶּלִי', translit: 'kli', meaning: 'vessel / tool', pos: 'noun', category: 'objects' },
  { hebrew: 'מִכְתָּב', translit: 'miktāv', meaning: 'letter', pos: 'noun', category: 'objects' },
  // Time
  { hebrew: 'זְמַן', translit: 'zmán', meaning: 'time', pos: 'noun', category: 'time' },
  { hebrew: 'יוֹם', translit: 'yom', meaning: 'day', pos: 'noun', category: 'time' },
  { hebrew: 'לַיְלָה', translit: 'láyla', meaning: 'night', pos: 'noun', category: 'time' },
  { hebrew: 'שָׁנָה', translit: 'shanā', meaning: 'year', pos: 'noun', category: 'time' },
  { hebrew: 'חֹדֶשׁ', translit: 'chódesh', meaning: 'month / new moon', pos: 'noun', category: 'time' },
  { hebrew: 'שָׁבוּעַ', translit: 'shavúa', meaning: 'week', pos: 'noun', category: 'time' },
  { hebrew: 'בֹּקֶר', translit: 'bóker', meaning: 'morning', pos: 'noun', category: 'time' },
  { hebrew: 'עֶרֶב', translit: '\'érev', meaning: 'evening', pos: 'noun', category: 'time' },
];

const CATEGORY_LABELS = {
  nature: 'Nature', people: 'People & Family', body: 'Body',
  animals: 'Animals', places: 'Places', abstract: 'Abstract',
  objects: 'Objects', time: 'Time',
};

const categorySelect = document.getElementById('category-select');
const card = document.getElementById('card');
const wordHebrew = document.getElementById('word-hebrew');
const wordTranslit = document.getElementById('word-translit');
const wordMeaning = document.getElementById('word-meaning');
const wordPos = document.getElementById('word-pos');
const wordCategory = document.getElementById('word-category');
const generateBtn = document.getElementById('generate-btn');
const copyBtn = document.getElementById('copy-btn');
const historyEl = document.getElementById('history');

let history = [];
let lastWord = null;

function getPool() {
  const cat = categorySelect.value;
  return cat === 'all' ? WORDS : WORDS.filter(w => w.category === cat);
}

/** Pick a random word, avoiding immediate repeat. */
function pickWord() {
  const pool = getPool();
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  let word;
  do { word = pool[Math.floor(Math.random() * pool.length)]; }
  while (word === lastWord);
  return word;
}

function showWord(word) {
  lastWord = word;
  wordHebrew.textContent = word.hebrew;
  wordTranslit.textContent = word.translit;
  wordMeaning.textContent = word.meaning;
  wordPos.textContent = word.pos;
  wordCategory.textContent = CATEGORY_LABELS[word.category] || word.category;

  card.classList.remove('flash');
  // Force reflow to restart animation
  void card.offsetWidth;
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
    chip.textContent = word.hebrew;
    chip.title = word.meaning;
    chip.setAttribute('lang', 'he');
    chip.addEventListener('click', () => showWord(word));
    historyEl.appendChild(chip);
  });
}

generateBtn.addEventListener('click', () => {
  const word = pickWord();
  if (word) showWord(word);
});

categorySelect.addEventListener('change', () => {
  const word = pickWord();
  if (word) showWord(word);
});

copyBtn.addEventListener('click', () => {
  if (!lastWord) return;
  navigator.clipboard.writeText(lastWord.hebrew).then(() => {
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 1500);
  }).catch(err => console.error('Copy failed:', err));
});

// Show a word on load
showWord(pickWord());
