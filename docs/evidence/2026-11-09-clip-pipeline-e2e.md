# Clip pipeline end-to-end regression (2026-11-09)

Test: `tests/py/test_clip_e2e.py` (slow py suite, part of `npm run test:py`; skipped without ffmpeg/ffprobe).
Run: `python -I -m unittest discover -s tests/py -t tests/py -p test_clip_e2e.py` -> 7 tests OK in about 6 s.

## Fixture (generated at test time, nothing from the clips corpus, no real chat)

- H recording 640x360, 14 s, 3 AAC audio tracks; track 1 has a loudness spike at 8-9 s. V sibling is a copy (`-v-`).
- One hotkey marker row at 7 s; a tiny chat table (12 rows, labelled fixture text, around 7 s) in a fixture app-data dir.
- Fixture detector hits (two own kills, one VICTORY) placed in the run folder, so the montage path runs.
- Command path: `clipper.main([... "run", "--montage", "--publish", <clips>])` with the run folder
  `<app data>/clips/runs/rec-h-20261103-070000`, CPU encoder (libopenh264). Captions backend: `none` (no speech engine offline).

## Checks (all PASS)

| Check | Result |
|---|---|
| signals: marker matched 1, chat rows 12, audio available, top candidate has marker + loudness reasons | PASS |
| names match `clip_names.NAME_RE`; kinds are `short` and `won-reel` | PASS |
| clips folder: exactly one day folder, only `.mp4` files anywhere under it | PASS |
| every published file has 3 audio tracks (ffprobe) and 1080x1920 video; report.json tracks == sourceTracks == 3; decode ok | PASS |
| `<app data>/clips/uploads.json` lists exactly the published files, run name set, `posted` empty | PASS |
| montage: candidates.json has `W01` won-match, `montage-v.mp4` exists and validates | PASS |
| run folder (candidates, render, report, published, montage/) is in app data, not in the clips folder | PASS |
| captions seam reports `off` | PASS |

## Bugs found

None. The first run only failed on a test-side mistake (a class attribute named `run` shadowed `TestCase.run`).

## Not covered / UNVERIFIED

- Streak montages (`M..` ids): the montage config needs at least 20 s of kills, longer than this fixture. Covered by `test_clip_montage.py`.
- Captions with a real speech backend (not offline). Caption burn-in is covered in `test_clip_pipeline.py`.
- NVENC encoder, real recordings, OCR detector pass (`detect`): not run.
