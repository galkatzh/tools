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
