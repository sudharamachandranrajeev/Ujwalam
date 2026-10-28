# 2026-10-28 — P2b A6: labelling page

Step A6 / T5 of `docs/plan/2026-10-27-p2b-plan.md`. Approved by the user on 2026-10-28. No commit, no push, no install. The clips corpus and the analysis cache were only read. Real session ids and the corpus and cache paths appear below as ids and `<placeholders>`; no names, no OCR text and no frames are in this file.

## 1. What was built

| Part | File |
|---|---|
| Server (Node >= 22, stdlib only) | `tools/label/server.mjs` |
| Export writer and validator | `tools/label/labels-export.mjs`, `tools/label/schema-lite.mjs` |
| Page | `tools/label/index.html`, `tools/label/label.js`, `tools/label/label.css` |
| Suggestions converter (Python, stdlib) | `tools/label/suggestions.py` |
| Data | `data/label-tags.json` (proposed tags, UNVERIFIED), `data/session-games.json` (game id per session) |
| Schema | `data/labels.schema.json` (version 1, three optional additions) |
| Tests | `tests/label-server.test.mjs` (19), `tests/py/test_label_suggestions.py` (11) |
| npm script | `npm run label` (prints the URL) |

Start: `npm run label -- --cache <analysis-cache> --corpus <clips-corpus>`. Without flags it reads `paths.analysis_cache` and `paths.clips_corpus` from the gitignored `data/profile.local.json` (the example now has the `analysis_cache` placeholder; the real profile does not have that key yet, so pass `--cache` or add the key). Optional: `--port` (default 8765), `--labels`, `--drafts`, `--suggestions`.

### Server rules (all covered by tests, section 3)

- Binds `127.0.0.1` only (no host option). `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; a present `Origin` must be the same; POST and PUT need `application/json`.
- Serves only four static files (a fixed map). CSP: `default-src 'none'`, scripts, styles, media and images from `self`.
- `GET /media/proxy/<session>` and `GET /media/clip/<session>/<segment index>` stream with HTTP Range (206, 416, suffix and open-ended ranges, HEAD). The client sends ids; paths come from the cache manifest. A manifest clip name that is not a bare file name, or that resolves outside the corpus, is refused.
- `GET /api/session/<id>/frame?t=` cuts one full-quality JPEG from the original clip (ffmpeg, below-normal priority, output to the HTTP response only). `GET .../thumb?t=` cuts a 96 px frame from the proxy for the filmstrip. Two ffmpeg processes at most.
- Writes only two places: the drafts folder (default `data/games/<game>/local/labels-draft/<session>.json`, gitignored; confirmed with `git check-ignore`) and the labels folder (default `data/labels/`). Writes are atomic (temp file, rename).
- Export (`POST .../export`) builds the label file from the draft (ids, times, verdicts, ratings, tags; labeller `<user>`; no OCR text, no suggestion ids), validates it, and writes nothing on failure (422, error strings are paths and keywords, never values). An existing file needs `{"overwrite": true}` (the page asks first).
- Validation: `data/labels.schema.json` (own stdlib checker `schema-lite.mjs`, checked against ajv in a test), `windowEndSec > windowStartSec`, unique ids, times inside the session duration, session known, every event's `detectorId` in the game pack, `medal` in the pack's `events.json` and only on a detector that has a catalogue.

### Label schema change (version 1 kept)

Three optional top-level parts, so every existing file stays valid and no migration is needed:
- `events`: `[{id (e-…), detectorId (pack id pattern), timeSec, verdict accept|reject|added, medal?}]`
- `timing`: `{highlightPassSec, eventPassSec}` (active seconds, idle over 60 s not counted)
- `highlightsEditedAfterSuggestions`: boolean (my addition, see section 6)

The pack cross-check lives in the export validator and a test, not in the schema. `tests/fixtures/g0/labels.example.json` now has events, timing and the flag. `tools/git-hooks/private-scan.mjs` validates files under `data/labels/` against the same schema (ajv when present), so new files with events pass the hook.

### How the blind protocol is enforced

1. The page never requests suggestions or the pack outside `loadPass2Data()`, which runs only after the user confirms opening pass 2 (or re-enters pass 2 of a draft that already opened it). A test checks the page source for exactly those two fetches, both inside that function.
2. The server refuses `GET suggestions` with 403 until the draft holds `pass2.openedAt`. `POST open-pass2` needs `{"confirm": true}`; the page asks (Enter = yes, Esc = no) after saving the draft.
3. `pass2` in the draft is server-owned. A client PUT cannot clear it. On `open-pass2` the server stores a hash of the highlight windows (ids, times, label, rating, tags). Any later PUT whose highlights differ sets `highlightsEditedAfter: true`, and the flag is sticky: it stays true if the edit is reverted. The export carries it as `highlightsEditedAfterSuggestions`. The page shows a banner in pass 1 after pass 2 was opened.
4. Pass 1 shows video and a filmstrip only. The filmstrip comes from the proxy video, not from any signal. The "skip lobby/menu" gate is **left out**: the cache holds no mode data (`manifest.json` has segments, outputs and checks only; the clip mode comes from OCR scans, which are not in the cache). The page says so in pass 1.

## 2. Pass 2 and the suggestions file

`tools/label/suggestions.py` turns `g1_scan analyse` `hits.jsonl` into the page's suggestion file on the session timeline:
- clip time maps through the manifest (`sessionStartSec + (t - clipInSec)`); hits outside the trimmed part are dropped and counted;
- event detectors only (`NAME` is a support signal; kill-feed lines M5/B1 only when the profile name was on the line as killer or victim);
- repeat sightings of one event (same detector, medal, side) within `--merge-sec` (default 4 s) are merged;
- pack `suppressionRules` are applied as marks: a suppressed suggestion stays in the list, greyed, with the rule id and the suppressing suggestion. The pack has no replay duration, so `--replay-before 2` and `--replay-after 10` are my defaults (UNVERIFIED, written to the output as `paramsStatus: unverified`);
- the end-screen rule (`endScreenRule`, M1, M2, K1) is shown: every end screen is listed, `named` says if the profile name was on it, and per match group (`--match-group-sec 120`, UNVERIFIED) the first named screen has `counts: true`, other named screens `counts: false`;
- `ocrText` is a local-only field. The output defaults to `data/games/<game>/local/labels-suggestions/<session>.json`; the tool refuses a path inside the cache or a tracked path inside the repo.

Page actions: A accept, R reject, E move to the playhead, M add a missed event (type picked by number from 37 pack entries: detectors, and M3 expanded to one entry per medal), N/P next/previous. Each decision is a draft event; the original suggested time is kept in the draft, not in the export.

Keyboard (all listed under "?"): Space, J/K/L (1x 2x 4x 8x; reverse is emulated with timed seeks), arrows (+/-1 s, Shift 5 s), `,` `.` (1/30 s), I/O, Alt+I/Alt+O (edit selected window), H (-10 s/+5 s), 1-5, Shift+K/Shift+X, T, N/P, A/R, E, M, Delete, F (full-quality original frame), U and Ctrl+Z, Ctrl+S, G, Tab, ?. Shortcuts do not fire in input, textarea or select fields. Autosave runs every 5 s while the draft is dirty and on `visibilitychange`. Active time per pass is counted each second when the tab is visible and (the video plays or there was input in the last 60 s).

## 3. Tests and checks

All run one at a time. `test:ocr` and `test:capture` were not run.

```
npm test
ℹ tests 172
ℹ pass 172
ℹ fail 0

npm run test:py
Ran 141 tests in 3.478s
OK (skipped=16)

npm run validate:games
OK: 1 game pack(s) valid: codm 0.3.0

node tools/git-hooks/private-scan.mjs scan-worktree
scanned 303 files
exit 0
```

`tests/label-server.test.mjs` (19 tests, all pass; run alone: 19 pass, 0 fail, 0 skipped): binds to 127.0.0.1 only (also tries the machine's LAN address: refused); Host/Origin/JSON-only; Range (200, 206 mid/open/suffix/clamped, 416 for five bad forms, HEAD); original clips by index; manifest and session list expose no clip names or paths; 22 traversal and raw-path requests refused (`..%2f`, `..%5c`, NUL, absolute paths, `?path=`, a manifest with hostile clip names), and a `path` query is ignored; blind protocol (403 before confirm, 400 without `confirm`, server-owned flag, sticky); export validates and the file is valid under ajv and the lite checker; refuses end before start, end equal start, bad rating, bad tag, bad ids, duplicate ids, times beyond the session; unknown `detectorId`, unknown `medal`, medal on a detector with no catalogue, bad verdict, bad id pattern; no writes outside the drafts and labels folders (mtimes and sizes of a temp fake cache, corpus and suggestions folder are identical before and after a full workflow, and no temp files remain); private scan over the exported file with a test profile of fake terms is clean (the draft held those terms in `ocrText`, `note` and `local`) and a control file with a term is caught; frame and thumb endpoints return JPEG from tiny lavfi clips; schema cases (17, ajv and the lite checker agree); tags file; page rules (SPDX headers, no external URLs, no `innerHTML`, colours only in `:root`, the shortcut list).

`tests/py/test_label_suggestions.py` (11 tests): time mapping over a 2-segment manifest (plus a 3rd), outside-trim and unknown clip, counts, merge, suppression kept and marked, replay window parameter, end-screen counts-once rule and match groups, local-only `ocrText`, output guards (cache, tracked repo path, ignored path), CLI run.

`private-scan.mjs` got one additive mode, `scan-files <path>... [--profile P]`, used by the test. It echoes only term numbers.

## 4. Runtime check against the real cache (session `s-2026-10-20-1214`)

Server started with `--cache <analysis-cache> --port 8791` and the labels, drafts and suggestions folders in the session scratchpad (so no real draft and nothing in `data/labels/`). Then stopped (port 8791 free afterwards).

```
GET /api/sessions
{"sessions":[{"id":"s-2026-10-18-1221","game":"codm","durationSec":22710.2963,"clipCount":761,...},
             {"id":"s-2026-10-20-1214","game":"codm","durationSec":25784.7826,"clipCount":864,...}]}
GET /api/session/s-2026-10-20-1214/manifest   -> 864 segments, {'i': 1, 'startSec': 30.372, 'durationSec': 30, ...}
GET /media/proxy/s-2026-10-20-1214  Range: bytes=1000-1999
HTTP/1.1 206 Partial Content ... Content-Length: 1000 ... Content-Range: bytes 1000-1999/3493904217
  body compared with the file bytes 1000-1999: equal (1000 B)
  tail Range bytes=3493903217-: 206, 1000 B, equal to the file tail
  Range bytes=9999999999-: 416
GET /media/clip/s-2026-10-20-1214/5  Range: bytes=0-99 -> 206, 100 B
GET /api/session/.../frame?t=17415.9 -> 200 image/jpeg 283517 B in 0.19 s (original clip, through the manifest)
GET /api/session/.../thumb?t=17415.9 -> 200 3959 B in 0.21 s
GET /api/session/.../suggestions        -> 403 {"error":"pass2-not-opened"}
POST /open-pass2 with {}                -> 400 {"error":"confirm-required"}
```

Suggestions: the converter was run on the existing A5 corpus hits (`docs/evidence/private/g1-corpus/analyse-corpus/hits.jsonl`, 10 sampled clips per session, no new OCR):

```
python -I tools/label/suggestions.py --session s-2026-10-20-1214 --hits docs/evidence/private/g1-corpus/analyse-corpus/hits.jsonl \
  --manifest <analysis-cache>/s-2026-10-20-1214/manifest.json --pack data/games/codm --out <scratchpad>/rt/sugg/s-2026-10-20-1214.json
{"hitsIn": 11718, "hitsOtherSession": 11405, "hitsDroppedByType": 274, "hitsOutsideTrim": 6, "hitsMapped": 33,
 "suggestions": 16, "suppressed": 0, "endScreens": 0, "byDetector": {"M4": 5, "M5": 7, "X1": 2, "M3": 1, "B1": 1}}
```

After a draft save and `open-pass2` (confirm): `GET suggestions` -> 16 suggestions; `GET pack` -> codm 0.3.0, 37 entries. A second PUT with one window changed returned `highlightsEditedAfter: true`. Export to the temp labels folder: `{"ok":true,"labels":1,"events":2,...}`; the file validates under ajv (`valid: true`), has labeller `<user>`, `highlightsEditedAfterSuggestions: true`, and `node tools/git-hooks/private-scan.mjs scan-files <file>` (real profile) exits 0. Nothing was written to `data/labels/`.

Browser: headless Chrome (`--headless=new --screenshot`) loaded `http://127.0.0.1:8791/` and the screenshot shows the page rendered: session list, pass tabs, filmstrip of 12 real thumbnails, timeline, pass 1 panel, "saved" after one autosave (so the load, the API calls, the filmstrip and the autosave ran in a real browser with no CSP block).

## 5. Verified and UNVERIFIED

Verified: everything in sections 3 and 4.

UNVERIFIED (the user needs to try these in a real browser session):
- Interactive use: keyboard shortcuts, the shuttle, frame stepping, I/O/H window marking, rating, tag picker, accept/reject/move/add, undo, the confirm dialogs, "go to time", the full-frame overlay (F). The code is written and the static page rules are tested, but no key was pressed in a browser.
- Video playback and seeking in the real proxy in a browser (the server's byte ranges are verified; headless Chrome showed a black first frame, which is not evidence either way).
- Wheel zoom and drag-seek on the timeline; layout on screens other than 1400x900.
- The time per session (section 7) and whether autosave every 5 s feels right.
- `--replay-before/after`, `--merge-sec` and `--match-group-sec` defaults.
- Lobby/menu skip: not built (no mode data in the cache).

## 6. Proposed reason tags (UNVERIFIED, for the user to approve or replace)

`data/label-tags.json`, status `unverified`. Taken from the tags in the label fixture (`multi-kill`, `funny-reaction`, `quiet`) and the pack's event names (medals, MVP, Impact Play, killstreak card, killcam):

keep: `multi-kill`, `killstreak`, `impact-play`, `mvp`, `killcam`, `clutch`, `funny-reaction`, `fail`
reject: `quiet`, `lobby-menu`

## 7. Pending heavy commands (not run; one heavy job at a time)

### 21 Oct proxy (so the page can show `s-2026-10-21-1916`)

```
python -I services/clip/build_cache.py --index <data-root>/index/index.json --corpus "<clips-corpus>" \
  --cache <analysis-cache> --session s-2026-10-21-1916 --only proxy --verify 12
```

Then add the session to the page: it is already in `data/session-games.json`. Estimate from the A2b build times (NVENC, CPU decode): 1,887 s for 25,785 s of footage (20 Oct) and 1,939 s for 22,710 s (18 Oct) give 0.073 to 0.085 s per second of footage. The 21 Oct trimmed length is 5,250 s, so about 6.5 to 7.5 minutes and about 0.6 GB of disk (20 Oct proxy is 3.5 GB for 25,785 s). `--only proxy` skips the FLAC (about 40 s). Run `build_cache.py` without `--only` if audio is wanted later.

### Pre-fill scan per session (for pass 2)

Run the scan, then `analyse`, then the converter. `<index.json>` and `<analysis-cache>` as above; `P` is a gitignored folder.

```
P=docs/evidence/private/prefill
.venv/Scripts/python.exe -I services/clip/g1_scan.py --threads 4 scan --index <index.json> --corpus "<clips-corpus>" \
  --layout docs/evidence/private/g1-corpus/layout-calibrate.json --out $P/scan --name <session> \
  --sessions <session> --clips-per-session 100000 --fps 0.5
.venv/Scripts/python.exe -I services/clip/g1_scan.py analyse --scan $P/scan/<session>.jsonl \
  --pack data/games/codm --profile data/profile.local.json --out $P/analyse-<session>
python -I tools/label/suggestions.py --session <session> --hits $P/analyse-<session>/hits.jsonl \
  --manifest <analysis-cache>/<session>/manifest.json --pack data/games/codm
```

`--clips-per-session 100000` makes `pick_clips` take every clip. The scan is resumable (it skips frames already in the output file) and is the only heavy step; `analyse` and the converter take seconds. Run it for 18, 20 and 21 Oct, one at a time. The user labels pass 1 first, so the scan can run while they do that.

Compute estimate from the A5 run (full cutout, default OCR profile, 0.5 fps, diff gate 1.5): 2,758 frames, 4,055 s wall, so 1.47 s per frame including decode (median OCR 1,476 ms, p95 2,644 ms):

| Session | Footage (s) | Frames at 0.5 fps | At A5 speed |
|---|---|---|---|
| `s-2026-10-18-1221` | 22,710 | about 11,355 | about 4.6 h |
| `s-2026-10-20-1214` | 25,785 | about 12,892 | about 5.3 h |
| `s-2026-10-21-1916` | 5,250 | about 2,625 | about 1.1 h |

About 11 h of OCR for the three sessions at the A5 speed. This is an upper bound: the pending OCR timing study (`docs/evidence/2026-10-28-p2b-ocr-timing.md`) re-measured the same default profile at 1,073 ms on a full frame idle (A5: 1,476 ms) and the crop profile at 570 ms, and it will set per-detector sample rates and time on screen. The converter does not depend on those numbers; rerun the scan with the cheaper settings when the study is approved. The scan reads whole clips, which overlap each other (21 Oct: 5,387 s of media for 5,250 s of session), so frame counts are about 2 to 3 % higher than the table.

### Time per session (from the plan; UNVERIFIED until the first session is labelled)

| Session | Estimate |
|---|---|
| `s-2026-10-21-1916` | about 35 to 45 min (the plan file says 30 to 40) |
| `s-2026-10-18-1221` | about 2 to 2.5 h |
| `s-2026-10-20-1214` | about 2.5 to 3 h |

The page logs active time per pass (`timing`), so these can be recalibrated from the first export.

## 8. Deviations and open questions

- `highlightsEditedAfterSuggestions` in the label file is an addition beyond the approved schema (the plan only asked for `events` and `timing`). It makes the held-out evaluation able to exclude sessions where blindness was broken. Remove it if not wanted.
- `data/session-games.json` is a new file: sessions have no game field today, and `sessions.json` rule entries are regenerated by `session_index.py`, so the game id could not live there. The user should confirm that all three sessions are CODM (the file says so).
- `data/profile.example.json` gained `paths.analysis_cache`. The real `data/profile.local.json` was not edited; pass `--cache` or add the key.
- The `ocrText` field is shown in the pass 2 list (local screen only). If the user prefers it hidden, it is one line in `label.js`.
- Reverse shuttle (J) is emulated with timed seeks because HTML video has no negative playback rate; it may look jumpy on a 3.5 GB proxy.
- Rating keys 1-5 apply to the selected window only (H selects the window it creates).

## Files created or changed

Created:
- `tools/label/server.mjs`, `tools/label/labels-export.mjs`, `tools/label/schema-lite.mjs`
- `tools/label/index.html`, `tools/label/label.js`, `tools/label/label.css`
- `tools/label/suggestions.py`
- `data/label-tags.json`, `data/session-games.json`
- `tests/label-server.test.mjs`, `tests/py/test_label_suggestions.py`
- `docs/evidence/2026-10-28-p2b-a6-labelling-page.md` (this file)

Changed:
- `data/labels.schema.json` (optional `events`, `timing`, `highlightsEditedAfterSuggestions`; version stays 1)
- `tests/fixtures/g0/labels.example.json` (events, timing, flag)
- `tools/git-hooks/private-scan.mjs` (additive `scan-files` mode)
- `package.json` (script `label`)
- `data/profile.example.json` (`paths.analysis_cache` placeholder)

Outside the repo: temp runtime-check files only, in the session scratchpad (server output, draft, exported label file, suggestions, screenshot, headless Chrome profile). Nothing was written to the corpus, the analysis cache, `data/labels/` or the real drafts folder.

## Review fixes (2026-10-28)

Fixes for the 16 review findings. No install, no commit, no heavy job (the OCR timing run was left alone). The corpus and the analysis cache were not used: every test builds a temp fake cache, corpus and profile. Tests named below are in `tests/label-server.test.mjs` (Node) or `tests/py/test_label_suggestions.py` (Python).

| # | Sev | Fix | Test | Status |
|---|---|---|---|---|
| 1 | HIGH | `readDraft` returns the empty draft only on `ENOENT`. Any other read error (EBUSY, EPERM, EISDIR) or bad JSON throws `500 draft-unreadable`, so GET draft, PUT draft, open-pass2, export and suggestions all refuse, and the file is never written. `GET /api/sessions` marks the session `draftError: true`. Client: if GET draft fails, the saver is blocked (no autosave), the page shows the error in the side panel and the save state, and it keeps no draft in memory. | `finding 1: a draft that cannot be read is a 500 everywhere and is never overwritten` (corrupt JSON, then a folder at the draft path); `finding 1 (client): ...` (source check) | Fixed. Server tested; client by source check only. EBUSY and EPERM are not simulated (EISDIR and corrupt JSON stand in). |
| 2 | HIGH | The export renumbers ids in time order: `l-0001...` by (start, end, draft order), `e-0001...` by (time, draft order). Schema id patterns are now `^l-\d{4,}$` and `^e-\d{4,}$`; the G0 fixture already fits. Every reasonTag must be an id in `data/label-tags.json` (`loadTagIds`: all ids in the file's one tag list, keep and reject alike); otherwise `/labels/i/reasonTags/j not-in-tags`. `labeller` and `note` verified: the export always writes `<user>` and never copies the note; the schema patterns stay `^<[a-z0-9-]+>$`. | `finding 2: export renumbers ids in time order and drops labeller and note text`; `finding 2: every reasonTag must be an id in data/label-tags.json ...`; schema cases in `label schema: fixture validates ...` (ids `e-1`, `e-Name`, `e-0001-x`, `l-Name`, `l-001` now refused; a free-text note refused) | Fixed |
| 3 | MED | `round3` rounds only finite numbers and keeps any other value. Missing fields are dropped, so the validator reports `required` or `type` instead of writing 0. `timing` is written only when the draft has one. | `finding 3: missing or non-number times are refused, never written as 0` | Fixed |
| 4 | MED | A request with `Sec-Fetch-Site` other than `same-origin` or `none` gets `403 cross-site` on every API and media route (the four static page files are exempt). ffmpeg: at most 2 processes and at most 24 waiting jobs; above that `503 busy` (`Retry-After: 1`). When the client closes the request, a queued job is dropped and a running ffmpeg is killed (spawn `signal`). | `finding 4: cross-site requests are refused (Sec-Fetch-Site) before any ffmpeg or file work`; `finding 4: the ffmpeg queue is capped (503) and a closed request drops its job or kills its ffmpeg` (a fake slow ffmpeg records its pid; queue max 2 in the test; the pids are checked dead) | Fixed |
| 5 | MED | New `tools/label/label-core.js` (plain script, no DOM): `createSaver()` chains every save on one promise, and `save()` rejects on failure. Export, open-pass2 and the session switch stop and show the error; the session select goes back to the current session when the save fails. | `findings 5 and 6: client saves run one at a time, reject on failure, and keep edits made in flight dirty` | Fixed (unit test of the extracted logic; not run in a browser) |
| 6 | MED | Dirty is an edit counter in the saver. A save marks clean only the edits counted when it was sent. The timing tick also counts as an edit. | same test as 5 | Fixed (unit test) |
| 7 | MED | The open-pass2 confirm captures the session id and the draft object at confirm time; the POST goes to that id. `loadPass2Data(id)` and `openSession(id)` ignore results when `S.id` has changed. The suggestions are read as `(r[1] && r[1].suggestions) \|\| []`. | `finding 7: an async result from a previous session is ignored` (saver reset unit test, plus source checks of `label.js`) | Fixed (the `label.js` part is covered by a source check, not by running the page) |
| 8 | MED | PUT draft compares the body's `updatedAt` with the stored one and returns `409 draft-changed` on a mismatch. `updatedAt` always moves forward (+1 ms when needed), also on open-pass2. Client: on 409 the saver is blocked and the page shows "draft changed elsewhere, reload". open-pass2 runs through the same save queue, so an autosave cannot race it into a false 409. | `finding 8: PUT draft with a stale base is 409, the stored draft is kept` | Fixed |
| 9 | MED | At startup `checkRoots` resolves the real paths of the labels and drafts folders (through the nearest existing parent, so nothing is created before the check). It refuses to start (`unsafe-folders`) if a writable folder is inside the cache or the corpus, or the cache or the corpus is inside a writable folder. A drafts folder inside the repository must pass `git check-ignore`. The folders are created only after the checks pass. | `finding 9: startup refuses writable folders that overlap the cache or corpus, and drafts not gitignored` (also a junction into the cache) | Fixed. Deviation: a drafts folder outside the repository is not checked with git (git cannot track it; `check-ignore` exits 128 there). |
| 10 | MED | `check_out` requires realpath(`--out`) to be a file inside `<repo>/data/games/<pack game id>/local/`. It still refuses the cache and still runs `git check-ignore`. The docstring says so. | `test_out_must_be_inside_the_game_local_folder`; `test_cli_writes_file_in_local_and_refuses_elsewhere` | Fixed |
| 11 | MED | keydown: Enter or Space on a focused BUTTON outside a modal is ignored (`preventDefault`, blur, no shortcut); keyup Space on such a button is also prevented. Every clicked button is blurred. | `finding 11: Enter and Space on a focused button outside a modal are ignored; clicks drop the focus` (unit test of `isButtonActivationKey`, plus a source check) | Fixed (no browser run) |
| 12 | LOW | `write_atomic`: temp file in the same folder, then `os.replace`; the temp file is removed on failure. Client one-liner as in 7. | `test_write_is_atomic`; client part in the `finding 7` test | Fixed |
| 13 | LOW | putDraft refuses with `422 bad-draft-shape` and a pointer (`at`, never a value) when `labels` or `events` is not an array, an element is not an object, `reasonTags` is not an array of strings, or `timing` or `ui` is not an object. | `finding 13: PUT draft refuses a bad shape with 422 and writes nothing` | Fixed |
| 14 | LOW | A declared `Content-Length` over 8 MiB is refused before reading; an overflow while reading stops collecting. Either way the 413 is sent with `Connection: close`, and the request is destroyed only after the response has finished. | `finding 14: an oversized body gets a 413 response before the request is dropped` (raw socket) | Fixed. The chunked-overflow path (no Content-Length) has no test. |
| 15 | LOW | A multi-range or non-`bytes` Range is ignored and the whole file is sent with 200. The unit is matched case-insensitively. Invalid single `bytes=` ranges still get 416. | `finding 15: a multi-range or unknown-unit Range is ignored (200, whole file)`; `Range responses are correct` (416 list updated) | Fixed |
| 16 | LOW | A zero-byte file gets an empty 200, with or without Range. | `finding 16: a zero-byte file is an empty 200, with or without Range` | Fixed |

Not fully fixed or not fully proven:
- Client findings 1, 5, 6, 7, 11 and the client half of 12: the logic in `label-core.js` is unit-tested under `node:vm`. The wiring in `label.js` is checked only by reading the source. No key was pressed in a browser, so the interactive behaviour stays UNVERIFIED (as in section 5).
- 1: EBUSY and EPERM are not simulated.
- 4: the queue cap of 24 is my default (UNVERIFIED). The filmstrip does not retry a thumbnail that got 503; the image stays empty until the next redraw.
- 9: a drafts folder outside the repository skips the git check (see the table).
- 14: no test covers the chunked overflow.
- 2: the label-tags check accepts any id in the file. It does not check that a tag's `applies` (keep or reject) matches the window's label; the review did not ask for that.

Test runs (one at a time):

```
node --test tests/label-server.test.mjs
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0

npm test
ℹ tests 188
ℹ pass 188
ℹ fail 0

python -I -m unittest discover -s tests/py -t tests/py -p "test_label*.py" -v
Ran 13 tests in 0.273s
OK

node tools/git-hooks/private-scan.mjs scan-worktree
scanned 305 files
exit 0
```

`tests/label-server.test.mjs` went from 19 to 35 tests and `tests/py/test_label_suggestions.py` from 11 to 13. The old `test_cli_writes_file_outside_repo` became `test_cli_writes_file_in_local_and_refuses_elsewhere`: it writes into a temp folder under `data/games/codm/local/` (gitignored) and removes it afterwards. The finding 9 test also creates and removes `data/games/codm/local/.label-test-drafts-<pid>/`.

### Files created or changed

Created:
- `tools/label/label-core.js`

Changed:
- `tools/label/server.mjs`
- `tools/label/labels-export.mjs`
- `tools/label/label.js`
- `tools/label/index.html` (loads `/label-core.js`)
- `tools/label/suggestions.py`
- `data/labels.schema.json` (id patterns `^l-\d{4,}$` and `^e-\d{4,}$`; descriptions)
- `tests/label-server.test.mjs`
- `tests/py/test_label_suggestions.py`
- `docs/evidence/2026-10-28-p2b-a6-labelling-page.md` (this section)

Not changed: `tools/label/schema-lite.mjs`, `data/label-tags.json`, `tests/fixtures/g0/labels.example.json` (it already fits the new id patterns and tags).

## Review fixes round 2 (2026-10-28)

The user approved the round 1 fixes and added the items below. Every item has a regression test. A part that runs only in the browser (modal dialogs, `pagehide`, the heartbeat timer) cannot be unit-tested. For those parts, the pure logic lives in `tools/label/label-core.js` and is unit-tested through `node:vm`. Separate string checks on `tools/label/label.js` show that the page calls that logic in the right place. These are marked "(client, string check)" below.

| Item | Fix | Test | Status |
|---|---|---|---|
| D1 | Kept from round 1. Only ENOENT is an empty draft. Any other read error (corrupt JSON, EISDIR, a draft without an integer `revision` ≥ 1) is a 500 on GET, PUT, open-pass2, export, export-preview and suggestions. The file is left as it was. The page blocks autosave and shows the error. | `finding 1 / D1` (server), `finding 1 / D1 (client)` (client, string check) | PASS |
| D2 | PUT refuses labels or events going from more than 0 to 0. It returns 409 `would-empty-draft` with `at` set to `/labels` or `/events`, unless the body has `allowEmpty: true` (a boolean; any other value gives 422). `allowEmpty` is never stored. The page never sends such a PUT: `save()` checks `core.wouldEmpty(savedCounts, draft)`. Delete and undo call `confirmIfEmptying`, which opens a "delete last item" confirm and only then sets `allowEmpty`. | `D2` (server), `D2 (client)` (`wouldEmpty` unit test + string check) | PASS |
| D3 | Writes are atomic: temp file in the same folder, then rename; no `.tmp` is left. Before each draft write, a backup `backups/<session>/r<revision, 8 digits>.json` is written next to the drafts. It is pruned to the newest 20. The default drafts folder is gitignored, so its backups are too. | `D3`: 25 saves leave exactly `r00000006`–`r00000025`, each parses, and the newest equals the stored draft. `git check-ignore` covers the default backups path. | PASS |
| D4 | The pass-2 record moved to `<drafts>/<session>.pass2.json`. Only open-pass2 writes it, plus the edited-after detection in PUT when the highlights hash changes. A `pass2` field in a PUT body is ignored; the draft never stores it. A pass-2 file that cannot be read (anything but ENOENT; also a file without a string `openedAt`) gives 500 `pass2-unreadable` on draft GET/PUT, suggestions, export, export-preview and open-pass2, and the file is not touched. | `D4` (two tests: sole writers; corrupt, wrong shape and EISDIR) | PASS |
| N1 | Re-checked every exported field. Top level: `version, sessionId, labels, events?, timing?, highlightsEditedAfterSuggestions?`. Labels: `id` (renumbered `l-0001`… in time order), numbers, `label` enum, `rating`, `reasonTags` (ids from `data/label-tags.json`), `labeller` = `<user>`, `createdAt`. Events: `id` (renumbered `e-0001`…), `detectorId` and `medal` from the pack, `timeSec`, `verdict` enum. `suggestionId`, `suggestedTimeSec`, `ocrText` and notes are never copied. Without pass 2 there are no events and no edited flag. `buildLabelFile` takes the pass-2 record as a parameter. | `finding 2 / N1` (exact key sets per level), `export validates…` | PASS |
| N2 | Free text is never in drafts or labels. Option chosen: **`note` removed from the schema** (also `$schema`), and `labeller` is now `const "<user>"`. PUT refuses `note` or any unknown field with 422 and a pointer (`/labels/0/note unknown-field`); errors never echo values. Notes go through `POST /api/session/<id>/note {ref, text}` (lock owner only; `ref` is a draft-local `l-`, `e-` or `sg-` id; text 1–2000 chars). Each note is appended as `{t, ref, text}` to `data/games/<game>/local/label-notes/<session>.jsonl` (gitignored; `--notes` overrides). The page has a Note modal (Shift+N, Note buttons). The export never reads notes. | `finding 2 / N2`, `N2`, g0 schema cases (`note`, `<jane>`, `$schema`) | PASS |
| N3 | The pre-commit hook (`tools/git-hooks/private-scan.mjs`, labels rule) validates every staged file under `data/labels/` with the same stdlib validator as the server (`labels-export.mjs` + `schema-lite.mjs`). The ajv/mini validator is gone. It checks: the schema exactly (additionalProperties false at every level, id patterns, labeller const), tags in `label-tags.json`, sessionId in `sessions.json`, windowEnd > windowStart, unique ids, and detectorId and medal in the session's pack. The file name must be `<sessionId>.json`, only `.json` and an empty `.gitkeep` are allowed, and subfolders are refused. It fails closed if the validator or the data cannot load, and never echoes values. The schema has no free-text strings left (every string is an enum, const, pattern or date-time). | `tests/private-scan.test.mjs` labels tests: valid passes; extra field, free-text tag, name-shaped id and unknown tag each blocked; plus file rules and history. Real-hook demo below. | PASS |
| S1 | Per-launch token: `crypto.randomBytes(32).toString('hex')`. The page URL is `http://127.0.0.1:PORT/?t=TOKEN`. The page reads it (`core.readToken`) and sends `X-Label-Token` on every fetch. Only element `src` (video, frame `img`, thumb `img`) uses `?tok=` (`t` is already the time parameter on frame and thumb). The server compares `sha256(given)` with the launch hash through `crypto.timingSafeEqual` on every API, media, frame and thumb route; failures get 401 `bad-token`. `?tok=` is accepted only on media, frame and thumb, never on the JSON API. Static files (`/`, `label.js`, `label-core.js`, `label.css`) load without the token and contain no data or token. The Sec-Fetch-Site check stays; an Origin or Referer that is not this server gives 403 (`Referrer-Policy: no-referrer` is set). **This token is not the app's local JSON-RPC API token.** CLAUDE.md's "browser layers never receive the local API token" is about the Qt app's JSON-RPC token. This is a separate secret, made by the stand-alone labelling server at each launch, valid only for that server on 127.0.0.1, and gone when it exits. The labelling page is a local tool page, not a browser layer, and it never sees the app's token. | `S1` (every route × no, wrong, short, long and upper-case token; `?tok=` scope; static files; per-launch uniqueness; `readToken` unit test; the `timingSafeEqual` use is a code check, because timing cannot be unit-tested) | PASS |
| S2 | The ffmpeg queue runs 2 jobs with up to 50 waiting; beyond that, 503 `busy`. Closing a waiting request drops its job; closing a running request kills its ffmpeg. | `finding 4 / S2` (fake ffmpeg: 2 running + 50 queued, the 53rd gets 503, kills checked by pid) | PASS |
| S3 | Writable-folder allowlist: labels, drafts, backups, pass2 (in drafts) and notes. Every write calls `assertWritable` by real path before and after `mkdir`. The parent must be one of those folders (or a session folder under backups). It must not be inside the cache or corpus, and neither may be inside it, so junctions are caught. At startup, folders that overlap in either direction are refused (`unsafe-folders`), as are drafts or notes folders in the repo that are not gitignored. `suggestions.py --out` follows the same rule. It now takes `--corpus` (default `paths.clips_corpus` from `--profile data/profile.local.json`) and refuses an unknown corpus (fail closed). The cache and corpus are compared by real path in both directions, checked again after `makedirs`. | `finding 9 / S3` (startup, incl. junctions into the cache), `S3: a junction placed … after startup` (500 `unsafe-write`, cache unchanged), py `test_corpus_is_read_only_in_both_directions`, `test_corpus_from_profile`, CLI case | PASS |
| C1 | One writer per session. A lock file `<drafts>/<session>.lock` holds `{launchId, tab, pid, heartbeatAt}` and is created with `wx`. The page heartbeats every 10 s. Every write route needs the `X-Label-Tab` of the owner, else 423 `not-lock-owner`. A second tab or launch is read-only: saves are blocked, edits refused, and a "Read-only: …" notice is shown. A lock is stale after 30 s without a heartbeat, when its pid is dead, or when the file is unreadable. A stale lock is taken over (`takeover: true`) only from a confirm dialog. Unlock (page `pagehide` keepalive, session switch, server close or SIGINT/SIGTERM) marks the lock released. During a 2 s grace, an in-flight save from the owner still lands; other tabs are told `retryMs`. | `C1` (second tab, 423 on every write route, stale by time, dead pid and broken file, confirm-only takeover, old owner shut out, release grace, other live launch respected, released on close; client string checks) | PASS |
| C2 | An integer `revision` replaces `updatedAt`. PUT needs the stored revision: a stale, missing or non-integer revision gives 409 `draft-changed` or 422, and nothing is merged. Success returns `revision + 1`. open-pass2 does not change the draft revision. | `finding 8 / C2` | PASS |
| C3 | `checkDraft` refuses non-finite, negative, past-session-end and end ≤ start times. PUT returns 422 `invalid-draft` with `at` (first pointer) and `errors`. Export runs the same check on the stored draft (422), so an old or hand-edited draft cannot export. Nothing is coerced to 0. | `C3` (PUT pointers), `finding 3 / C3` (export), `export refuses invalid labels` | PASS |
| C4 | `POST /api/session/<id>/export-preview` returns `{exists, diff:{added, removed, changed}, labels, events}` (by renumbered id and time) without writing. Export with an existing file and no `overwrite` returns 409 with the same diff. The page saves, previews, shows a confirm with `core.diffLines` (ids and times only, capped), and only then exports. "Add highlight" (H and the button) is ignored when repeated within 1 s at the same playhead (`createRepeatGuard(1000, 0.05)`). | `C4` (preview no-write, diff contents, 409 diff, `diffLabelFiles`, `diffLines`, repeat guard unit tests; client string checks for the order preview, confirm, export) | PASS |

### Commands (run one at a time, 2026-10-28)

```
node --test tests/label-server.test.mjs
tests 47  pass 47  fail 0

npm test
tests 203  pass 203  fail 0

python -I -m unittest discover -s tests/py -t tests/py -p "test_label*.py" -v
Ran 15 tests  OK

npm run test:py
Ran 145 tests  OK (skipped=16)
  skips are environment-only and unchanged: OCR venv (7), OCR venv + ffmpeg (2), numpy/cv2/ffmpeg (1),
  UJWALAM_CAPTURE_TESTS (3), capture with dshow (3)

node --test tests/private-scan.test.mjs
tests 18  pass 18  fail 0

node tools/git-hooks/private-scan.mjs scan-worktree
scanned 305 files
exit 0
```

### Real pre-commit hook against staged label files (throwaway repo)

The demo ran in a throwaway `git init` repo in the session scratchpad, deleted afterwards. It held copies of `tools/git-hooks/*`, `tools/label/labels-export.mjs`, `tools/label/schema-lite.mjs`, `data/labels.schema.json`, `data/label-tags.json`, `data/sessions.json`, `data/session-games.json`, `data/games/codm/*.json` and `.gitignore`, with `core.hooksPath tools/git-hooks` and a FAKE `data/profile.local.json` (gitignored there). `git commit` ran the real hook:

```
== VALID: git commit (runs tools/git-hooks/pre-commit)
[demo 20844b8] valid label file
 1 file changed, 12 insertions(+)
 create mode 100644 data/labels/s-2026-10-18-1221.json
exit=0
== INVALID: extra free-text field, unknown tag, name-shaped id, non-<user> labeller, end<=start
data/labels/s-2026-10-18-1221.json:5: labels rule: schema violation at /labels/0 additionalProperties
data/labels/s-2026-10-18-1221.json:6: labels rule: schema violation at /labels/1/id pattern
data/labels/s-2026-10-18-1221.json:7: labels rule: schema violation at /labels/2/labeller const
exit=1
== unknown tag
data/labels/s-2026-10-18-1221.json:5: labels rule: schema violation at /labels/0/reasonTags/0 not-in-tags
exit=1
== end<=start
data/labels/s-2026-10-18-1221.json:5: labels rule: schema violation at /labels/0 end-not-after-start
exit=1
== unknown session
data/labels/s-2026-10-18-1221.json:1: labels rule: schema violation at /sessionId unknown-session
exit=1
```

The validator reports schema errors first and returns. The tag, time and session checks run on a schema-valid file, which is why they are shown on their own. In the real repo, nothing was committed and nothing is staged (`git diff --cached --name-only` is empty; HEAD is still `8b4cd90`).

### Notes and deviations

- Notes may also reference a suggestion (`sg-…`), so a note can be written in pass 2 before a suggestion is accepted.
- D2 is checked per list (labels or events going from more than 0 to 0), not on the total.
- The hook reads the schema, tags, sessions and packs from the worktree, not from the staged copies. A commit that changes the schema and a label file together is validated against the worktree schema.
- `.jsonl` is no longer allowed under `data/labels/`: only `<sessionId>.json` and an empty `.gitkeep`.
- `medal` stays a pattern in the schema. The export writer and the hook restrict it to the session pack's catalogue, and a detector with no catalogue refuses a medal.
- The token query parameter on element `src` is `tok`, because `t` is the time on frame and thumb. The page URL uses `?t=` as requested.
- Releasing the lock marks it released with a 2 s grace instead of deleting the file at once, so a save sent just before `pagehide` still lands. Server close removes this launch's lock files.
- A round-1 draft (with `updatedAt` and no `revision`) gives 500 `draft-unreadable`. None exist on this machine: `data/games/codm/local/` holds only `medals-reference`.
- `suggestions.py` now needs a known corpus. On a machine without `paths.clips_corpus`, pass `--corpus`.

### Files created or changed (round 2)

Changed:
- `tools/label/server.mjs`
- `tools/label/labels-export.mjs`
- `tools/label/label-core.js`
- `tools/label/label.js`
- `tools/label/label.css` (`textarea` styled like inputs, for the Note modal)
- `tools/label/suggestions.py`
- `tools/git-hooks/private-scan.mjs` (labels rule)
- `data/labels.schema.json` (removed `note` and `$schema`; `labeller` const `<user>`; descriptions)
- `tests/fixtures/g0/labels.example.json` (removed the `note` on label 2)
- `tests/g0-schemas.test.mjs` (negative cases)
- `tests/private-scan.test.mjs` (labels rule tests)
- `tests/label-server.test.mjs` (35 to 47 tests)
- `tests/py/test_label_suggestions.py` (13 to 15 tests)
- `docs/evidence/2026-10-28-p2b-a6-labelling-page.md` (this section)

Not changed: `tools/label/index.html`, `tools/label/schema-lite.mjs`, `tools/git-hooks/pre-commit`, `data/label-tags.json`.

## Review fixes round 3 (2026-10-28)

These are fixes for the second Opus review. Each item has a regression test. Server tests are in `tests/label-server.test.mjs`. Hook tests are in `tests/private-scan.test.mjs`.

| Item | Fix | Test | Status |
|---|---|---|---|
| H1 | The saver now has a block kind: `block(why, kind)`, `unblock(kind)` and `blockedKind()`. The new `core.lockReply` turns a lock reply into an action (writer, retry, stale or held). On writer it lifts only a `read-only` block. A `changed` or `draft-load` block stays. `applyLock` uses it. The banner says "AUTOSAVE IS OFF: ..." whenever the saver is blocked. | `H1: after F5 the new tab waits for the release, gets the lock, and autosave runs again` (real server: lock, unlock, retry, then writer; the save is sent). | PASS |
| H2 | `schema-lite.mjs` uses `Object.hasOwn` for `$ref`, `const`, `required`, `properties` and each `$ref` step. `labels-export.mjs` replaces its two `in` checks the same way. The rest of schema-lite was reviewed: no other `in` or plain property lookups on data or schema keys remain. | `H2: keys named like Object.prototype members ...` checks 9 prototype names at the top, label, event and timing levels, both as own keys and from text. lite and ajv agree. It also covers mini schemas for `required` and `properties`, and a `$ref` to `toString` (now throws). `H2: PUT draft refuses ...` returns 422 at the top, label and event levels. Hook test `H2: prototype-named keys ...` covers 4 levels. ajv stays a dev dependency, used in tests only. | PASS |
| M1 | The hook copies the validator and its data from the index (`git show :<path>`) into a temp folder and imports them from there. A missing file fails closed: "label validator or its data not in the index (...); stage it, failing closed". When a staged path touches labels or the validator's inputs, the hook refuses the commit if `tools/label/*.mjs` or `data/labels.schema.json` differs between the index and the worktree, or is untracked. A first commit that stages the validator, its data and labels together is checked against the staged copies. | Hook tests: `M1: not in index / worktree-only / first commit together / pack not staged`. Also `M1: a loosened unstaged validator is blocked ...` (untracked `extra.mjs`, unstaged schema, unrelated commit not affected). Demo steps 1, 5 and 6. | PASS |
| M2 | Pre-commit uses `--diff-filter=d --no-renames`: every change kind except deletion, including T (typechange). Index modes come from `ls-files -s`. Under `data/labels/`, mode 120000 (symlink) and 160000 (gitlink) are a hit. Pre-push and history use `ls-tree -r <tip> -- data/labels/` for modes. The worktree scan uses lstat. | `M2: typechange T, symlink, gitlink, pre-push gitlink`. Demo step 4. | PASS |
| M3 | One shared `localRule`, used in pre-commit, pre-push or history, and the worktree scan. It blocks `^data/games/[^/]+/local/` and any `*.local.*` name. Names that contain `.example.` are allowed, for example `data/profile.example.json`. | `M3: local paths, *.local.*, templates allowed, pre-push history`. Demo step 3. | PASS |
| M4 | A blob that `git show` cannot read now gets the labels rule before anything else. Under `data/labels/`, an unreadable blob is a hit: "file cannot be read, failing closed". Elsewhere it is skipped, as before. | `M4: missing blob under data/labels is a hit; elsewhere skipped`. | PASS |
| M5 | `beforeunload` prompts when `core.unloadPlan(saver).prompt` is true: something is dirty or the saver is blocked. A read-only tab with no edits does not prompt. At `pagehide` the final save goes directly as a `fetch` PUT with `keepalive: true`, built by the same `draftBody()` as `save()`. It is sent only when the draft is dirty, the saver is not blocked, and the body is at most 60000 bytes. The unlock follows. No sendBeacon is used (see the notes). | `M5: the tab-close prompt shows ...`: unloadPlan cases plus checks on the beforeunload and pagehide code. | PASS (prompt and keepalive PUT; no beacon) |
| M6 | `diffLabelFiles` matches labels on `[windowStartSec, windowEndSec]` and events on `[detectorId, timeSec]`. A moved window counts as removed plus added. "changed" means the same key with other fields different, and it carries `wasId`. Duplicates pair first with an identical old item. | `M6: the export diff matches ...`: insert gives only "added", changed with `wasId`, detector or time moves, duplicates, and through the server. The C4 expectations were updated. | PASS |
| M7 | The page sends a heartbeat on `visibilitychange` to visible (hidden still saves). A live owner's lock goes stale after 5 min without a heartbeat (`LOCK_STALE_MS`). A dead owner pid is stale at once. Other numbers: heartbeat every 10 s, release grace 2 s, retry after a lost claim 500 ms, claim file stale after 10 s. | `M7: a live owner keeps the lock for 5 min ...`: 1 min held, 4.5 min held, over 5 min stale, dead pid stale. Client string checks. | PASS |
| M8 | The new exported `claimLock` makes an exclusive `<lock>.claim` (`wx`). Only the claim's creator re-checks that the lock can still be claimed, writes it, and reads it back to check its own launchId and tab. The claim file is removed only if it is still ours. A claim file left by a crashed claimant is cleared after 10 s. Losing a claim returns `retryMs: 500`. | `M8: claiming a released or stale lock is exclusive ...` (unit): B claims inside A's claim and loses; A's re-check sees B's lock; a write lands before the read-back; a crashed claim file. Through the server: a second launch writes in the `afterClaim` hook; two tabs race and exactly one becomes the writer. | PASS |
| M9 | Next revision = `max(stored.revision, highest rNNNNNNNN backup) + 1`. Each backup is written to a temp file with `wx`, then hard-linked to its final name, so an existing backup is never replaced (EEXIST gives 500 `backup-exists`). Pruning is numeric. | `M9: the next revision is above every backup ...`: draft deleted after r1..r3 gives revision 4 with r1..r3 byte-identical; an older restored draft gives 5; a hand copy r7 is kept and the next is 8. | PASS |
| M10 | `export-preview` returns `sha256` of the exact text it would write, and `existingSha256` (null when no file exists). Export needs both. It writes exactly that text. A mismatch is 409 `changed-since-preview` with a fresh `preview`; the 409 `exists` reply also carries it. The client pauses autosave from the pre-export save until the dialog closes (`S.exporting`). It sends the hashes, and on a 409 with a preview it shows the dialog again with the new diff. | `M10: export writes exactly the previewed document ...`: no hash, an autosave after the preview, the existing file changed, a wrong or missing existing hash, file sha equals preview sha. Client checks. Every other export test now previews first (`exportNow`). | PASS |
| M11 | Frame and thumb replies use the default `Cache-Control: no-store`. Media streams already did. | `M11: frame and thumb replies are Cache-Control: no-store` uses a fake ffmpeg that writes JPEG bytes. It checks frame, thumb, a thumb from the memory cache, proxy and clip. | PASS |

### Commands (run one at a time, 2026-10-28)

| Command | Result |
|---|---|
| `node --test tests/label-server.test.mjs` | tests 57, pass 57, fail 0, skipped 0 |
| `node --test tests/private-scan.test.mjs` | tests 25, pass 25, fail 0, skipped 0 |
| `npm test` | tests 220, pass 220, fail 0, skipped 0 |
| `npm run test:py` | Ran 145 tests, OK (skipped=16, environment skips as before) |
| `python -I -m unittest discover -s tests/py -t tests/py -p "test_label*.py" -v` | Ran 15 tests, OK |
| `node tools/git-hooks/private-scan.mjs scan-worktree` | scanned 305 files, exit 0 |

### Real pre-commit hook (throwaway repo, fake profile)

The demo ran in a throwaway repo in the session scratchpad, deleted afterwards. It used `core.hooksPath tools/git-hooks` with copies of the hooks, the validator and its data, a FAKE `data/profile.local.json`, and the repo identity. Each step ran `git commit` (no `--no-verify`).

| Step | Expected | Hook output | Exit |
|---|---|---|---|
| 1. First commit: validator, data and a valid label staged together | pass | (none) | 0 |
| 2. Label with a top-level `constructor` key | block | `labels rule: schema violation at / additionalProperties` | 1 |
| 3. `data/games/codm/local/crop.json` (`git add -f`) | block | `local rule: data/games/<game>/local/ is local-only and never committed` | 1 |
| 4. Symlink `data/labels/link.json` (`update-index --cacheinfo 120000`) | block | `labels rule: symlink not allowed (only regular files)` | 1 |
| 5. Label staged, `labels-export.mjs` changed but not staged | block | `labels rule: the label validator differs between the index and the worktree (stage or stash the change), failing closed` | 1 |
| 6. Same label after the validator change is reverted | pass | (none) | 0 |

The real repo was checked afterwards: HEAD is `8b4cd90` and nothing is staged.

### Notes and deviations

- M1 scope: the index-versus-worktree refusal applies only when the commit touches `data/labels/` or the validator's inputs. Unrelated commits are not affected.
- M1, for the real A6 commit: `data/label-tags.json` and `data/session-games.json` are untracked today. They must be staged in the same commit as any label file, or the hook fails closed.
- Pre-push and history checks validate label blobs against the validator and data in the first pushed tip.
- M5, why no beacon: `navigator.sendBeacon` cannot set the `X-Label-Token` header. A token-in-body route with a `text/plain` body would accept a content type a cross-site form can send, which weakens the API checks. In Chromium it also shares the about 64 KiB keepalive quota (UNVERIFIED for other browsers), so it would not carry a larger draft either. A draft over 60000 bytes at tab close relies on the prompt and the regular autosave.
- M7 trade-off: a tab that was discarded without `pagehide` (its launch still running) blocks a reload in another tab for up to 5 min. The user can then take over through the confirm dialog only once the lock is stale.
- M10: export always needs the preview hashes, including for a new file. A client without them gets 409 with a preview.
- H2: ajv's own `required` check accepts an inherited member unless `ownProperties: true` is set. The mini-schema agreement test uses that option. The label schema test uses the default ajv, because its `additionalProperties` already refuses these keys.
- I edited files created during this uncommitted A6 work (listed below). No committed file was deleted or renamed.

### Files created or changed (round 3)

Changed:
- `tools/label/schema-lite.mjs` (`Object.hasOwn` throughout)
- `tools/label/labels-export.mjs` (`Object.hasOwn`; time-matched diff)
- `tools/label/server.mjs` (`claimLock`, lock stale rules, backup numbering and no-overwrite, export hashes, `no-store` on thumbs)
- `tools/label/label-core.js` (saver block kinds, `lockReply`, `unloadPlan`, `diffLines` with `wasId`)
- `tools/label/label.js` (lock reply, banner, beforeunload and keepalive final save, visible heartbeat, export hashes and pause, modal cancel)
- `tools/git-hooks/private-scan.mjs` (index context, index/worktree check, all change kinds, modes, local rule, unreadable blobs)
- `tests/private-scan.test.mjs` (19 to 25 tests)
- `tests/label-server.test.mjs` (47 to 57 tests; existing export tests preview first)
- `docs/evidence/2026-10-28-p2b-a6-labelling-page.md` (this section)

Not changed: `tools/label/index.html`, `tools/label/label.css`, `tools/label/suggestions.py`, `tools/git-hooks/pre-commit`, `data/labels.schema.json`, `data/label-tags.json`.

## Review fixes round 4 (2026-10-28)

These fix 8 risks found by the re-check of round 3. Each has a regression test. Server tests are in `tests/label-server.test.mjs` and hook tests in `tests/private-scan.test.mjs`.

| Item | Fix | Test | Status |
|---|---|---|---|
| R1 (blocker) | `core.lockReply` now returns `reload: true` when the writer reply came on a retry (`tries > 0`). In that case `applyLock` calls `openSession(id)` before it marks the tab as writer, the same as after a take-over. The reloaded draft then holds the old tab's final save, which landed during its 2 s release grace. The lock reply that comes with the reload is a first try, so it does not reload again. | `R1: after F5 with unsaved edits ...` (real server): the old tab saves, the new tab reads revision 1, the old tab unlocks, then its final save lands (revision 2). The new tab gets retry, then writer with `reload: true`. A save from the stale draft is 409; the reloaded draft has both labels and saves with 200. | PASS |
| R2 (blocker) | A stale claim file is no longer deleted. `claimLock` reads its content, renames it to a unique `<claim>.<pid>.<random>.stale` name, and reads it again there. If the content is not the one judged stale, it was another claimant's live claim: it is put back with `placeExclusive` (never over a newer claim) and this claimant returns false. A winner also checks, after its write and read-back, that its own claim file (with a random nonce) is still in place. Only one claim can sit at the claim path at a time, so only one claimant can pass that check. | `R2: a stale claim file is broken without ever deleting a live claim ...`: (1) B breaks the stale claim and claims while A is between its stat and its rename; A moves B's claim, restores it and loses; (1b) the same without hard links (copy restore); (2) B completes a whole claim inside A's window; A finds nothing to break; B is the only winner; (3) a claim moved away after A's write means A does not win; (4) a crashed claim is still broken. No `.stale` files remain. | PASS |
| R3 (blocker) | The `.example.` allowance is removed. Any path matching `/\.local\./i` is blocked. `data/profile.example.json` has no `.local.` and still passes. | `R3: no template allowance ...`: `settings.example.local.json`, `data/profile.local.example.json`, `x.example.local.json` and `cfg/a.local.b.example.yaml` are blocked; `data/profile.example.json` passes. Demo step 1. | PASS |
| R4 | Both local-rule regexes have the `i` flag: `/^data\/games\/[^/]+\/local\//i` and `/\.local\./i`. | `R4: the local rule ignores case ...`: `Foo.LOCAL.json`, `data/games/codm/Local/x.json` and `data/games/codm/LOCAL/y.json` are blocked in pre-commit and scan-worktree. Demo steps 2 and 3. | PASS |
| R5 | Pre-push and history scans take paths from `git log --raw -z --no-renames -m --no-abbrev --format= <tips>`: one record per added or changed path in every commit, including merges against each parent. Path terms and the local rule run once for every path, and the labels rule runs for every path of each label blob. Content is still scanned once per blob. Symlink and gitlink modes under `data/labels/` are now also checked in history, not only at the tips. | `R5: pre-push checks every path of a blob ...`: a `local/` path and a term path with the same bytes as `docs/a.json` are hits in pre-push and in scan-history after removal. A second, misnamed label path with the same bytes as a valid label is a labels-rule hit. Demo step 4. | PASS |
| R6 | New `placeExclusive(src, dst, link)`: it tries a hard link, and on `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `EXDEV` or `ENOSYS` falls back to `copyFileSync(src, dst, COPYFILE_EXCL)`. Either way it never replaces `dst`. Backups and the claim restore use it. `opts.linkFile` injects the link function for tests. | `R6: backups fall back to an exclusive copy ...`: the unit test shows each code copies, an existing name is EEXIST, and `EACCES` is thrown as is. Through the server, 3 PUTs with a failing link save with backups r1 to r3. A backup name that appears before the copy gives 500 `backup-exists`; that file and the draft are unchanged. | PASS |
| R7 | PUT draft gives any label without `createdAt` the save time (whole seconds, as the page writes it) before the check. `checkDraft` requires `createdAt`, and `buildLabelFile` never reads the clock. An old or hand-edited stored draft without `createdAt` is refused at preview and export (422 `/labels/0/createdAt required`) until its next save. | `R7: a label without createdAt gets one at PUT ...`: the stored draft without it is 422; after a PUT it has a seconds-only time; preview, wait 1.1 s, export with the hashes gives 200 with the same `createdAt`. A sent `createdAt` is kept. | PASS |
| R8 | `block()` never turns a `changed` or `draft-load` block into `read-only` (it returns false and keeps the block). A read-only block can still become a serious block, and a writer reply still lifts a plain read-only block. | `R8: block() never turns a "changed" or "draft-load" block into "read-only"` (unit). | PASS |

### Commands (run one at a time, 2026-10-28)

| Command | Result |
|---|---|
| `node --test tests/label-server.test.mjs` | tests 62, pass 62, fail 0, skipped 0 |
| `node --test tests/private-scan.test.mjs` | tests 28, pass 28, fail 0, skipped 0 |
| `npm test` | tests 228, pass 228, fail 0, skipped 0 |
| `npm run test:py` | Ran 145 tests, OK (skipped=16, environment skips as before) |
| `node tools/git-hooks/private-scan.mjs scan-worktree` | scanned 305 files, exit 0 |

### Real hooks (throwaway repo, fake profile)

The demo ran in a throwaway repo in the session scratchpad, deleted afterwards. It used `core.hooksPath tools/git-hooks`, copies of the hooks and the validator data, a FAKE `data/profile.local.json`, and the repo identity. No `--no-verify` was used. The first commit (hooks, validator, data, `docs/a.json`, `data/profile.example.json`) passed with exit 0.

| Step | Hook output | Exit |
|---|---|---|
| 1. `x.example.local.json` (`git add -f`) | `local rule: *.local.* files are local-only and never committed` | 1 |
| 2. `Foo.LOCAL.json` (`git add -f`) | `local rule: *.local.* files are local-only and never committed` | 1 |
| 3. `data/games/codm/Local/x.json` (`git add -f`) | `local rule: data/games/<game>/local/ is local-only and never committed` | 1 |
| 4. `git push` to a local bare repo with `UJWALAM_PUSH_APPROVED=1`, after fast-forwarding a commit from a second clone that has no hooks. That commit adds `data/games/codm/local/crop.json` with the same blob as `docs/a.json` (`fc883d93...`). | `data/games/codm/local/crop.json@fc883d939d41:1: local rule: ...`, then `private-scan: 1 hit(s). Push blocked.` The remote has 0 refs. | 1 |

The duplicate-blob history in step 4 comes from a clone with no hooks installed, which is how such a commit would reach a real repo. No hook was bypassed in the demo repo.

### Notes and deviations

- R1: the reload also resets the view (the video position and the timeline span), the same as after a take-over. During the retry the tab is read-only, so no edits of its own can be lost.
- R2: a winner whose claim is moved away after it wrote the lock returns false, but the lock file names it. Its next lock request then sees the lock as its own and becomes the writer. Every other claimant's re-check sees a fresh lock and stops. The outcome is a short delay, never two writers.
- R2 and R6 apply this round's "never replace" rule to the claim restore as well.
- R5: history also reports symlink and gitlink modes under `data/labels/` for every commit. A bad mode that stays in several commits is reported once per record.
- R7: an old draft without `createdAt` that has no edits cannot be exported until the next save. The page only saves when something changed, so the user must make any edit first. No such draft exists on this machine.
- Round 3's M3 row ("names that contain `.example.` are allowed") is superseded by R3.
- Scratch files: the coordinator's list plus this round's scripts were deleted from the session scratchpad. The `rt\` folder was not deleted: it was made by another agent (`agent-afda7480cf9dca27f`, headless Chrome page check), not by this one.

### Files created or changed (round 4)

Changed:
- `tools/label/server.mjs` (`placeExclusive`; stale-claim break by rename and check, final claim check; `opts.linkFile`; `createdAt` filled at PUT)
- `tools/label/labels-export.mjs` (`createdAt` required; `buildLabelFile` has no clock)
- `tools/label/label-core.js` (`block()` keeps serious blocks; `lockReply` `reload`)
- `tools/label/label.js` (reload the draft when the lock comes on a retry)
- `tools/git-hooks/private-scan.mjs` (no `.example.` allowance; case-insensitive local rule; every path in history from `git log --raw`)
- `tests/label-server.test.mjs` (57 to 62 tests; M9 string check now names `placeExclusive`)
- `tests/private-scan.test.mjs` (25 to 28 tests)
- `docs/evidence/2026-10-28-p2b-a6-labelling-page.md` (this section)

Not changed: `tools/label/index.html`, `tools/label/label.css`, `tools/label/suggestions.py`, `tools/git-hooks/pre-commit`, `tools/git-hooks/pre-push`, `data/labels.schema.json`, `data/label-tags.json`.
