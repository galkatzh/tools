/*
 * OAuth token-exchange proxy for the Spaced Repetition app.
 *
 * GitHub's authorization-code flow requires a client secret, which cannot ship
 * in a static site. This Cloudflare Worker holds the secret and performs the
 * code-for-token exchange on behalf of the browser.
 *
 * ── Deployment ──────────────────────────────────────────────────────────
 * 1. Register a GitHub OAuth App (https://github.com/settings/developers):
 *      - Homepage URL:          your app URL, e.g. https://tools.example.com/spaced-repetition/
 *      - Authorization callback: the SAME app URL (must match exactly)
 *    Note the Client ID and generate a Client Secret.
 *
 * 2. Edit ALLOWED_ORIGIN below to your GitHub Pages origin (scheme + host only).
 *
 * 3. Deploy with Wrangler:
 *      wrangler deploy oauth-worker.js --name srs-oauth
 *      wrangler secret put GITHUB_CLIENT_ID       # paste the Client ID
 *      wrangler secret put GITHUB_CLIENT_SECRET   # paste the Client Secret
 *
 * 4. In the app's Settings, enter the Client ID and the deployed Worker URL.
 * ────────────────────────────────────────────────────────────────────────
 */

const ALLOWED_ORIGIN = 'https://YOUR-PAGES-ORIGIN'; // e.g. https://tools.example.com

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    try {
      const { code } = await request.json();
      if (!code) return json({ error: 'missing_code' }, 400, cors);

      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      const data = await res.json();

      if (data.error || !data.access_token) {
        // Never echo the secret; only surface GitHub's error code.
        return json({ error: data.error || 'no_token' }, 400, cors);
      }
      return json({ access_token: data.access_token }, 200, cors);
    } catch (e) {
      console.error('Token exchange failed:', e);
      return json({ error: 'exchange_failed' }, 500, cors);
    }
  },
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
