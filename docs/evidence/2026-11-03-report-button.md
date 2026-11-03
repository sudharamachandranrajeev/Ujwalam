# Report button: prefilled GitHub issue (2026-11-03)

## What was built
- Control page "Report" card (flag `report-button`, default off). Title and "What happened" boxes plus a Report button. A click asks the studio-ui server for a link, then opens it in a new browser tab with `window.open(url, '_blank', 'noopener')`. The user reviews and submits in the browser. A real link is also shown under the button in case the browser blocks the tab.
- Nothing is sent by Ujwalam: no GitHub API, no token, no network call. The server only builds a string.
- `GET /ui/api/report-url?title=&note=` (`services/studio-ui/server.mjs`, `services/studio-ui/report.mjs`): same session cookie, same-origin and Host rules as every `/ui/api` GET. 404 `report-button-off` while the flag is off. Unknown query keys or oversize input: 400.
- Repo URL: profile `links.issues_url` in the gitignored local profile only. Strict form `https://github.com/<owner>/<repo>`: https only, no credentials, port, query, fragment, extra path, trailing slash or `.git`. Unset or placeholder: the page shows "Report: set links.issues_url in the profile" and does nothing. Invalid: a message naming the required form. Placeholder in `data/profile.example.json`, key in `data/profile.schema.json`.
- Body: typed text, Ujwalam version (`release.json`, else `data/release/alpha.json`), OS type, release and arch, flags on (names) and count off, host state, frame counts, output sinks by state (counts), host crash log entry count. Redaction uses `tools/diag/redact.mjs` (`makeRedactor` with the profile, home dir and user name) and `outputsSafe` from `tools/diag/bundle.mjs`; no second redactor. The typed text is redacted too, so a pasted key or profile term never leaves.
- URL capped at 6000 characters. When cut, the body ends with "[truncated to fit the link: attach the diag bundle (Ujwalam.cmd diag, or npm run diag)]".
- D191: opening a browser tab is a user-requested GUI action (a click on Report). The server spawns nothing. The page opens nothing on its own.
- `launch.mjs` passes `--profile` and `--release` to the UI server; `cli.mjs` accepts them.
- The page checks the link with `new URL(...)` (https and host github.com) before opening it. A literal `https://` string in `ui/js` is not allowed by `tests/studio-ui-flags-feedback.test.mjs` (no external URLs in page scripts), so the check parses instead.

## Tests (headless, `UJWALAM_HEADLESS=1`, no network, no browser)
- `node --test tests/report-button.test.mjs`: 15 tests, 4 suites. URL format; strict repo validation (non-github, http, extra path, query, fragment, credentials, port, trailing slash, `.git`, odd owners, javascript: URLs); seeded fake brand term, fake key, fake token, ingest URL, home dir and user name never appear in the URL; truncation within the cap, including emoji (no split surrogate); flag gate 404; placeholder profile message; valid profile URL; page wiring (safe DOM, https and github.com host check, noopener).
- Run together with the neighbours (`tests/studio-ui-bots`, `studio-ui-flags-feedback`, `studio-ui-server`, `studio-ui-posting`, `flags`, `diag-bundle`, `package-alpha`): 96 tests, 95 passed, 0 failed (1 skipped by those suites).
- `node tools/lint.mjs`: 0 findings. Two allow markers (rule `secret`) sit on seeded fake values in the new test, the way `tests/overlay-server.test.mjs` does it.
- Not run: `npm run ci`, `npm test`.

## UNVERIFIED
- A real click in a real browser: tab opens, GitHub shows the prefilled form, a long URL (about 6000 characters) is accepted by GitHub and the browser. Needs the laptop.
- Pop-up blocking after the async fetch (the fallback link covers it).
- `release.json` in a source checkout (absent there; falls back to `data/release/alpha.json`).
- Redaction of a brand term typed with an unusual spelling beyond the redactor's separator variants.

## Files
Created: `services/studio-ui/report.mjs`, `tests/report-button.test.mjs`, this file.
Changed: `data/flags.json`, `data/profile.example.json`, `data/profile.schema.json`, `services/studio-ui/server.mjs`, `services/studio-ui/cli.mjs`, `services/studio-ui/launch.mjs`, `ui/index.html`, `ui/js/api.js`, `ui/js/app.js`, `ui/css/app.css`.
