# A0 feature flags and post-stream feedback form (2026-11-04)

Result: PASS (automated, fake host, 127.0.0.1 only). Not yet used on a real stream: **awaiting live use**. The page
panels were not opened in a browser in this run (UNVERIFIED visually); the page scripts are covered by lint (syntax,
SPDX) and a no-innerHTML/no-URL test only.

## What was built

- `data/flags.json` (committed): `{id, description, default, since}`; two example flags, both default off.
- `services/flags/index.mjs`: `createFlags({dataDir})` -> `list()`, `isOn(id)`, `set(id, on)`, `subscribe(fn)`, `ids()`.
  Local state `<dataDir>/flags.local.json` (gitignored by `*.local.*`), tmp file + rename. `isOn` reloads when the file's
  mtime or size changes, so other processes see a flip without restart. Unknown ids: rejected on write, off on read.
- Studio-ui server (`services/studio-ui/server.mjs`):
  - `GET /ui/api/flags` (`flags.list`), `POST /ui/api/flags/set {id, on}` (`flags.set`).
  - OFF: applied at once, never confirmed, also while live. ON: pending record, typed phrase `yes`, or `yes, on air`
    while live (same `pending`/`/ui/api/confirm` mechanism as stream start). SSE event `flags` on every change.
- `services/studio-ui/feedback.mjs` + routes `GET /ui/api/feedback`, `POST /ui/api/feedback/note {id, text, tag, severity}`.
  Folder from `opts.feedbackDir` (default `<repo>/feedback`). Ids must match `^\d{4}-\d{2}-\d{2}/\d{6}$` before any path is
  built; the folder must be a real directory (lstat, no link) whose realpath equals the joined path under the feedback
  root and holds `moment.json`. The only file written is `note.json` (tmp + rename). `moment.json` values are cut down
  to small primitives (scene <= 64 chars, <= 24 stats). Tags `bug|annoying|wish|works-well`; severity `high|medium|low`;
  text <= 2000 chars.
- Page: "Feature flags" panel (right column, checkbox per flag; the box follows the server answer) and a "Feedback" modal
  (moment list, note, tag, severity, save). Plain script, `Dom.el`/`textContent` only, tokens only.

## Commands and output

```
node --test tests/flags.test.mjs tests/studio-ui-flags-feedback.test.mjs
ℹ tests 21   ℹ suites 6   ℹ pass 21   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0

node --test tests/studio-ui-server.test.mjs tests/studio-ui-alpha.test.mjs     (regression)
ℹ tests 39   ℹ pass 39   ℹ fail 0   ℹ skipped 0

node tools/lint.mjs
lint: 0 finding(s), 27 allow marker(s), in 2.8s
```

Checked by the tests: all defaults off; ON writes nothing until the right phrase; wrong phrase keeps it off; `yes, on air`
required while live; OFF instant while live; unknown/bad/extra fields refused; missing CSRF 403 and missing cookie 401;
atomic write leaves no temp file; second instance sees a flip; corrupt local file falls back to defaults; feedback list
is newest first and sanitised; note write touches only `note.json` (replay file and `moment.json` unchanged); 16 traversal
or malformed ids refused; folder without `moment.json` refused; a directory junction pointing outside the feedback root is
not listed and not written.

## Files

Created: `data/flags.json`, `services/flags/index.mjs`, `services/studio-ui/feedback.mjs`, `tests/flags.test.mjs`,
`tests/studio-ui-flags-feedback.test.mjs`, this file.
Changed: `services/studio-ui/server.mjs`, `ui/index.html`, `ui/js/app.js`, `ui/js/api.js`, `ui/css/app.css`.
