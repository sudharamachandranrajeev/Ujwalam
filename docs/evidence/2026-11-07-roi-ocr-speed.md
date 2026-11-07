# 2026-11-07: ROI OCR for the CODM detector pass (speed for live clipping, D226)

Result: **PARTIAL**. The ROI mode works and is faster, and its signal hits agree closely with the full-frame pass.
It does **not** reach the target of at least 2x real time at 1 fps on 4 threads: it reached about 0.8x real time,
against 0.53x for the full frame on the same segment. A live loop at 1 fps on 4 CPU threads would fall behind.
At 0.5 fps it keeps up. The options to go further are listed at the end.

Goal (decision D226, `docs/plan/2026-10-29-v1-decisions.md`): live clipping saves the replay buffer on kill chains,
so the detector pass must keep up with the stream. Before this change, the pass OCR'd the whole 1920x1080 frame
every second.

## What changed

- `services/clip/detector_pass.py`
  - `FrameScanner`: the per-frame scan, used by `run_pass` and, next, by the live loop. It has two modes
    (`ocrRegions`):
    - `full`: the original path (`g1_scan.scan_frame`, whole-frame diff gate). Results are unchanged.
    - `rois`: only bands built from the pack ROIs are OCR'd, as described below.
  - How `rois` builds and reads the bands:
    - `roi_rects`: each pack ROI is widened by the rule slack (the killfeed slack for M5/B1, `roiSlack`
      otherwise, at least the 0.02 the K1 name check uses) plus `roiPad`. A text box whose centre is inside the
      ROI is then also inside the crop.
    - `merge_bands`: ROIs are merged greedily when the merged box adds no more than `roiMergeArea` of the game
      area. Only ROIs with the same cadence merge.
    - `band_pixels`: game fractions are converted to pixel crops of the sampled image.
    - `ocr_crops`: text detection runs per band, then one recognition batch covers all bands. This uses the
      detector and recogniser objects of the pinned rapidocr 3.10.
    - `band_boxes`: boxes go back to full-frame pixels, so `_frame_record`, `classify_frame` and
      `frame_hits` see the same coordinate space as before. Overlapping bands can read one text twice, so a box
      cut by an inner band edge is dropped when another band holds it whole. Of two boxes with IoU >= 0.5, the
      one with the higher score is kept.
    - Per band, a diff gate (`diffGate` on the band's quarter-scale grey image) and a cadence (`roiEvery`) apply.
      A band that is skipped keeps its last boxes.
    - Mode gating (`modeProbeEvery`): once the mode (mp/br) is known, only the ROIs of detectors that declare
      that mode are read. Every Nth frame all ROIs are read, so a mode change is seen.
  - Two options are in the code but off, because both lost hits in the measurements below:
    - `roiDetScale`: text detection on a downscaled band;
    - `roiTextFilter`: no recognition for text centred outside the rule ROIs.
  - `no_power_throttling()`: called by `FrameScanner`. It opts the process out of Windows execution-speed
    throttling (EcoQoS). Priority stays below normal and the 4-thread cap stays. See "Power throttling".
  - `run_pass(..., start=None, duration=None)` can scan a segment. The summary adds `ocrRegions`, `ocrSeconds`,
    `powerThrottlingOff`, the bands per mode and per-band counts.
- `data/clip/detector-pass.json` (codm), status `proposed`: `ocrRegions "rois"`, `ocrRegionsStatus "proposed"`,
  `roiPad [0.04, 0.02]`, `roiMergeArea 0.02`, `roiEvery {"M1": 5, "M2": 5}`, `modeProbeEvery 10`,
  `roiDetScale 1.0`, `roiTextFilter false`. Files without `ocrRegions` keep `full`.
- `tests/py/test_clip_detector_pass.py`: new `OcrRegionTests` (9 tests, no real OCR):
  - settings validation;
  - band merge;
  - every pack ROI lies inside a band;
  - mode band sets;
  - band px back to game fractions with an offset game area;
  - overlapping bands read once;
  - the text filter;
  - `FrameScanner` in `rois` mode with a stub OCR: one batched call per frame, the band diff gate continues the
    hits.

## Setup

- Recording: `out/host/data/recordings/practice-h-20261106-233203.mkv` (local, gitignored), 1920x1080 at 60 fps,
  3314 s, real gameplay. The layout is `full-frame` (`unverified`).
- Reference: the full-frame pass of 2026-11-07
  (`C:\AI\Claude\_data\Ujwalam\clips\2026-11-06-practice2\detector-hits.jsonl`, not modified): 5763 s for 3314 frames.
- Runs: `C:\AI\Claude\_data\Ujwalam\clips\2026-11-07-roi-bench\<run>\` (`detector-hits.jsonl`, `summary.json`,
  `compare.txt`). The bench driver was a scratch script, not committed. It loads the settings, runs
  `detector_pass.run_pass(rec, out, settings, pack, names, layout, threads=4, start=S, duration=D)` under the
  heavy-job lock, at below-normal priority, with power throttling off, and overrides only the keys listed per run.
- Match rule (compare script): same detector, same label, time ranges within 2 s. Reported per detector as
  reference / matched / missed / extra, for all hits and for signal hits.
- Machine: the laptop (16 logical CPUs). OCR used 4 onnxruntime threads and ffmpeg decode used 2. Nothing else
  heavy was running.

## Power throttling (found during this work)

With the terminal in the background, Windows throttled the OCR process (EcoQoS), and one full-frame OCR of the
same frame took much longer:

| process | s per full-frame OCR (frame t=100 s, 3 runs) |
|---|---|
| normal priority, throttled | 7.75 |
| below normal, throttled | 7.10-8.24 |
| below normal, `SetProcessInformation(ProcessPowerThrottling, EXECUTION_SPEED, off)` | 1.375 |

Some early runs of this work were throttled. They are not used below: every number below comes from a run with
`powerThrottlingOff: true`. The live loop runs in the background while the user plays, so it must opt out too.
`FrameScanner` does this.

## Speed, same segment (0-120 s, busy medal chains)

| mode | s/frame (total) | OCR s/frame | x real time at 1 fps |
|---|---|---|---|
| full | 1.893 | 1.743 | 0.53 |
| rois (default settings) | 1.227 | 1.080 | 0.82 |

`rois` cuts the per-frame time by 35 %. In MP the bands read every frame cover about 0.47 of the frame area
(5 bands); the M1/M2 bands (every 5th frame) are the largest. The wide pack ROIs (K1/M3 at the top centre,
M1 across the lower half) limit the saving. Recognition of the remaining boxes and ffmpeg decode are a large
part of the rest. Bands per mode are listed in each run's `summary.json`.

The `full` run doubles as a check that the full-frame path is unchanged: on 0-120 s it matches the reference
exactly (B1 12/12, M3 40/40, M4 16/16, M5 1/1, N1 1/1, X1 7/7, no extras).

Commands (scratch driver, from the repo root):

```
.venv/Scripts/python.exe -I -u <scratch>/bench.py full-0-120 0 120 '{"ocrRegions":"full"}'
.venv/Scripts/python.exe -I -u <scratch>/bench.py rois-0-120 0 120 '{}'
.venv/Scripts/python.exe -I -u <scratch>/bench.py rois-0-600 0 600 '{}'
.venv/Scripts/python.exe -I -u <scratch>/bench.py rois-3000-3314 3000 314 '{}'
.venv/Scripts/python.exe -I <scratch>/compare.py <run dir> --list > <run dir>/compare.txt
```

## Agreement with the full-frame reference (rois, default settings)

0-600 s (600 frames, 1.204 s/frame, 0.83x real time). Reference / matched / missed / extra:

| detector | all hits | signal hits |
|---|---|---|
| B1 | 44 / 34 / 10 / 14 | 2 / 2 / 0 / 0 |
| M1 | 2 / 1 / 1 / 0 | - |
| M2 | 1 / 1 / 0 / 0 | - |
| M3 | 177 / 170 / 7 / 2 | 41 / 41 / 0 / 0 |
| M4 | 77 / 71 / 6 / 20 | 68 / 62 / 6 / 17 |
| M5 | 1 / 1 / 0 / 2 | 1 / 1 / 0 / 1 |
| N1 | 10 / 10 / 0 / 0 | - |
| X1 | 27 / 26 / 1 / 0 | - |

3000-3314 s (the end of the recording, with the only K1 hit of the reference at 3273 s):

314 frames, 1.200 s/frame, 0.83x real time.

| detector | all hits | signal hits |
|---|---|---|
| B1 | 14 / 10 / 4 / 11 | - |
| K1 | 1 / 1 / 0 / 0 | - |
| M1 | 2 / 1 / 1 / 0 | - |
| M3 | 64 / 63 / 1 / 0 | 41 / 41 / 0 / 0 |
| M4 | 47 / 40 / 7 / 5 | 38 / 33 / 5 / 3 |
| M5 | 1 / 1 / 0 / 0 | 1 / 1 / 0 / 0 |
| N1 | 1 / 1 / 0 / 0 | - |
| X1 | 30 / 29 / 1 / 1 | - |

The X1 miss and extra are the same kind of event read with a different count in nearby seconds
("8X MULTI-KILL" at 3227 s missed, "4X MULTI-KILL" at 3189 s extra), both non-signal (`outside_roi`).

Why the differences:

- M3 signal: complete (41/41). The 7 missed non-signal M3 hits are 4 "Revenge" medals the reference already
  marks `outside_roi`, 2 "Keep it Fresh"/"Relentless" medals the reference marks `suppressed_by_M2`, and one
  "UAV Assist". None of them can count.
- X1: 26/27. The miss is one non-signal hit (`no_name_in_roi`, 151 s). In this recording no X1 hit is a signal:
  the multi-kill banner sits at game (0.568-0.634, 0.609-0.628), outside the pack's MP X1 ROI; the reference
  has 106 of 132 X1 hits `outside_roi`.
- N1: 10/10. In this recording no N1 hit is a signal either: the KILLCAM text sits at game
  (0.270-0.337, 0.059-0.097), outside every MP N1 ROI; all 44 N1 hits in the reference are `outside_roi`.
  The `rois` bands still read these texts because the bands are padded wider than the ROIs.
- K1: 1/1. The only K1 hit of the reference (3273 s, non-signal `no_name_as_killer`) is found.
- M4 ("+N" score labels): the label carries the number, so a digit that OCR reads differently on the smaller
  crop counts as one miss plus one extra (for example a reference "+70" against a `rois` "+20" in the same
  second). This is OCR variance on small text, not a lost event; the medal chain sums in the clipper use M3.
- B1 (killfeed): mode gating reads only the declared mode's ROIs. B1 rows in MP frames that the reference read
  through BR-only ROIs are missed or shifted. Most B1 differences are `not_own_kill` rows, which do not count.
- M1 (post-match MVP screen): the one miss is a non-signal row (`no_name_in_roi`). M1 bands are read every 5th
  frame (`roiEvery`).
- M5: the reference itself has one M5 signal hit spanning 0-3313 s (15124 frames), a constant false positive
  of the current M5 rule on this layout, present in both modes. In `rois` it splits into two hits at the
  mp/br mode change (0-266 s, 280-599 s). This is a pre-existing pack issue, not caused by this change.

## Measurements that ruled options out (offline, same frames, power throttling off)

| option | result | decision |
|---|---|---|
| `roiDetScale` 0.75 | lost N1 and M5 hits | off (1.0) |
| `roiDetScale` 0.6 / 0.5 | lost more N1/M5/X1 hits | off |
| `roiTextFilter` true | N1 0 of 8, X1 1 of 8 kept (texts sit outside the rule ROIs) | off |
| one mosaic image of all bands instead of per-band det | 1.11 s vs 0.81 s per frame, fewer boxes | removed |
| recognition batch 24 instead of the default | slower | default kept |

## Why the target is not reached, and options

At 1.2 s/frame the pass handles 0.83 s of stream per second. To reach at least 2x real time at 1 fps the
pass needs about 0.5 s/frame. Options, each with a cost:

1. Recalibrate the pack ROIs for this H layout (KILLCAM, multi-kill banner, profile names at game y
   0.947-0.978). Then `roiTextFilter` and smaller bands become safe, and N1/X1 become signals at all.
   Needs labelled frames and the user's approval of the pack change.
2. Sample at 0.5 fps in the live loop. This keeps up with the stream now (2.4 s budget per 1.2 s frame).
   UNVERIFIED: chain recall at 0.5 fps (medals show for about 2-3 s, so most should still be seen).
3. Smaller OCR models (PP-OCR "tiny"/mobile det) or onnxruntime with GPU (DirectML/CUDA). Both need a
   download or install, so they need the user's yes. GPU use while live must fit the VRAM rule.
4. More CPU threads. The resource rule caps heavy jobs at about 4 threads.

## What the live loop should call

```
scanner = detector_pass.FrameScanner(pack, names, settings, layout, threads=4)   # once per process
rows = scanner.scan(t, img)                                                       # per sampled frame
```

- The constructor sets the OCR parameters and opts the process out of power throttling. Use one scanner per
  process (the OCR parameters are module-wide).
- `img` is the BGR frame of the layout's visible area (`g1_scan.visible_box(layout)`; the whole 1920x1080
  frame for `full-frame`). `t` is the stream time in seconds.
- `rows` are single-frame hit rows (the `run_pass` row format with `t`). Act on rows with `signal` true;
  `merge_hits` joins rows over time when needed.

## Tests

```
.venv\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_clip_*.py"
Ran 68 tests in 10.805s
OK
```

`tests/py/test_g1_detector_pass.py` (29 tests, real OCR on generated frames, now in `rois` mode): the detect
part passes (M3 "Triple Kill" signal at 3 s held to 5 s by the diff gate, N1 negative, no name text in the
output). One assertion fails after that, in the clipper `candidates` step:
`doc["signals"]["detectors"]["counted"]` is 1, the test expects 0. Cause: commit 3466f98 set
`detectorWeightsStatus "approved"` in `data/clip/ranking.json` with a Triple Kill weight, so the hit now counts.
The test expectation predates that commit; it is not caused by this change (out of scope here: ranking).

## UNVERIFIED

- Speed and agreement on other recordings, layouts and games; only one H practice recording was measured.
- Chain recall at 0.5 fps sampling.
- Speed while the game, the stream encoder and the host run at the same time (the bench ran alone).
- `ocrRegions "rois"` and its settings are `proposed`, not approved by the user.

## Files changed

- `services/clip/detector_pass.py`
- `data/clip/detector-pass.json`
- `tests/py/test_clip_detector_pass.py`
- `docs/evidence/2026-11-07-roi-ocr-speed.md` (this file)
