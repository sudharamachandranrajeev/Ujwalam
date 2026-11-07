# 2026-11-07 Match result detector W1 (D237)

Status: unverified (one practice recording).

## Scan

OCR of the game area of the practice H recording (0.5 fps, `project_layout` box), cue words only:

- VICTORY at 358 s, centre of the game area (inside the W1 ROI).
- VICTORY at 372–380 s, top of the scoreboard (outside the ROI; frame_hits marks it `outside_roi`).
- A stray "WIN" at 788 s (not matched: W1 accepts VICTORY and DEFEAT only).
- DEFEAT at 942–944 s.

## Checks

- `python -I -m unittest discover -s tests/py -t tests/py`: MatchReelTests (reel pieces, no-kill match, DEFEAT skipped) and the W1 frame test (centre = signal, scoreboard = outside_roi, "VICTORY LAP" = no hit).
- `npm run validate:games`.

## Open

Re-run detect and montage on the recording to render W01 (match 0–358 s, 7 own kills). Needs a held-out second recording to move W1 to verified.

## Montages into posting (later 2026-11-07)

- `clipper.py montage` now also writes `montage/candidates.json` (montage timeline: start 0, end = length, anchor = first kill for the cover; source times in `pieces`; kind `montage` or `won-match`), so the montage folder is a clip run folder for `node services/posting/cli.mjs package --run <dir>/montage`.
- Won-match reel pieces end at the shorter of the H and V recordings (the VICTORY hold could run past the end).
- Practice recording, re-rendered: M01 40.0 s, W01 37.0 s, validate 2/2 PASS. `packageRun` on a scratch copy with a scratch ledger: 6 packages (M01 and W01 x youtube-shorts, tiktok, instagram-reels), layout `montage-v`, cover extracted, limits OK, privacy private, status draft. Nothing uploaded.
- Tests: `test_clip_pipeline.EndToEndTests.test_montage_writes_a_posting_run_folder` (generated media, fixture hits: render, validate, candidates.json, end clamp), `test_clip_montage.MatchReelTests.test_reel_ends_at_the_recording_end`.
