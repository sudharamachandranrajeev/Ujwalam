# 2026-11-07 — Clip review round 1: streak ranking, V-canvas cuts, layer effects

Decisions D224–D226. Session: practice recording 2026-11-06 23:32 (H + V `.mkv`, 3314 s, real gameplay, MP).

## Detector pass (unchanged code, first full real-gameplay run)

`clipper.py run --detect --threads 4 --encoder h264_nvenc` on the H recording:

- 3314 frames at 1 fps, all OCR'd (diff gate skipped 0), 5763 s wall (0.58x real time).
- 1265 hits, 387 with own signal. Own signal per detector: M4 228, M3 154, B1 4, M5 1; M1/M2/X1/K1 0 named; N1 (death) 44.
- M5 (MP kill feed) produced one hit spanning 0–3313 s: merge bug, M5 weight 0 until fixed. **OPEN.**
- Full-frame OCR at 0.58x real time is the blocker for live clipping (D226). **OPEN.**

## Round 1 (agent "Balanced" weights, user-approved for review)

30 candidates x 3 ffmpeg layouts = 90 files, validate 90/90 PASS. Found: render failed 90/90 with a relative
`--recording` (ffmpeg runs in the clip folder) — fixed: `--recording` is made absolute at parse time.
User review: the three layouts are "immature"; multi-kills and chains need more focus; the streamer's death is a
hard negative; clipping should happen live like Meld.

## Round 2 (D224, D225)

- Ranking "streaks only" (`data/clip/ranking.json`): 27 candidates; top two: a Nuclear / Ultimate Terminator chain
  (score 76) and a Super Kill / Ruthless chain (score 34); 12 single Triple Kills at score 3.
- Default layout `stream-v` cuts the V canvas recording: 27 files, h264_nvenc, validate 27/27 PASS.
- H/V time offset assumed 0 (one start for both sinks): **UNVERIFIED**, user check pending.
- Tests: `python -I -m unittest discover -s tests/py -t tests/py -p "test_clip_*.py"` → 60 OK (new: chain sum,
  death cut and drop, marker kept below minScore, V sibling default layout and refusal without it, hits keep tEnd).

## Layer effects (host, D224)

- Native filters `ujw_gaussian_blur`, `ujw_rounded_corners`; layer `effects` in the project schema; a layer with
  effects renders through a private wrapper source holding the shared source (device opened once).
- `node --test app/host/tests/host-project.test.mjs` 10/10 (pixel test on a 1280x720 recording: sharp stripes range
  255, blurred duplicate range 0 at grey 187 (linear-light average); rounded card corners show the background).
- `node --test tests/project-schema.test.mjs` 68/68.
- V preset: `game-backdrop` duplicate of the game (blur 40, full canvas, centre 608x1080 crop) and rounded game
  (radius 48), both behind flag `layer-effects` (off by default). Tests: `tests/project-scene-preset-v.test.mjs`,
  `tests/studio-ui-alpha.test.mjs` (backdrop duplicates the H game layer after the H/V merge) — 117 pass with the
  schema, preset and sync suites.
- **UNVERIFIED:** look on real capture footage, GPU time per frame while streaming, blur strength and radius values.
