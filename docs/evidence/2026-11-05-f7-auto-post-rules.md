# F7 auto-post-approved-rules (opt-in), 2026-11-05

Status: built, tested with fakes. Not used on a real stream or a real upload. Review-first stays the default.

## What exists

- `data/posting/auto-post-rules.json`: rules file, ships with `rules: []` and `autoUpload: false`; every field marked `proposed`.
  Rule: `{ id, target, minScore, layouts?, maxPerDay (1..10) }`. `minScore` compares to the ranker's candidate `score`.
- `data/flags.json`: flag `auto-post`, default off. Auto mode needs `posting` and `auto-post` both on.
- `services/posting/auto-post.mjs`: `loadRules`, `planAuto` (pure dry run), `runAuto`, `liveBlock`, `createAutoLog`.
- `services/posting/index.mjs`: `packageRun` now stores `source.score` in post.json (null when absent); the store view exposes `score`.
  Posts packaged before this change have no score and are skipped (reason `no-score`).
- `services/posting/cli.mjs`: `auto` (read-only dry-run listing, works with flags off) and `auto --run` (needs both flags; exit 3 if off).
- `services/studio-ui/server.mjs`: read-only `GET /ui/api/posts/auto` (mode + dry-run plan). UI: Posts view shows the mode line and
  "would approve/upload" list (safe DOM, no innerHTML). Enabling stays the flag.

## Safety behaviour (each covered by a test in tests/posting-auto.test.mjs)

- Private only: uploads go through the existing `uploadPost`/`uploadVideo`, which hardcodes private.
- Fail closed: `--run` refuses when any sink is active/starting (stream or not), when the output state throws, or is malformed.
  Re-checked right before every upload (stream starts mid-run: upload refused and logged).
- Never twice: auto log (`<dataDir>/posting/auto-log.json`) holds approve/upload/upload-failed per post id; the attempt is logged
  BEFORE the upload call; a failed upload is not retried by later runs; `uploadVideo` also refuses a ledger entry already `uploaded`.
  One failure ends uploads for that run.
- Max per day: per rule, per UTC day, counted from the log, separately for approvals and uploads; best score first.
- Only posts auto-approved are ever auto-uploaded; a post the user approved by hand is left alone.
- Auto-approve goes through `store.setStatus`, so limits, unresolved placeholders and video-hash checks still apply.
- Upload is only for target `youtube-shorts` (the only real uploader); other targets get approval only.
- Log entries hold ids, rule id, action, reason code, timestamp. No titles, text or tokens.

## Commands run

- `node --test tests/posting-auto.test.mjs` : 14 pass, 0 fail.
- `node --test tests/posting*.test.mjs tests/studio-ui-posting*.test.mjs tests/flags*.test.mjs` : 82 pass, 0 fail.
- `node tools/lint.mjs` : 0 findings.

## UNVERIFIED

- Rule field set, thresholds and caps are proposals; the user has not approved any rule. No real score scale checked against a real run.
- `defaultOutputsStatus` (no host discovery file means `{ sinks: [] }`, i.e. nothing live) is reused from the existing upload CLI; the
  real outputs.status shape with a running host was not exercised here.
- Real upload path (OAuth, Google) not touched; fakes only.
- Not run: `npm run ci`, UI in a real browser (source check only).
