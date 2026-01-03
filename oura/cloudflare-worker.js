/**
 * Cloudflare Worker Proxy for Oura API
 *
 * This worker proxies requests to the Oura API and adds CORS headers
 * to allow browser-based applications to access the API.
 *
 * Deployment:
 * 1. Go to https://dash.cloudflare.com/
 * 2. Workers & Pages → Create Worker
 * 3. Click "Edit code", paste this, and Deploy
 */

const OURA_API_BASE = 'https://api.ouraring.com';
const ALLOWED_ORIGINS = [
  'https://tools.galk.cc',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
];

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
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

    // Create new response with CORS headers
    const corsOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];

    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', corsOrigin);
    newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    newHeaders.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    newHeaders.set('Access-Control-Max-Age', '86400');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (error) {
    const corsOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  }
}

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
