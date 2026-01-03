# Oura Sleep Tracker

A client-side app to track deep sleep episodes and sleep statistics using the Oura Ring API.

## Current Status

**CORS Issue**: The Oura API does not allow direct browser requests. A backend proxy is needed to make this work.

## Oura API Documentation

### Main Documentation Links

- **API Overview**: https://cloud.ouraring.com/docs/
- **API v2 Docs** (Swagger): https://cloud.ouraring.com/v2/docs
- **Authentication**: https://cloud.ouraring.com/docs/authentication
- **OAuth Applications**: https://cloud.ouraring.com/oauth/applications

### OAuth Configuration

When setting up OAuth, get the example URL from the Oura dashboard - it contains:
- The exact redirect URI format (watch for trailing slashes, case sensitivity)
- The available scopes for your app

**Example URL from dashboard:**
```
https://cloud.ouraring.com/oauth/authorize?client_id=YOUR_ID&redirect_uri=HTTPS%3A%2F%2Fyour-domain%2Fpath%2F&response_type=token&scope=daily+heartrate+workout+session+spo2+ring_configuration+stress+heart_health
```

### Valid OAuth Scopes

| Scope | Description |
|-------|-------------|
| `email` | User's email address |
| `personal` | Gender, age, height, weight |
| `daily` | Sleep, activity, readiness summaries |
| `heartrate` | Heart rate time series |
| `workout` | Workout summaries |
| `tag` | User-entered tags |
| `session` | Guided/unguided sessions |
| `spo2` | SpO2 averages |
| `ring_configuration` | Ring settings |
| `stress` | Stress data |
| `heart_health` | Heart health metrics |

### Sleep Data Endpoint

```
GET https://api.ouraring.com/v2/usercollection/sleep?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
Authorization: Bearer {access_token}
```

**Key fields returned:**
- `deep_sleep_duration` - seconds
- `light_sleep_duration` - seconds
- `rem_sleep_duration` - seconds
- `awake_time` - seconds
- `sleep_phase_5_min` - hypnogram string (1=deep, 2=light, 3=REM, 4=awake)

### Parsing Deep Sleep Episodes

The `sleep_phase_5_min` field contains a string like `"4422211122233311112244..."` where each character represents a 5-minute interval:

| Value | Sleep Stage |
|-------|-------------|
| 1 | Deep Sleep |
| 2 | Light Sleep |
| 3 | REM Sleep |
| 4 | Awake |

To count deep sleep episodes, find consecutive sequences of "1"s. Each sequence is one episode, duration = count × 5 minutes.

## Troubleshooting

### OAuth 400 Invalid Request

Check that:
1. Redirect URI matches EXACTLY (trailing slash, protocol case)
2. Scopes are valid (use ones from dashboard example)
3. Client ID is correct

### CORS / Load Failed Error

The Oura API doesn't support browser CORS. Solutions:
1. **Cloudflare Worker proxy** (recommended - see below)
2. Backend server to forward requests
3. Use a server-side application instead

## Deploying the Cloudflare Worker Proxy

A `cloudflare-worker.js` file is included that proxies requests to the Oura API and adds CORS headers.

### Steps:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages** → **Create Worker**
3. Name it something like `oura-proxy`
4. Paste the contents of `cloudflare-worker.js`
5. Click **Deploy**
6. Your worker will be available at `https://oura-proxy.YOUR-SUBDOMAIN.workers.dev`
7. Update `CONFIG.apiBase` in `index.html` to use your worker URL

### Custom Domain (Optional):

1. In Workers, go to your worker → **Settings** → **Triggers**
2. Add a **Custom Domain** like `oura-api.tools.galk.cc`
3. Update `CONFIG.apiBase` to use the custom domain

## Configuration

Edit `index.html` and update the CONFIG object:

```javascript
const CONFIG = {
    clientId: 'your-client-id',
    redirectUri: 'https://your-domain/path/',  // Must match dashboard exactly
    scopes: 'daily heartrate ...',  // From dashboard example
    // ...
};
```
