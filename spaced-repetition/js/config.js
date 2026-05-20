// User settings, persisted as a single JSON blob in localStorage.

const KEY = 'srs_config';

// OAuth credentials for this deployment. The client ID is public; the matching
// client secret lives only in the proxy Worker (see oauth-worker.js).
export const OAUTH_CLIENT_ID = 'Ov23liQhj0nBuv8Qm6sO';
export const OAUTH_PROXY_URL = 'https://icy-night-1c31.galkatz.workers.dev/';

// Default LaTeX macro preamble, kept in sync with the mdmath renderer so cards
// authored there typeset identically here. Prepended to every card's math.
export const DEFAULT_MATH_PREAMBLE = String.raw`\newcommand{\sparentheses}[1]{\left[#1\right]}
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
\newcommand{\x}{\mathbf{x}}
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

const DEFAULTS = {
  gistPrefix: 'srs:',
  mathPreamble: DEFAULT_MATH_PREAMBLE,
  notify: false,
  delim: {
    inline: '::',
    inlineReversed: ':::',
    multiline: '?',
    multilineReversed: '??',
    clozeOpen: '==',
    clozeClose: '==',
  },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      delim: { ...DEFAULTS.delim, ...(parsed.delim || {}) },
    };
  } catch (e) {
    console.error('Failed to load config, falling back to defaults:', e);
    return structuredClone(DEFAULTS);
  }
}

let config = load();

export function getConfig() {
  return config;
}

/** Merge a partial update into the config and persist it. */
export function saveConfig(patch) {
  config = {
    ...config,
    ...patch,
    delim: { ...config.delim, ...(patch.delim || {}) },
  };
  localStorage.setItem(KEY, JSON.stringify(config));
  return config;
}
