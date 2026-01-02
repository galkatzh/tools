/**
 * Cloudflare Worker Proxy for Oura API
 *
 * This worker proxies requests to the Oura API and adds CORS headers
 * to allow browser-based applications to access the API.
 *
 * Deployment:
 * 1. Go to https://dash.cloudflare.com/
 * 2. Workers & Pages → Create Worker
 * 3. Paste this code and deploy
 * 4. (Optional) Set up a custom route like api.tools.galk.cc/*
 *
 * Usage:
 * Instead of: https://api.ouraring.com/v2/usercollection/sleep
 * Use:        https://your-worker.workers.dev/v2/usercollection/sleep
 */

const OURA_API_BASE = 'https://api.ouraring.com';
const ALLOWED_ORIGINS = [
  'https://tools.galk.cc',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
];

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request);
    }

    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // Build the Oura API URL
    const ouraUrl = OURA_API_BASE + url.pathname + url.search;

    // Forward the request to Oura API
    const ouraRequest = new Request(ouraUrl, {
      method: request.method,
      headers: {
        'Authorization': request.headers.get('Authorization') || '',
        'Content-Type': 'application/json',
      },
      body: request.method !== 'GET' ? request.body : undefined,
    });

    try {
      const response = await fetch(ouraRequest);

      // Clone the response and add CORS headers
      const newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

      // Add CORS headers
      const corsOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
      newResponse.headers.set('Access-Control-Allow-Origin', corsOrigin);
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      newResponse.headers.set('Access-Control-Max-Age', '86400');

      return newResponse;
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
        },
      });
    }
  },
};

function handleCORS(request) {
  const origin = request.headers.get('Origin');
  const corsOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function isAllowedOrigin(origin) {
  return origin && ALLOWED_ORIGINS.includes(origin);
}
