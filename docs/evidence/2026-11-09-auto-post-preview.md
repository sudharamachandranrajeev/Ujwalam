# Auto-post rules dry-run preview (2026-11-09)

Goal: let the user approve auto-post rules without any real post. Read-only; no request to Google; no write.

## What it does

`previewRules()` in `services/posting/preview.mjs` reads `<dataDir>/clips/uploads.json`, the posting ledger, the auto log, the rules file, `data/posting/templates.json` and `limits.json`. It reports:

- **would queue**: kind, target, rule, actions (`approve`, plus `upload` when `autoUpload` is on and the target is a YouTube target), score, and the rendered title, description (hashtags included), tags.
- **would skip**, each with a reason: `below-min-score`, `kind-not-in-rule`, `layout-not-in-rule`, `no-rule-for-target`, `over-limit`, `unresolved-placeholders`, `max-per-day` (counts the auto log for today, UTC), `already-posted`, `already-auto-approved`, `status-<x>`, and for uploads.json rows `already-posted`, `already-packaged`, `file-missing`, `unknown-kind`, `no-template`.
- **live**: when a stream sink is active, or the state cannot be read, `blocked` is set and every queued item carries `held`. Recording sinks do not block (same `streamOnly` filter as `auto --run`).

The queue decision is `planAuto()` itself, the same function `auto --run` uses, so the preview cannot drift from the run. Finished videos from uploads.json that are not packaged yet are rendered with the same templates and renderer as `packageUploads()` and fed through `planAuto` as draft posts.

## Entry points

- CLI: `node services/posting/cli.mjs auto --preview [--json] [--data-dir DIR] [--rules FILE] [--profile FILE]`. Never opens a browser, never builds an auth object, never uploads. The live check talks only to the local host (127.0.0.1).
- Control page: `GET /ui/api/posts/auto/preview` (404 `posting-off` while the `posting` flag is off; needs the session cookie), and a "Preview auto-post rules" button in the Posts panel (safe DOM, `textContent` only).

## Evidence

Test file: `tests/posting-preview.test.mjs` (12 tests, all pass).

- Decisions: fixture with 8 packages and 4 uploads.json rows, two rules; asserts every reason above, the rendered montage title/description, the 90 s montage routed to `youtube-video` (no rule), cap counted from the log, live and unreadable-state hold.
- Zero network: `fetch`, `http.request`, `https.request` and non-loopback `net` connects are replaced by recorders that throw; `previewRules` and the CLI (text and `--json`) run, recorded calls equal `[]`. A source check asserts `preview.mjs` imports no uploader, auth, http or write code.
- Zero writes: a size + mtime + sha256 snapshot of the whole data dir is identical before and after, for the CLI and for the route.
- Route: flag off gives 404; no session is refused; flag on gives 200 with queue and skips.
- Templates vs limits (`checkLimits` against `limits.json`): every target x kind (short, montage, won-reel) is inside its limits with a full profile and has no unresolved placeholder; montage and won-reel overrides replace title, tags and hashtags where the template defines them, other targets fall back to the base; the YouTube description limit is UTF-8 bytes (1700 Malayalam characters = 5100 bytes is flagged although under 5000 characters); TikTok limit is UTF-16 (astral emoji count twice); a 101 code point title is flagged and kept whole (the project never truncates); `<` `>` are forbidden; an empty profile leaves `handles.youtube` and `links.discord` unresolved and flagged.

Runs: `node --test tests/posting*.test.mjs tests/studio-ui-posting*.test.mjs` 128/128 pass; `node tools/ci.mjs --quick` 9/9 pass.

## Not verified

- The preview was not run against the user's real data dir or real rules (rules list in the repo is empty by design).
- The browser view was not opened in a real browser; the route and the DOM code path are covered by the route test and review only.
- Limits for `youtube-shorts` video duration remain `unverified` in `limits.json` (unchanged).

## Files

Created: `services/posting/preview.mjs`, `tests/posting-preview.test.mjs`, this file.
Changed: `services/posting/cli.mjs` (`auto --preview`), `services/posting/index.mjs` (export `CANVAS_TAIL`, `NAME_DATE`), `services/studio-ui/server.mjs` (GET route), `ui/index.html`, `ui/js/api.js`, `ui/js/app.js`.
