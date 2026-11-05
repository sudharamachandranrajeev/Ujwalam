# 2026-11-05: F6 post-stream detector pass over the H recording

Result: **PASS (plumbing)**. The pass samples a full H recording, runs the CODM pack's detectors and writes the
hits file. The ranker reads that file and shows the hits, but they add 0 to ranking until the user approves
detector weights. This shows the plumbing works. It is not evidence that the detectors are accurate. Every CODM
detector stays `unverified`, and there has been no run on a real H recording yet (**UNVERIFIED**).

Plan: `docs/plan/2026-11-03-f6-clip-pipeline-plan.md` §2 step 2 (the "detector hits" seam) and §2 "Later"
(the full-frame CODM detector pass on the H recording).

## What was built

- `services/clip/detector_pass.py` (new). It turns per-frame detector events into hit rows. Frame sampling, OCR,
  diff gate, mode cues and detector parsing are reused from `g1_scan` (`decode_frames`, `scan_frame`,
  `classify_frame`, `find_events`). The pack is loaded with `game_pack`. The pass applies these pack rules to
  every event:
  - the box centre must lie inside one of the detector's ROIs (slack `roiSlack`);
  - `nameRequired`: the profile name must lie inside the detector's own ROI. For X1 this matters because the BR
    squad list always shows the name;
  - K1 counts only when the name is shown as the killer (`signal` from `g1_scan`);
  - M5 and B1 count only on the user's own kill-feed line (`side == killer`);
  - `suppressionRules`: M2 on screen suppresses M3 and M4;
  - M3 reference medals get `clipReason: false` and pack weight 0;
  - M4 `+N` counts only when a medal shows in the same frame (pack note G1);
  - N1 and N2 are `role: negative` and never signal.

  Consecutive sampled frames with the same (detector, label), no more than `mergeGapSec` apart, merge into one
  hit (`t`, `tEnd`, `frames`). A frame skipped by the diff gate is unchanged, so it continues the hits of the
  last frame that was OCR'd.
- Hit row: `{t, tEnd, frames, detector, label, role, signal, why[], clipReason, weight, detectorStatus, mode, ocrScore}`.
  `label` is catalogue or pattern text, or a canonical form (`3X MULTI-KILL`, `5+ MULTI-KILL`, `+254`). It is
  never raw OCR text, so no IGN or player name is written. A test checks this.
- `data/clip/detector-pass.json` (new, status `proposed`) holds the settings for each game:
  - `fps 1.0`: the A5b/A5c full-screen captures were scanned at 1 fps (the `coverage.py` default);
  - `diffGate 0.2`: measured below;
  - `nameMin 0.8`: the `g1_scan` default. The pack's `nameMatch.minScore` is still null;
  - `mergeGapSec 2.5` and `roiSlack 0.02`;
  - layout `full-frame`, `unverified`.
- `services/clip/clipper.py`:
  - new subcommand `detect`, which writes `DIR/detector-hits.jsonl` and `DIR/detector-pass.json` (counts only, no
    text);
  - `run --detect` runs `detect` first;
  - `candidates` without `--hits` uses `DIR/detector-hits.jsonl` when `detector-pass.json` names the same
    recording;
  - `candidates.json` gains `detectorHits` (every hit with t, detector, label, signal, weight and candidate id)
    and `signals.detectors.{rule, weightsStatus, counted, attached}`.
- `services/clip/clip_rank.py`: `detector_weight()` and `detector_events(hits, detWeights, approved)` implement
  the weight rule (next section). A zero-weight detector event is `attachOnly`. It never opens a window, so it
  cannot create a candidate or change a score, anchor, window or order. After ranking, it is added as a weight-0
  reason to the candidate that covers its time.
- `services/clip/clip_signals.py`: `read_hits` keeps `signal`, `role`, `clipReason` and `weight` when they are
  present and well typed. The old `{t, detector, label}` rows read the same as before.
- `data/clip/ranking.json`: new key `"detectorWeightsStatus": "proposed"`. Nothing else changed.

## Weight rule (explicit, tested)

A detector hit has weight > 0 only when all of these hold:

1. `ranking.json` `detectorWeightsStatus` is `"approved"`;
2. the hit has `signal` not false, `role` positive and `clipReason` not false;
3. a number exists in `ranking.json` `detectorWeights` (`"<det>:<label>"` first, then `"<det>"`), or else in the
   pack weight carried in the hit.

Otherwise the weight is 0. The reason is recorded as `detail.zeroBecause`: `weights not approved`, `no signal`,
`not a clip reason` or `weight null`. Today every CODM detector weight and every positive-medal weight is null,
and `detectorWeightsStatus` is `proposed`. So every hit is recorded and shown, and none counts. To approve, the
user sets weights (pack G3 or `ranking.json detectorWeights`) and sets `detectorWeightsStatus` to `approved`.

## Resource limits

- OCR runs on 4 onnxruntime threads (inter-op 1); `detect --threads 1-4` can lower it. ffmpeg decodes on 2
  threads.
- The `clipper` process and the ffmpeg decode children run at below-normal priority, with no console window.
- One heavy job at a time: `HeavyJobLock` uses `%TEMP%\ujwalam-clip-heavy.lock` (pid). A second `detect` is
  refused. A stale lock (its process is dead) is taken over.
- CPU only. No installs; the OCR runs in `.venv`.

## Commands and output

```
python -I -m unittest discover -s tests/py -t tests/py
Ran 202 tests in 14.224s
OK (skipped=17)

.venv\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_g1*.py"
detect: 2 hit(s), 1 with signal, from 5 OCR frames at 1.0 fps in 34.3 s; detectors unverified, weights not approved
candidates: 0 from 2 events (markers 0, chat off, audio off, detectors 2); ranking proposed
Ran 60 tests in 79.843s
OK

python -I -m unittest discover -s tests/py -t tests/py -p "test_clip_*.py"
candidates: 1 from 3 events (markers 1, chat off, audio off, detectors 2); ranking proposed
Ran 56 tests in 11.299s
OK

node --test tests/live-markers.test.mjs      (reads the same ranking.json)
tests 22, pass 22, fail 0

node tools/lint.mjs
lint: 0 finding(s), 31 allow marker(s), in 4.2s
```

`npm run ci` was not run, as the task asked.

Tests:

- `tests/py/test_clip_detector_pass.py` (new, system Python, no OCR), 24 tests:
  - config: values from `detector-pass.json`; bad values refused; `detectorWeightsStatus` is `proposed`; every
    pack weight is still null (reference medals 0) and every detector is `unverified`;
  - weight rule: numbers without approval give 0; approved with null gives 0; approved numbers count, with
    override order; non-signals give 0;
  - attach: a zero-weight hit attaches without changing the window or score, and opens nothing alone; an
    approved weight opens and scores a candidate;
  - frame rules on the committed pack: positive medal; reference medal; outside the ROI; `+N` without a medal;
    X1 name on the card vs elsewhere; `5+ MULTI-KILL`; M2 suppression; N1 negative; K1 with and without the
    killer name; own and other kill-feed lines; no name or OCR text in the rows;
  - merge; the seam fields; the lock (busy, stale);
  - clipper `candidates` on generated media with a hits file: hits listed, weight 0, one attached, nothing
    counted.
- `tests/py/test_g1_detector_pass.py` (new; OCR venv and ffmpeg): the input is a generated 9 s 1280x720 recording
  with `TRIPLE KILL` in the M3 banner ROI at 3–6 s and `KILLCAM` in the N1 ROI at 7–8 s, plus an invented name in
  a temp profile. `clipper detect` gives one M3 `Triple Kill` hit (`t` 3.0, `tEnd` 5.0, 3 frames, signal,
  weight null) and one N1 hit (negative, no signal), and no name in the file. `clipper candidates` then gives 0
  candidates (no approved weight, no other signal), and every `detectorHits` weight is 0.

## Measured on generated frames

- Diff gate: on the 1280x720 generated frame, the mean luma change at 1/4 scale was 0.70 for the banner
  appearing and 0.27 for the small `KILLCAM` label. Unchanged frames gave 0.0. With the `g1_scan` default of
  1.5, set on vertical cutouts, both events were skipped (first test run: 1 OCR frame, 0 hits). With 0.5 the
  KILLCAM label was still skipped. With 0.2 both are read. Real gameplay moves, so the gate will skip few frames
  there (**UNVERIFIED** on a real H recording).
- OCR time per full frame (4 threads, below-normal priority) ranged from 0.45 s (720p) to 15 s (1080p). Other
  jobs were using the laptop at the time, so these numbers are **not a benchmark**. A 2-hour stream at 1 fps has
  7200 sampled frames, so a full pass may take hours on CPU. Measure this on a real recording before choosing the
  sample rate.

## UNVERIFIED / not done

- Detector accuracy on the full H recording. The ROIs were verified on full-screen live captures (A5b/A5c) and
  on vertical cutouts, not on Ujwalam's H canvas. The H canvas may scale or offset the game, or a facecam or
  overlay may cover the HUD. The pass uses the full frame unless `--layout` (a `g1_scan` layout JSON) is given.
- The `nameMin` 0.8, `diffGate` 0.2, `mergeGapSec` 2.5 and `roiSlack` 0.02 values are proposals.
- `endScreenRule` ("counts once per match") is not applied. Each named end screen is its own hit. It only
  matters once weights are approved, and it needs match boundaries.
- `screens` gates and detector `modes` are recorded (`mode`), not enforced, the same as in `g1_scan analyse`.
- Not yet measured: run time on a real 1–3 h recording, and the cost of decoding the whole 1080p60 stream with
  the `select` filter.
- `g1_scan` calls `ffmpeg` and `ffprobe` from PATH. The clipper's `--ffmpeg` and `--ffprobe` options do not
  apply to the decode.

## Footage that would let the detectors be verified

1. One or two real Ujwalam H recordings (`.mkv`, the full stream, 1–2 h) with MP and BR matches. These are the
   real input, and they show the H canvas geometry (game area, facecam, overlays over the HUD).
2. A short list of moments from the same recordings: timestamps of medals (Double/Triple/Fury Kill and
   higher), multi-kill and killstreak cards, MVP and Impact Play screens with the IGN, FINAL KILLCAM as the
   killer, and own deaths (KILLCAM, HELP ME). These give recall and precision per detector. Timestamps and
   placeholder names only; they go into `data/labels/`.
3. A screenshot of the H scene layout (or the facecam rectangle), to write a `--layout` file when the game does
   not fill the canvas.
4. After a measured run, the user approves the per-detector weights (G3). Only then is `detectorWeightsStatus`
   set to `approved`.

## Files

Created: `services/clip/detector_pass.py`, `data/clip/detector-pass.json`, `tests/py/test_clip_detector_pass.py`,
`tests/py/test_g1_detector_pass.py`, `docs/evidence/2026-11-05-f6-detector-pass.md`.
Changed: `services/clip/clipper.py`, `services/clip/clip_rank.py`, `services/clip/clip_signals.py`,
`data/clip/ranking.json` (one key added).
