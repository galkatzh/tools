This is a repository of vanilla javascript apps, which are deployed as is with github pages.

# Guidelines
- Always test your code before handing it to my review. You can use rodney (uvx rodney --help for instructions), or playwright.
- Remove unnecessary code whenever possible
- Unless stated otherwise, any code in this repo should be run on web without any build step. This means:
  - Defaulting to CDNs for loading libraries.
  - Using pyodide, WASM, etc. when necessary.
- Make the code concise and elegant.
- Document methods, but also difficult and confusing parts of the code.
- Never swallow errors silently. Every catch block must log to console at minimum. Prefer failing visibly over failing gracefully and silent.
- Bump the `CACHE_NAME` version in every PWA's `sw.js` with each commit that modifies that app's files. This ensures users get fresh assets instead of stale cached ones.

# iOS Audio on Silent
To make audio play on iOS even when the device is on silent, set `navigator.audioSession.type = 'playback'` after creating the `AudioContext`. This uses the [Audio Session API](https://developer.apple.com/documentation/webkitapi/audiosession), which is Safari-only — guard it with `if (navigator.audioSession)` so it's a no-op on other browsers.
