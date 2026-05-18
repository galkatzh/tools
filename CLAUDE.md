This is a repository of vanilla javascript apps, which are deployed as is with github pages.

# Guidelines
- Always test your code before handing it to my review. You can use rodney (uvx rodney --help for instructions), or playwright.
- Remove unnecessary code whenever possible
- Unless stated otherwise, any code in this repo should be run on web without any build step. This means:
  - Defaulting to CDNs for loading libraries.
  - Using pyodide, WASM, etc. when necessary.
- Make the code concise and elegant.
- Document methods, but also difficult and confusing parts of the code.
- Always fail loudly, never silently. Every error must be visible — at minimum logged to the browser console, and surfaced in the UI when a user-facing action failed. Every `catch` block must log (`console.error`); never leave one empty or comment-only. Don't mask a real failure with a misleading message (e.g. labelling a live network error as "offline") or by silently falling back to stale/cached data. Prefer failing visibly over failing gracefully and silent. Register global `error` and `unhandledrejection` handlers (in both the page and any service worker) so nothing that escapes a `try/catch` goes unreported.
- Bump the `CACHE_NAME` version in every PWA's `sw.js` with each commit that modifies that app's files. This ensures users get fresh assets instead of stale cached ones.

# iOS Audio on Silent
To make audio play on iOS even when the device is on silent, set `navigator.audioSession.type = 'playback'` after creating the `AudioContext`. This uses the [Audio Session API](https://developer.apple.com/documentation/webkitapi/audiosession), which is Safari-only — guard it with `if (navigator.audioSession)` so it's a no-op on other browsers.
