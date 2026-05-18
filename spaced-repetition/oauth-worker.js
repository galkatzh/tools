/*
 * OAuth token-exchange proxy for the Spaced Repetition app.
 *
 * GitHub's authorization-code flow requires a client secret, which cannot ship
 * in a static site. This Cloudflare Worker holds the secret and performs the
 * code-for-token exchange on behalf of the browser.
 *
 * ── Reusable across apps ─────────────────────────────────────────────────
 * This worker is generic — it does not care which app calls it. GitHub OAuth
 * Apps match the redirect_uri by PREFIX, so registering the callback at your
 * domain root lets every app under it reuse the SAME OAuth App and this SAME
 * worker. Set this up once; future apps need no new infrastructure.
 *   - Scope is chosen per request by each app's authorize URL, so one OAuth
 *     App covers apps that need different scopes (gist, repo, user, ...).
 *   - localStorage is per-origin: each app must use a distinct token key.
 *
 * ── Deployment (do this once for the whole domain) ───────────────────────
 * 1. Register a GitHub OAuth App (https://github.com/settings/developers):
 *      - Homepage URL:           your domain root, e.g. https://tools.example.com/
 *      - Authorization callback: the SAME domain root — every app at a
 *        subpath (/spaced-repetition/, /future-app/, ...) is then valid.
 *    Note the Client ID and generate a Client Secret.
 *
 * 2. Edit ALLOWED_ORIGIN below to your GitHub Pages origin (scheme + host).
 *    For apps on multiple domains, make it an allow-list instead.
 *
 * 3. Deploy. Either paste this file into the Cloudflare dashboard
 *    (Workers & Pages -> Create -> Worker), or use Wrangler:
 *      wrangler deploy oauth-worker.js --name oauth-proxy
 *    Then set two secrets (dashboard: Settings -> Variables and Secrets,
 *    or CLI):
 *      wrangler secret put GITHUB_CLIENT_ID       # paste the Client ID
 *      wrangler secret put GITHUB_CLIENT_SECRET   # paste the Client Secret
 *
 * 4. In each app's Settings, enter the Client ID and the deployed Worker URL.
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
