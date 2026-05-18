// GitHub OAuth (authorization-code flow). The code-for-token exchange runs
// through a user-deployed proxy (see oauth-worker.js) that holds the secret.

import { OAUTH_CLIENT_ID, OAUTH_PROXY_URL } from './config.js';

const TOKEN_KEY = 'srs_token';
const STATE_KEY = 'srs_oauth_state';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function isLoggedIn() {
  return Boolean(getToken());
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}

/** Redirect to GitHub to begin the OAuth flow. */
export function login() {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('scope', 'gist');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', location.origin + location.pathname);
  location.href = url.toString();
}

/**
 * If the page loaded as an OAuth callback, exchange the code for a token.
 * Returns 'ok' | 'error', or null when this is not a callback.
 */
export async function handleCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  if (!code && !error) return null;

  // Strip the query string so a reload cannot reuse a spent code.
  history.replaceState(null, '', location.pathname);

  if (error) {
    console.error('OAuth error from GitHub:', error, params.get('error_description'));
    return 'error';
  }

  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (!state || state !== expected) {
    console.error('OAuth state mismatch — possible CSRF. Aborting.');
    return 'error';
  }

  try {
    const res = await fetch(OAUTH_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`Proxy returned HTTP ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error('Proxy response missing access_token');
    localStorage.setItem(TOKEN_KEY, data.access_token);
    return 'ok';
  } catch (e) {
    console.error('Token exchange failed:', e);
    return 'error';
  }
}
