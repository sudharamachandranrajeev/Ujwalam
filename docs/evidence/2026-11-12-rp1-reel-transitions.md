# RP1 reel transitions — evidence (2026-11-12)

Plan: `docs/plan/2026-11-12-reel-polish-music-learning.md` (RP1). User request 2026-11-11: an option in Settings for
the animation between the pieces of a reel, starting with a subtle cross fade.

Status: **built behind flag `reel-transitions` (off by default); not yet used on a real stream.** The default length
(250 ms) and the range (150–500 ms) are proposed.

## What was built

- `data/clip/transitions.json`: the kinds (Cut, Cross fade with 150–500 ms, default 250 ms). More kinds = one more
  row with an ffmpeg `xfade` name, no code.
- `services/clip/reel_transition.py`: settings check, the user's choice (`settings.json clips.reelTransition
  {kind, ms}`), `active()` = the transition to render with, or none (flag off, Cut, or a bad value → default).
- `services/clip/clip_montage.py`: `crossfade_sec()` (overlap = the length, at most half the shortest piece) and
  `render_argv(transition=)`: an `xfade` chain for the picture and an `acrossfade` per audio track; the sound fades in
  only at the reel's start and out only at its end. No transition = the hard concat of before, unchanged.
- `services/clip/clipper.py`: montages, match reels, impact-play reels and re-cut live clips use it. A reel with
  burned-in captions keeps the cut (the captions follow the sum of the pieces). The render row records
  `transition {kind, xfade, ms, joinSec}`, `end` = the real length, `belowMin` when the overlaps take a reel under its
  shortest length; render.json records `reelTransition {flag, use}`. Captions again (`recaption`) on a cross-faded reel
  renders the cut at its full length instead of cutting it to the shorter old file.
- `services/studio-ui/user-settings.mjs` + `server.mjs`: the same checks in JS; `/ui/api/settings` returns
  `reelTransition {flag, kinds, kind, ms}`.
- Qt studio, Settings > Clips > REEL TRANSITION: "Transition between pieces" (Cut / Cross fade) and Length (ms; greyed
  for Cut). Save sends the value only when it changed.
- `data/flags.json`: `reel-transitions`, default false.

## Tests

| Command | Result |
|---|---|
| `python -I -m unittest discover -s tests/py -t tests/py` | Ran 602 tests, OK (skipped=51) |
| `python -I -m unittest tests/py/test_reel_transition.py` (in the suite) | 9 tests OK: kinds, flag off by default, checks (incl. a non-text kind), active() follows flag and setting, overlap rules, xfade/acrossfade chain and offsets for 3 pieces and 2 audio tracks, picture-only, captions, real render |
| `node --test tests/user-settings-reel-transition.test.mjs tests/user-settings-reel-hook.test.mjs` | 7 pass |
| `node --test --test-name-pattern="Settings > Clips" tests/studio-qt-shell.test.mjs` (headless) | 4 pass, including RP1: Cross fade 250 ms (150–500) shown; fade 400 saved; Cut saved as `{kind: cut, ms: 0}` |
| `npm run lint` | 0 findings |

## Render check (synthetic, ffmpeg n8.1.3)

Source: 5 s black then 5 s white, a tone. Pieces 1–4 s (black) and 6–9 s (white), 60 fps output, average luma per
frame (`signalstats` YAVG):

| Render | Length | Largest luma change between two frames | Luma half way through the join (2.80–2.95 s) |
|---|---|---|---|
| Cut | 6.000 s | 219 (one frame black → white) | 16 (still black) |
| Cross fade 250 ms | 5.750 s (= 6 − 0.25) | 15 | 59 → 191, rising evenly |

No black frame and no flash at the join: the change is spread over 15 frames (flash rule: ≤ 3 flashes/s).

## Review

Codex (medium) on the diff: 2 findings, both fixed — a non-text stored `kind` crashed the lookup (now a problem, then
the default); the overlaps could take a reel under its shortest length unreported (now `belowMin`).

## Open

- Real reels with the flag on, watched by the user; then the default length can be confirmed.
- Captions + cross fade together (needs caption times shifted by the overlaps): later, only if wanted.
