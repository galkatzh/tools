// User settings, persisted as a single JSON blob in localStorage.

const KEY = 'srs_config';

// OAuth credentials for this deployment. The client ID is public; the matching
// client secret lives only in the proxy Worker (see oauth-worker.js).
export const OAUTH_CLIENT_ID = 'Ov23liQhj0nBuv8Qm6sO';
export const OAUTH_PROXY_URL = 'https://icy-night-1c31.galkatz.workers.dev/';

const DEFAULTS = {
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
