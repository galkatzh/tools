const markdownInput = document.getElementById('markdown-input');
const macrosInput = document.getElementById('macros-input');
const renderedOutput = document.getElementById('rendered-output');
const macroError = document.getElementById('macro-error');
const urlStatus = document.getElementById('url-status');
const toggleEditorBtn = document.getElementById('toggle-editor');
const getUrlBtn = document.getElementById('get-url');
const editorPanel = document.getElementById('editor-panel');

const DEFAULT_MARKDOWN = `# Markdown + Math\n\nUse standard markdown plus TeX math delimiters.\n\nInline: $a^2 + b^2 = c^2$\n\nDisplay:\n\n$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}
$$`;

const DEFAULT_MACROS = String.raw`\newcommand{\sparentheses}[1]{\left[#1\right]}
\newcommand{\co}{{\cal O}}
\newcommand{\ca}{{\cal A}}
\newcommand{\cb}{{\cal B}}
\newcommand{\cd}{{\cal D}}
\newcommand{\cdb}{{\cal D}^{\rm b}}
\newcommand{\cc}{{\cal C}}
\newcommand{\ck}{{\cal K}}
\newcommand{\cq}{{\cal Q}}
\newcommand{\ce}{{\cal E}}
\newcommand{\ct}{{\cal T}}
\newcommand{\cg}{{\cal G}}
\newcommand{\ch}{{\cal H}}
\newcommand{\cm}{{\cal M}}
\newcommand{\ci}{{\cal I}}
\newcommand{\cj}{{\cal J}}
\newcommand{\cw}{{\cal W}}
\newcommand{\cl}{{\cal L}}
\newcommand{\cf}{{\cal F}}
\newcommand{\cv}{{\cal V}}
\newcommand{\cp}{{\cal P}}
\newcommand{\cu}{{\cal U}}
\newcommand{\cx}{{\cal X}}
\newcommand{\cy}{{\cal Y}}
\newcommand{\cz}{{\cal Z}}
\newcommand{\cs}{{\cal S}}
\newcommand{\cn}{{\cal N}}
\newcommand{\ccr}{{\cal R}}
\newcommand{\BB}[1]{\mathbb{#1}}
\newcommand{\FF}{\mathbb{F}}
\newcommand{\bW}{\mathbf{W}}
\def\x{\mathbf{x}}
\newcommand{\f}{\mathbf{f}}
\newcommand{\y}{\mathbf{y}}
\newcommand{\z}{\mathbf{z}}
\newcommand{\bt}{\mathbf{t}}
\newcommand{\bw}{\mathbf{w}}
\newcommand{\bv}{\mathbf{v}}
\newcommand{\ba}{\mathbf{a}}
\newcommand{\bu}{\mathbf{u}}
\newcommand{\bc}{\mathbf{c}}
\newcommand{\be}{\mathbf{e}}
\newcommand{\bb}{\mathbf{b}}
\newcommand{\bh}{\mathbf{h}}
\newcommand\ceil[1]{\lceil#1\rceil}
\newcommand{\norm}[1]{\left\lVert#1\right\rVert}
\newcommand{\abs}[1]{\left|#1\right|}
\newcommand{\parentheses}[1]{\left(#1\right)}
\newcommand{\spec}{\mathrm{sp}}
\newcommand{\CC}{\mathcal{C}}
\newcommand{\E}{\mathbb{E}}
\newcommand{\DD}{\mathcal{D}}
\newcommand{\XX}{\mathcal{X}}
\newcommand{\reals}{\mathbb{R}}
\newcommand{\fcnclass}{(\mathbb{R}^d)^\XX}
\newcommand{\cover}[4]{\mathcal{N}_#1(#2, #3, #4)}
\newcommand{\class}[3]{\left[#1\right]_{#2,#3}}
\newcommand{\inner}[1]{{\left\langle #1 \right\rangle}}
\newcommand{\expectation}[1][ ]{\mathbb{E}_{#1}}
\newcommand{\sphere}{\mathbb{S}}
\newcommand{\floor}[1]{\left\lfloor #1 \right\rfloor}
\newcommand{\bracka}[1]{\left[ #1 \right]}
\newcommand{\med}{\mathrm{median}}
\newcommand{\rep}{\mathrm{rep}}
\newcommand{\len}{\mathrm{len}}
\newcommand{\tr}{\mathrm{Tr}}
\newcommand{\var}{\mathrm{Var}}
\newcommand{\adl}{\mathrm{ADL}}
\newcommand{\diag}{\mathrm{diag}}`;

let renderTimer;

function decodeQueryMarkdown() {
  const raw = window.location.search.slice(1);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch {
    return '';
  }
}

function getShareUrl() {
  const encoded = encodeURIComponent(markdownInput.value);
  const suffix = encoded ? `?${encoded}` : '';
  return `${window.location.origin}${window.location.pathname}${suffix}`;
}

function updateQueryString(value) {
  const encoded = encodeURIComponent(value);
  const next = encoded ? `${window.location.pathname}?${encoded}` : window.location.pathname;
  window.history.replaceState({}, '', next);
}

function buildMacroPreludeNode() {
  const macroText = macrosInput.value.trim();
  if (!macroText) {
    return null;
  }

  const preludeNode = document.createElement('span');
  preludeNode.style.display = 'none';
  preludeNode.textContent = `\\(${macroText}\\)`;
  return preludeNode;
}

function protectMathSegments(markdown) {
  const segments = [];
  let protectedMarkdown = '';
  let index = 0;

  while (index < markdown.length) {
    if (markdown[index] !== '$' || markdown[index - 1] === '\\') {
      protectedMarkdown += markdown[index];
      index += 1;
      continue;
    }

    const delimiter = markdown[index + 1] === '$' ? '$$' : '$';
    const start = index;
    let cursor = index + delimiter.length;
    let foundEnd = false;

    while (cursor < markdown.length) {
      if (
        markdown.slice(cursor, cursor + delimiter.length) === delimiter
        && markdown[cursor - 1] !== '\\'
      ) {
        cursor += delimiter.length;
        foundEnd = true;
        break;
      }
      cursor += 1;
    }

    if (!foundEnd) {
      protectedMarkdown += markdown[index];
      index += 1;
      continue;
    }

    const token = `@@MATH${segments.length}@@`;
    segments.push({ token, value: markdown.slice(start, cursor) });
    protectedMarkdown += token;
    index = cursor;
  }

  return { protectedMarkdown, segments };
}

function restoreMathSegments(html, segments) {
  return segments.reduce((currentHtml, segment) => {
    return currentHtml.split(segment.token).join(segment.value);
  }, html);
}

async function render() {
  try {
    const { protectedMarkdown, segments } = protectMathSegments(markdownInput.value);
    const html = marked.parse(protectedMarkdown, {
      gfm: true,
      breaks: true
    });

    renderedOutput.innerHTML = DOMPurify.sanitize(restoreMathSegments(html, segments));

    const preludeNode = buildMacroPreludeNode();
    if (preludeNode) {
      renderedOutput.prepend(preludeNode);
    }

    macroError.textContent = '';
    if (window.MathJax?.typesetPromise) {
      window.MathJax.texReset();
      await window.MathJax.typesetPromise([renderedOutput]);
    }
  } catch (error) {
    macroError.textContent = `Math render error: ${error.message}`;
  }
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    render();
  }, 120);
}

function setEditorHidden(hidden) {
  editorPanel.classList.toggle('hidden', hidden);
  toggleEditorBtn.textContent = hidden ? 'Show editor' : 'Hide editor';
}

async function handleGetUrl() {
  const shareUrl = getShareUrl();
  try {
    await navigator.clipboard.writeText(shareUrl);
    urlStatus.textContent = 'URL copied to clipboard.';
  } catch {
    window.prompt('Copy this URL:', shareUrl);
    urlStatus.textContent = 'Clipboard unavailable; URL shown in prompt.';
  }
}

function init() {
  const markdownFromUrl = decodeQueryMarkdown();
  const hasUrlMarkdown = markdownFromUrl.trim().length > 0;

  markdownInput.value = hasUrlMarkdown ? markdownFromUrl : DEFAULT_MARKDOWN;
  macrosInput.value = DEFAULT_MACROS;
  setEditorHidden(hasUrlMarkdown);

  markdownInput.addEventListener('input', () => {
    updateQueryString(markdownInput.value);
    scheduleRender();
  });

  macrosInput.addEventListener('input', scheduleRender);
  toggleEditorBtn.addEventListener('click', () => {
    const hidden = editorPanel.classList.contains('hidden');
    setEditorHidden(!hidden);
  });
  getUrlBtn.addEventListener('click', handleGetUrl);

  updateQueryString(markdownInput.value);
  scheduleRender();
}

init();
