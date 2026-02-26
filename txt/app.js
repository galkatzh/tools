(function () {
  'use strict';

  // ── DOM Refs ────────────────────────────────────────────────────────

  const input = document.getElementById('input');
  const els = {
    chars:         document.getElementById('stat-chars'),
    charsNoSpaces: document.getElementById('stat-chars-no-spaces'),
    words:         document.getElementById('stat-words'),
    lines:         document.getElementById('stat-lines'),
    sentences:     document.getElementById('stat-sentences'),
    paragraphs:    document.getElementById('stat-paragraphs'),
    tokens:        document.getElementById('stat-tokens'),
    compressed:    document.getElementById('stat-compressed'),
    readingTime:   document.getElementById('reading-time'),
    speakingTime:  document.getElementById('speaking-time'),
    avgWordLen:    document.getElementById('avg-word-len'),
    uniqueWords:   document.getElementById('unique-words'),
    vocabRichness: document.getElementById('vocab-richness'),
    fkGrade:       document.getElementById('fk-grade'),
    fkGradeLabel:  document.getElementById('fk-grade-label'),
    freScore:      document.getElementById('fre-score'),
    freLabel:      document.getElementById('fre-label'),
    wordList:      document.getElementById('word-list'),
    chart:         document.getElementById('chart'),
  };

  // ── Text Helpers ────────────────────────────────────────────────────

  /** Extract words (sequences of word-like characters, including contractions). */
  function getWords(text) {
    return text.match(/[a-zA-Z']+/g) || [];
  }

  /** Count sentences by terminal punctuation clusters. */
  function countSentences(text) {
    const m = text.match(/[.!?]+/g);
    return m ? m.length : 0;
  }

  /** Count paragraphs (non-empty blocks separated by blank lines). */
  function countParagraphs(text) {
    if (!text.trim()) return 0;
    return text.split(/\n\s*\n/).filter(p => p.trim()).length;
  }

  /**
   * Estimate syllable count using a vowel-group heuristic.
   * 1. Strip non-alpha, count groups of consecutive vowels (aeiouy)
   * 2. Subtract 1 for a trailing silent 'e'
   * 3. Minimum 1 syllable per word
   */
  function countSyllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (w.length <= 2) return 1;
    const groups = w.match(/[aeiouy]+/g);
    if (!groups) return 1;
    let count = groups.length;
    if (w.endsWith('e')) count--;
    return Math.max(1, count);
  }

  // ── Readability ─────────────────────────────────────────────────────

  function fleschReadingEase(words, sentences, syllables) {
    return 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
  }

  function fleschKincaidGrade(words, sentences, syllables) {
    return 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
  }

  /** Convert grade number to ordinal string: 1→"1st", 2→"2nd", etc. */
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function gradeLabel(grade) {
    if (grade < 1) return 'Kindergarten';
    if (grade < 13) return ordinal(Math.round(grade)) + ' Grade';
    if (grade < 17) return 'College';
    return 'Graduate';
  }

  function easeLabel(score) {
    if (score >= 90) return 'Very Easy';
    if (score >= 80) return 'Easy';
    if (score >= 70) return 'Fairly Easy';
    if (score >= 60) return 'Standard';
    if (score >= 50) return 'Fairly Difficult';
    if (score >= 30) return 'Difficult';
    return 'Very Confusing';
  }

  // ── Formatting ──────────────────────────────────────────────────────

  /**
   * Format minutes to a human-readable duration.
   * <1 min → "X sec", <60 min → "X min Y sec", else → "X hr Y min"
   */
  function formatTime(minutes) {
    if (minutes < 1) return Math.round(minutes * 60) + ' sec';
    if (minutes < 60) {
      const m = Math.floor(minutes);
      const s = Math.round((minutes - m) * 60);
      return s > 0 ? m + ' min ' + s + ' sec' : m + ' min';
    }
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h + ' hr ' + m + ' min';
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Histogram Helpers ───────────────────────────────────────────────

  /** Friendly labels for whitespace characters. */
  const WHITESPACE_LABELS = {
    ' ': 'SP', '\t': 'TAB', '\n': 'NL', '\r': 'CR',
  };

  /**
   * Build character frequency data: letters a-z (always present),
   * plus any non-letter characters found in the text.
   * Returns { letters: [[label, count]], others: [[label, count]] }.
   */
  function charFrequency(text) {
    const letterCounts = {};
    for (let i = 0; i < 26; i++) letterCounts[String.fromCharCode(97 + i)] = 0;

    const otherCounts = {};
    const lower = text.toLowerCase();

    for (const ch of lower) {
      if (ch >= 'a' && ch <= 'z') {
        letterCounts[ch]++;
      } else {
        const label = WHITESPACE_LABELS[ch] || ch;
        otherCounts[label] = (otherCounts[label] || 0) + 1;
      }
    }

    const letters = Object.entries(letterCounts);
    // Sort non-letters by frequency descending
    const others = Object.entries(otherCounts).sort((a, b) => b[1] - a[1]);
    return { letters, others };
  }

  // ── Rendering ───────────────────────────────────────────────────────

  function renderTopWords(words) {
    if (!words.length) {
      els.wordList.innerHTML = '<li class="empty">No words yet</li>';
      return;
    }
    const freq = {};
    for (const w of words) {
      const l = w.toLowerCase();
      freq[l] = (freq[l] || 0) + 1;
    }
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
    els.wordList.innerHTML = sorted
      .map(([word, count]) =>
        `<li><span class="word-text">${escapeHtml(word)}</span><span class="word-count">${count}</span></li>`)
      .join('');
  }

  function renderHistogram(text) {
    const { letters, others } = charFrequency(text);
    const all = [...letters, ...others];
    const max = Math.max(1, ...all.map(e => e[1]));

    let html = '';
    for (const [label, count] of letters) {
      const pct = (count / max) * 100;
      html += `<div class="bar-col"><div class="bar bar-letter" style="height:${pct}%" title="${label}: ${count}"></div><span class="bar-label">${label}</span></div>`;
    }

    if (others.length) {
      html += '<div class="bar-gap"></div>';
      for (const [label, count] of others) {
        const pct = (count / max) * 100;
        html += `<div class="bar-col"><div class="bar bar-other" style="height:${pct}%" title="${escapeHtml(label)}: ${count}"></div><span class="bar-label">${escapeHtml(label)}</span></div>`;
      }
    }

    els.chart.innerHTML = html;
  }

  // ── Main Analysis ───────────────────────────────────────────────────

  function analyze() {
    const text = input.value;
    const chars = text.length;
    const charsNoSpaces = text.replace(/\s/g, '').length;
    const words = getWords(text);
    const wordCount = words.length;
    const lines = text ? text.split('\n').length : 0;
    const sentences = countSentences(text);
    const paragraphs = countParagraphs(text);
    const tokens = Math.round(chars / 4);

    // LZ compression
    let compressedLen = 0;
    let ratio = '';
    if (chars > 0 && typeof LZString !== 'undefined') {
      const compressed = LZString.compressToUint8Array(text);
      compressedLen = compressed.length;
      ratio = ' (' + Math.round((compressedLen / chars) * 100) + '%)';
    }

    // Stats
    els.chars.textContent = chars.toLocaleString();
    els.charsNoSpaces.textContent = charsNoSpaces.toLocaleString();
    els.words.textContent = wordCount.toLocaleString();
    els.lines.textContent = lines.toLocaleString();
    els.sentences.textContent = sentences.toLocaleString();
    els.paragraphs.textContent = paragraphs.toLocaleString();
    els.tokens.textContent = tokens.toLocaleString();
    els.compressed.textContent = compressedLen.toLocaleString() + ratio;

    // Insights
    els.readingTime.textContent = wordCount ? formatTime(wordCount / 200) : '0 sec';
    els.speakingTime.textContent = wordCount ? formatTime(wordCount / 130) : '0 sec';
    els.avgWordLen.textContent = wordCount
      ? (words.reduce((s, w) => s + w.length, 0) / wordCount).toFixed(1)
      : '0';

    const uniqueSet = new Set(words.map(w => w.toLowerCase()));
    els.uniqueWords.textContent = uniqueSet.size.toLocaleString();
    els.vocabRichness.textContent = wordCount
      ? ((uniqueSet.size / wordCount) * 100).toFixed(1) + '%'
      : '0%';

    // Readability
    if (wordCount > 0 && sentences > 0) {
      const totalSyllables = words.reduce((s, w) => s + countSyllables(w), 0);
      const fkg = fleschKincaidGrade(wordCount, sentences, totalSyllables);
      const fre = fleschReadingEase(wordCount, sentences, totalSyllables);
      els.fkGrade.textContent = fkg.toFixed(1);
      els.fkGradeLabel.textContent = gradeLabel(fkg);
      els.freScore.textContent = fre.toFixed(1);
      els.freLabel.textContent = easeLabel(fre);
    } else {
      els.fkGrade.textContent = '--';
      els.fkGradeLabel.textContent = '';
      els.freScore.textContent = '--';
      els.freLabel.textContent = '';
    }

    renderTopWords(words);
    renderHistogram(text);
  }

  // ── Event Wiring ────────────────────────────────────────────────────

  let timer;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(analyze, 150);
  });

  analyze();

})();
