// User settings, persisted as a single JSON blob in localStorage.

const KEY = 'srs_config';

const DEFAULTS = {
  oauthClientId: '',
  oauthProxyUrl: '',
  gistPrefix: 'srs:',
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

/** True once OAuth credentials are set — required before login is possible. */
export function isConfigured() {
  return Boolean(config.oauthClientId && config.oauthProxyUrl);
}
