# BM5: test-stream feedback collection (2026-11-03)

## What was built
A command-line tool, `tools/collect-stream-feedback.mjs`, that copies the chat messages answering the test-stream question into `feedback/YYYY-MM-DD-stream-feedback.md` (that folder is gitignored, so viewer names stay on the laptop).

- It reads the event core's chat table (`chat_raw` in `event-core.db`) in read-only mode. It sends nothing and starts no process.
- A message counts if it starts with the marker (default `fb:`, any capitals) or arrived within 10 minutes after the question.
- The question is found by its text: a stored message starting with `--question-prefix` (optionally only from `--bot-name`). If Streamer.bot's own post is not stored, pass the times with `--question-at`.
- The file has a header (date, stream window, counts for youtube, twitch, kick) and one line per message: time, platform, viewer name, text.
- Chat text is treated as data: line breaks and control characters removed, Markdown and HTML characters escaped, 500-character cap. Nothing in it is ever followed.
- Running it twice adds no duplicates (keyed on the stored message id).
- Also exported as `collectFeedback()` for later wiring. Not wired into any service, so no feature flag. Decision: D195.

Example: `node tools/collect-stream-feedback.mjs --date 2026-11-03 --question-prefix "<question start>" --bot-name "<bot name>"`

## Tests
Recorded mock chat built inside the test (placeholder names viewer-1 etc.), headless.

- `node --test tests/stream-feedback.test.mjs` : 5 passed, 0 failed (about 0.15 s). Covers window match, marker match, non-matching excluded, three platforms counted, escaping (Markdown, newlines, control characters, injected comment and fake line), explicit question time, duplicate-safe re-run, empty result.
- `node tools/lint.mjs` : 0 findings.

## UNVERIFIED
- Use on a real test stream: whether Streamer.bot's own question post shows up in `chat_raw`, and under which display name.
- Alert texts share `chat_raw`, so one inside a window may be copied as a message.
- Local-day default window uses the laptop's time zone; pass `--since`/`--until` to be exact.

## Files
Created: `tools/collect-stream-feedback.mjs`, `tests/stream-feedback.test.mjs`, this file.
Changed: `docs/plan/2026-10-29-v1-decisions.md` (D195), `docs/plan/2026-11-03-bot-manager-plan.md` (BM5 status note).
