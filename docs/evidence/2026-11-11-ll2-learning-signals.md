# 2026-11-11 LL2 learning signals become label rows (D338)

Branch `ll/signals` (from `claude/alpha0-d1` at 4f0b9de). Spec: `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md`
section B, LL2 (approved, D324), with the parts of LL1 (store, cap) and LL5 (privacy scan) it needs. Decision: D338.

Result: PASS on tests (temp folders, placeholder names, no network, no devices, no windows). Not yet run on the
user's real clips folder or a real stream: **UNVERIFIED in real use**.

## What changed

- `services/learning/store.mjs` (new): the local learning store `<dataDir>/learning-store/<session>/labels.jsonl`,
  JSON lines, rows `{ v, at, action, source, session, ref }`; actions kept | deleted | posted | renamed | feedback;
  sources my-clips | posting | hotkey | feedback-form | chat-feedback; `ref` short primitives only. `enforceCap()`:
  5 GB total, whole session folders oldest first, never the newest.
- `services/learning/signals.mjs` (new): My clips check over `<dataDir>/clips/uploads.json` (kept / deleted / renamed)
  and new feedback-hotkey moments; `createLearningSignals()` runs at launcher start (with the cap) and every minute.
- `services/studio-ui/launch.mjs`: starts and stops the learning pass.
- `services/posting/youtube.mjs` `uploadPost`, `services/posting/index.mjs` (`createPostStore({ dataDir })`), and its
  callers `server.mjs`, `auto-chain.mjs`, `cli.mjs`: a "posted" row after a finished upload.
- `services/studio-ui/server.mjs` `/ui/api/feedback/note`: a "feedback" row with tag and severity (no text).
- `tools/collect-stream-feedback.mjs` (+ `--learning-data-dir`), `services/studio-ui/live-test-kit.mjs`, `server.mjs`:
  one "feedback" row per newly collected chat reply (file name, message id, platform; no viewer name or text).
- `tools/git-hooks/private-scan.mjs`: local rule refuses any `learning-store/` path (any depth, any case). `.gitignore`:
  `learning-store/`.
- `tools/package/manifest.mjs`: `services/learning` ships in the alpha package (the import check would fail without it).

## Done-when checks

| Item | Status | Evidence |
|---|---|---|
| Kept clip -> label row | PASS | `tests/learning-signals.test.mjs` "My clips: kept ..., deleted and renamed ..." and "... not kept until a later start" |
| Deleted clip -> label row | PASS | same test (plain delete, and delete after two renames) |
| Renamed clip -> label row | PASS | same test (hard-linked like clip_publish.py; the run folder's link is never taken for the renamed file) |
| Posted clip -> label row | PASS | `tests/learning-signals.test.mjs` "posting: ..." (uploadPost with a fake Google); `tests/studio-ui-posting-youtube.test.mjs` happy path (Posts view route) |
| Feedback hotkey -> label row | PASS | `tests/learning-signals.test.mjs` "feedback hotkey ..." (host-shaped moment.json, same-second `-2` folder); note: `tests/studio-ui-flags-feedback.test.mjs` "save note ..." |
| Chat-feedback reply -> label row | PASS | `tests/learning-signals.test.mjs` "chat-feedback replies ..." (no name or text in the store, re-run adds nothing); `tests/live-test-kit.test.mjs` stream end -> real collector child writes the rows |
| Cap (LL1) | PASS | `tests/learning-signals.test.mjs` "cap (LL1 hook) ..." (oldest two removed, newest kept even when alone over the cap) |
| Privacy scan covers the store (LL5) | PASS | `tests/private-scan.test.mjs` "LL5 (D338) ..." (pre-commit at three depths and mixed case, pre-push over history; `services/learning/` and a doc named learning-store-notes pass) |

## Codex review fixes (2026-11-11)

Each fix has a regression test that failed before the fix (run on the unfixed code, then again after):

| Finding | Fix | Test (before -> after) |
|---|---|---|
| P1 cap could delete the newest session (a late row in an old session refreshed its mtime) | cap orders by `session.json` `createdAt` (written once; fallback first row time, then oldest file); latest by start never removed | "cap (Codex P1): a late label in an old session ..." FAIL ("oldest by start time, not by last write") -> PASS |
| P2 a failed append lost the label (state already advanced) | clip state (kept, renamed path, deleted) moves on only after a written row; kept is checked on every pass for clips published before this app start | "My clips (Codex P2): a label that cannot be written is tried again ..." FAIL -> PASS |
| P2 more than 5,000 moments: trimmed ids looked unseen and were labelled again | checkpoint `momentMark` (newest moment labelled, sortable key with the `-nn` suffix); a failed write stops the pass before the mark; old state's id list migrates to its newest id; no 200-moment page limit | "feedback hotkey (Codex P2): a moment labelled once is never labelled again ..." FAIL ("the trimmed moment is not labelled again") -> PASS |

Not changed (coordinator decision): clip file names in rename rows are the user's own words, kept in the local,
gitignored, scan-blocked store only (line added to D338).

## Commands and results (2026-11-11, one suite at a time)

```
node --test --test-timeout=60000 tests/learning-signals.test.mjs           tests 10 pass 10 fail 0 (after the review fixes; 7 before)
node --test --test-timeout=60000 tests/live-test-kit.test.mjs              tests 16 pass 16 fail 0
node --test --test-timeout=60000 tests/studio-ui-flags-feedback.test.mjs   tests 16 pass 16 fail 0
node --test --test-timeout=60000 tests/studio-ui-posting-youtube.test.mjs  tests 8  pass 8  fail 0
node --test --test-timeout=60000 tests/stream-feedback.test.mjs            tests 6  pass 6  fail 0
node --test --test-timeout=60000 tests/posting-youtube.test.mjs            tests 9  pass 9  fail 0
node --test --test-timeout=60000 tests/posting-youtube-cli.test.mjs        tests 6  pass 6  fail 0
node --test --test-timeout=60000 tests/posting-auto-chain.test.mjs         tests 14 pass 14 fail 0
node --test --test-timeout=60000 tests/posting.test.mjs                    tests 16 pass 16 fail 0
node --test --test-timeout=60000 tests/private-scan.test.mjs               tests 35 pass 35 fail 0
node --test --test-timeout=60000 --test-name-pattern="import|manifest|repo files|data" tests/package-alpha.test.mjs   pass 5 fail 0
node --test --test-timeout=60000 tests/studio-launch-d327.test.mjs         tests 4  pass 4  fail 0
node tools/lint.mjs <changed files>                                        0 finding(s)
pre-commit quick checks (build, lint, build-host, build-studio, validators, private-scan, legacy-verify)   9/9 PASS
```

Full CI and the soak were not run (other agents were testing in parallel; the brief excluded them).

## Judgement calls

- **JSON lines, not SQLite:** three writer processes; one append per row needs no lock.
- **"Kept"** is not a click anywhere in the app. It is recorded when a clip is still in My clips at the first check of
  a later app start than the one it was published in (closed and reopened Ujwalam without deleting it); once per
  clip. A later delete adds a "deleted" row; the newest row per clip is the current state.
- **Renames** are matched by NTFS file id (size + mtime where the file system has none), only among video files in
  the day folders of the same clips folder. A clip moved out of that folder counts as deleted.
- **Sessions:** clip and post rows use the clip's run name; hotkey and note rows use `day-<date>` (a moment does not
  know its stream); chat rows use `stream-<local start stamp>`. Every row has its time, so they can be joined later.
- **Not labelled:** posting approve/reject and post title edits (not in the signal list; a title is not a clip name).
- **No flag:** background writing has no visible effect (allowed by the brief); recorded in D338.
- The first launcher pass labels every existing hotkey moment once (signals the user already gave).

## UNVERIFIED

- NTFS file id stability for renames on the user's clips drive (tested on the dev drive in a temp folder).
- Real use: the user's clips folder, a real stream's chat replies, a real YouTube upload.
- Cap behaviour at real sizes (tested with a small cap; the size walk is linear in file count).
