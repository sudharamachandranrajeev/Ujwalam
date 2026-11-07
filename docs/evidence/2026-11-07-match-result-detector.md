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
