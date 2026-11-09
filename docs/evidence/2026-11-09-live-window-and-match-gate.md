# Live clip window minimum and match gate scenarios (2026-11-09)

Branch `clip/live-window`. Synthetic data only; no devices, no corpus, no stream.

## 1. Live windows below the 20 s minimum

- Origin: `services/clip/live_chain.py` builds a window as `[first medal - preSec, last medal + postSec]`
  (`data/clip/live-clips.json`). The 2026-11-07 practice used preSec 15 + postSec 3 = 18 s. preSec was raised to 17 the
  same day, so a single-card quiet close already gave 20 s, but that held only by arithmetic: nothing enforced the
  minimum. Death closes (end fixed 2 s before the KILLCAM) and force saves could still be short.
- Change: new data key `minClipSec` (20.0, the user's minimum, same value as `montage.json` minSec) in
  `data/clip/live-clips.json`. `LiveChain._action` moves the start earlier by the missing seconds when a window is
  shorter. Start is bounded by the replay buffer (`replaySec - forceMarginSec` back from the save moment) and by the
  previous death hit + `repeatSec` (never back into an earlier KILLCAM). `minClipSec` longer than the buffer raises
  ValueError at start. Missing key = 0 (old behaviour).
- Tests: `tests/py/test_live_chain.py` `MinimumClipLengthTests` (synthetic 1 frame/s feed; startBack/endBack are
  derived by the worker from `at - start/end`, unchanged): shipped config, preSec 15/10 with minimum 20/25/30, minimum
  0, long window untouched, death close extended, stop at previous KILLCAM, replay-buffer bound, over-long minimum
  refused, force-save windows. Result: 16 + 8 live_worker tests OK.

## 2. Match gate and W1 won-reel scenarios

`tests/py/test_match_gate_scenarios.py` (11 tests): one synthetic recording, five matches (top 3 VICTORY, top 3
DEFEAT, not top 3, end seen but no top-3 reading, no end screen). Locks segmentation, `decide` for top3 / minKills /
both / off, `gate_candidates` (only the not-top-3 match drops its clips), all-unreadable keeps all, and
`match_reels` (reel only for VICTORY with an own kill; DEFEAT none even in the top 3).

No bug found in `match_gate.py` or `match_reels`; no production change for task 2.

## Observations

- UNVERIFIED: real-stream behaviour of the extended windows (feed is synthetic); that a 20 s window plus
  clips merged by `live-review` still validates on a real save.
- Won-match reels are not filtered by the match gate (locked by test as current behaviour): a VICTORY outside the top 3
  still gets a reel. Design decision for the user.
