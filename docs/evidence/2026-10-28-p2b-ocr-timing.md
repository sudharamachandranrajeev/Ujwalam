# P2b: OCR speed, on-screen durations and per-detector sample rates

Date: 2026-10-28. This is a follow-up to W1 (`docs/evidence/2026-10-27-p2b-w1-coverage-capture.md` §4 and §7, "OCR is slow"). The user gave these instructions on 2026-10-28.

This file holds aggregates only: no player names, no IGN and no frames. Bench outputs, event rows (with no OCR text), gate results and ROI costs are in `docs/evidence/private/ocr-timing/` (gitignored). Inputs are read-only:
- the private live captures A5b (two `.mkv` recordings) and A5c (`mp2`, `br2` segments) in `<captures>`;
- the existing 1 fps g1 scan and analyse outputs in `docs/evidence/private/g1-live-2/` and `g1-live-3/`.

The clips corpus was not used. The scripts were one-off files in the session scratchpad and were deleted at the end. Every OCR run was a single process with RapidOCR 3.10.0 on onnxruntime 1.31.1 CPU, 4 intra-op threads, 1 inter-op thread, BelowNormal priority (`g1_scan.lower_own_priority`). Only one job ran at a time.

`detectors.json` and the schemas are unchanged. §5 is a proposal for the user to approve.

## 1. Idle check (before any timing)

PowerShell `Get-Counter` sampled `\Processor(_Total)\% Processor Time` and `\Process(*)\% Processor Time` every 5 s for 60 s. There are 16 logical CPUs; each process's figure is divided by 16.

```
total % samples: 4.5, 1.4, 0.8, 2.5, 2.8, 0.3, 3.7, 1.4, 1.1, 5.8, 0, 0.4
total mean: 2.1
top processes (mean % of all CPUs over 60 s, max sample):
dwm 0.20 0.57 | python 0.18 0.55 | system 0.13 0.25 | msmpeng 0.05 0.10 | rustdesk 0.04 0.16 | explorer 0.03 0.31 | ...
```

(Get-Counter also printed one "data in one of the performance counter samples is not valid" warning. That happens when a process exits during sampling.)

- Running but idle: the other project's `fakegame` processes (2 × `python -m fakegame --seed 1 --topmost` from its `.venv`) and the "hermes" gateway (`hermes_cli.main`). Their python total was 0.18 % mean and 0.55 % max. None was stopped or touched.
- Verdict: **idle**. The total mean was 2.1 % (limit about 15 %), and no process was above 0.6 % (limit about 10 %). Parts 2 to 5 ran on this idle system.
- Power: on AC (`Win32_Battery.BatteryStatus` 2, 100 %). Power plan: "Ultimate Power Plan" (`powercfg /getactivescheme`). The power state during W1 was not recorded, so it is UNVERIFIED.

## 2. OCR speed, re-measured idle

Method: the same as A5 §6, `g1_scan.py bench`. Each folder of images is OCR'd once with the RapidOCR default profile and once with the crop profile (`Det.limit_type=max`, `Det.limit_side_len=960`, `Global.use_cls=False`), after a warm-up call.

```
.venv/Scripts/python.exe -I services/clip/g1_scan.py --threads 4 bench --crops <private>/ocr-timing/frames-full --out <private>/ocr-timing/bench-full-frames.json
{"default": {"n": 30, "msMedian": 1073.3, "msP95": 1163.3}, "crop": {"n": 30, "msMedian": 570.3, "msP95": 625.9}, "sameTextsBothProfiles": 1}
.venv/Scripts/python.exe -I services/clip/g1_scan.py --threads 4 bench --crops <private>/g1-corpus/crops-live-mp --out <private>/ocr-timing/bench-live-mp-crops.json
{"default": {"n": 81, "msMedian": 822.4, "msP95": 1138.6}, "crop": {"n": 81, "msMedian": 54.2, "msP95": 138.1}, "sameTextsBothProfiles": 42}
.venv/Scripts/python.exe -I services/clip/g1_scan.py --threads 4 bench --crops <private>/g1-corpus/crops-corpus-a --out <private>/ocr-timing/bench-corpus-crops.json
{"default": {"n": 125, "msMedian": 855.4, "msP95": 1435.2}, "crop": {"n": 125, "msMedian": 48.7, "msP95": 149.3}, "sameTextsBothProfiles": 61}
```

The full-frame set is new. It has 30 frames of A5c `mp2-000.mp4` at t = 1, 3, ..., 59 s, cut to the tracker's visible area (1566×1080 px, `layout-live3.json`) with `ffmpeg -ss t -frames:v 1 -vf crop=1566:1080:176:0`. These frames are the same ones that the A5c scan and W1 demo 1 OCR'd.

The bench ran from 08:45 to 08:50 UTC.

| Input | Profile | n | Idle 2026-10-28 median (p95) | A5 §6 (2026-10-27) | Same 30 frames in the A5c scan | Same 30 frames in W1 demo 1 |
|---|---|---|---|---|---|---|
| Corpus ROI crops | crop | 125 | **49 ms** (149) | 108 ms | - | - |
| Corpus ROI crops | default | 125 | 855 ms (1,435) | 1,314 ms | - | - |
| Live full-screen ROI crops | crop | 81 | **54 ms** (138) | 98 ms | - | - |
| Live full-screen ROI crops | default | 81 | 822 ms (1,139) | 1,294 ms | - | - |
| Full visible area 1566×1080 | default (**what the tracker ran**) | 30 | **1,073 ms** (1,163) | 1,476 ms (vertical cutout, scan) | 2,826 ms | **5,664 ms** |
| Full visible area 1566×1080 | crop (downscaled to 960 px wide) | 30 | 570 ms (626) | - | - | - |

What the W1 tracker ran:
- `coverage.py watch` calls `g1_scan.scan_frame`, which OCRs the **whole visible area**: one 1566×1080 image per sampled frame at 1 fps.
- It uses the **default profile**. `coverage.py` sets only the thread parameters and never `CROP_PROFILE`.
- It uses **no ROI crops**, so that is 1 OCR call per frame. The detectors then filter the boxes by ROI afterwards.
- The default detector keeps 1080 px as the short side, and every text box on the HUD gets a recogniser call. The median was 27 boxes per frame (W1 scan rows).

Why W1 was slower:
- On these 30 frames, the idle run found exactly the same box count as W1 on 30 of 30 frames. Same images, same profile, same thread cap, so the method was identical.
- W1's OCR time per frame was 5.3× the idle time (5,664 against 1,073 ms). Across all W1 rows the median was 6,955 ms (demo 1, 179 frames) and 6,247 ms (demo 2, 103 frames). That is OCR time alone: the scan rows' `ocrMs`, without decode.
- The cause was the load on the machine during W1, not the tracker. Part of that load is known: the overlapping `files` run (W1 §4.1). The rest, the "other user workloads", is UNVERIFIED: nothing was sampled at the time, and the power state was not recorded.
- The A5c scan of the same frames was also slower (2,826 ms) than idle. On 2026-10-27, A5c §"Resource use" noted that scans ran in parallel for part of that time.
- Idle today is also faster than A5 §6 on the same crop folders: 49 against 108 ms and 855 against 1,314 ms. A5 §6 says "no other load", so the difference is UNVERIFIED. Possible causes are power or thermal state, or background work at the time.

Conclusion for the tracker: on an idle machine, the current full-frame method costs about 1.07 s of OCR per frame, so 1 fps is about real time (1.07×) before decode. ROI crops with the crop profile cost about 50 to 90 ms each (§4). That method is about 10× cheaper per crop, and it is the method the proposal in §5 uses.

## 3. On-screen durations: method

Script: a one-off scratch script (deleted). It ran from 08:53:22 to 08:56 UTC (M3, M4) and from 08:57:25 to 09:21:36 UTC (all other types).

1. **Events.** The events come from the existing 1 fps hits (`analyse-*/hits.jsonl` for A5b, `hits-tfix.jsonl` for A5c). Hits of one type are grouped into one event when they are no more than 2 s apart. Per type, up to **10 events** are taken, spread over both sessions and over the recording (evenly spaced in the list).
2. **Dense re-read.** For each event, the window from 3 s before the first hit to 3 s after the last hit is decoded again. Gameplay types are decoded at **10 fps**. End screens (M1, M2) are decoded at **2 fps**, because they last seconds. Each frame is cut to the type's ROI (`g1_geometry.roi_crop_px`, live layout above) and OCR'd with the crop profile. The type's matcher from the analyse step is applied. The M5 and B1 kill-feed matcher was made stricter during the run: all parts must be on **one** text line. A first version also matched across lines and gave a 12 s read, so those rows were deleted and the types re-run.
3. **Read run.** The duration is the run of matched samples that contains the 1 fps hit. Gaps of up to 3 samples at 10 fps (up to 1 sample at 2 fps) count as part of the run, because OCR misses frames during fades and animation. Duration = last − first + 1/fps. Read fraction = matched samples / samples in the run.
4. **Status.** "ok": the run starts and ends inside the window. "clipped": the run touches the window edge; the value is a lower bound and is not used for percentiles. "not re-read": the dense pass found no match at the hit (the 1 fps hit came from the full-frame scan; the ROI crop with the crop profile did not reproduce it). Those events are counted but have no duration.
5. **Load.** The durations are media-time values, so machine load does not change them. The OCR ms in these rows do depend on load. B1 and the X1 MP card (about 09:02 to 09:12 UTC) ran 5 to 10× slower than idle. In that interval, another agent of this session ran a local label-server test with headless Chrome (files in the session scratchpad at 09:11 to 09:12 UTC). That this caused the slowdown is UNVERIFIED.

Total: **6,325 OCR calls**, about **1,602 s** of wall time (decode + OCR), 13 event types, A5b and A5c, 2026-10-28.

## 4. OCR cost per ROI crop (crop profile, 4 threads)

| ROI (detector/roi) | Crop px | Idle ms (median) | Source |
|---|---|---|---|
| M1/postmatch_left | 627×227 | 60 | idle bench rows (live crops, 08:45 to 08:50) |
| M1/endscreen_row | 1566×378 | about 130 (288 loaded) | durations run, loaded; idle value scaled by M1/postmatch_left's loaded/idle ratio 2.2. UNVERIFIED |
| M2/header | 250×87 | 22 | idle bench rows |
| M2/killed_by | 375×108 | 49 | idle bench rows |
| M3/banner | 376×314 | 55 | idle bench rows; trial at 08:52: 77 |
| M3 and M4/text_stack (the same box) | 532×151 | 64 (M3 frames), 72 (M4 frames) | idle bench rows |
| M5/killfeed | 470×130 | 87 | idle bench rows; trial at 08:52: 85 |
| B1/killfeed | 705×129 | about 87 | not measured idle. M5's value is used (similar text lines, larger crop). UNVERIFIED |
| B2/counter | 470×151 | 65 or less | durations run (loaded, so an upper bound) |
| X1/card_mp | 391×140 | 48 | idle bench rows |
| X1/banner_br | 438×130 | 50 | idle bench rows |
| N1/label_mp | 282×75 | 14 or less | durations run (loaded) |
| N1/label_br | 188×76 | 26 or less | durations run (loaded) |

A second per-ROI run over frames sampled every 20 s (`roi-cost.json`, private) gave 5 to 10× these values. It ran during another project's gate job (`p1_gate_fakegame.py` from 09:28:53 UTC, and a fakegame seed 2 run from 09:36:11 UTC), so it is **not used**. A check on the same banner frames ruled out the crop's memory layout: a numpy view and a contiguous copy both took about 90 ms under that load.

## 5. Durations and proposed sample rates

### 5.1 On-screen (read) duration per event type

Seconds. n = events with status "ok". Percentiles are linear (p10 interpolated).

| Type | Sampled at | n ok (+clipped, not re-read) | min | p10 | median | max | Read fraction min | Sessions | Events at 1 fps |
|---|---|---|---|---|---|---|---|---|---|
| M3 banner | 10 fps | 10 | 0.3 | 0.39 | 2.45 | 2.5 | 1.0 | A5b, A5c | 98 |
| M3 text stack | 10 fps | 9 (+1) | 0.9 | 1.14 | 1.2 | 1.4 | 0.89 | A5b, A5c | 206 |
| M4 +N | 10 fps | 10 | 0.6 | 0.78 | 1.2 | 4.7 | 0.64 | A5b, A5c | 137 |
| M5 MP kill-feed line | 10 fps | 9 (+1, 6) | 0.6 | 1.16 | 3.8 | 5.8 | 0.85 | A5b, A5c | 1,557 |
| B1 BR kill-feed line | 10 fps | 8 (+2, 4) | 1.0 | 1.91 | 5.1 | 5.6 | 0.94 | A5b only | 1,421 |
| X1 MP card | 10 fps | 8 (+2) | 1.4 | 1.61 | 1.8 | 3.8 | 0.84 | A5b, A5c | 42 |
| X1 BR banner | 10 fps | 10 | 1.6 | 1.6 | 1.85 | 5.2 | 0.78 | A5b only | 16 |
| B2 own-kill text | 10 fps | 10 | 0.6 | 0.96 | 1.25 | 3.1 | 0.70 | A5b only | 27 |
| N1 kill-cam label MP | 10 fps | 10 | 0.6 | 0.69 | 0.9 | 2.4 | 1.0 | A5b, A5c | 32 |
| N1 kill-cam label BR | 10 fps | 3 (+2) | 1.1 | 1.14 | 1.3 | 5.5 | 1.0 | A5b, A5c | 5 |
| M1 post-match MVP | 2 fps | 7 (+2) | 1.0 | 1.0 | 3.5 | 24.0 | 1.0 | A5b, A5c | 11 |
| M1 scoreboard / top-3 | 2 fps | 10 | 0.5 | 0.5 | 1.25 | 7.5 | 0.93 | A5b, A5c | 15 |
| M2 Impact Play | 2 fps | 5 | 5.5 | 7.3 | 13.5 | 16.5 | 1.0 | A5b, A5c | 5 |
| K1 | - | 0 | - | - | - | - | - | - | 0 (UNVERIFIED) |
| N2 | - | not measured | - | - | - | - | - | - | - |

Notes:
- **M3 banner.** The short reads (0.3 to 0.5 s) are chained medals: the next medal replaces the label about every 0.4 to 0.5 s. This was checked by eye on one A5c event (frames in `ocr-timing/check/`, private). A single medal stays about 2.5 s.
- **M1 scoreboard / top-3.** In 4 of 10 events, the dense read found 1 sample (0.5 s), but the 1 fps hits of the same event spanned 2 to 10 s. The dense ROI read misses most frames of this screen, so 0.5 s is a matcher limit, not the on-screen time. With the longer of the two values per event, the p10 is 1.05 s. UNVERIFIED.
- **2 fps resolution.** At 2 fps, a 1.0 s read means 2 samples, so the true duration is 1.0 to 2.0 s.
- **Small n.** N1 BR (3), M2 (5) and every BR-only type (A5b only) need more events before a rate is fixed.

### 5.2 Proposed sample rate per detector (proposal; not applied)

Rule: **interval ≤ p10 / 2 × margin**. Margin = 0.8, or the type's lowest read fraction when that is lower. The p10 / 2 part gives at least 2 samples inside a p10-length event. The margin covers frames that OCR misses during fades, and decode timing jitter. The rate is then rounded up to the next value in {0.5, 1, 2, 2.5, 3, 4, 5, 7, 10} Hz.

| Detector (ROI) | p10 s | Margin | Max interval s | Proposed rate | OCR ms/s of footage (rate × idle ms) |
|---|---|---|---|---|---|
| M3 (banner) | 0.39 | 0.8 | 0.156 | **7 Hz** | 385 |
| M3 + M4 (text_stack, one crop for both) | 0.78 (M4) | 0.64 | 0.248 | **5 Hz** | 360 |
| M5 (killfeed) | 1.16 | 0.8 | 0.464 | **3 Hz** | 261 |
| X1 (card_mp) | 1.61 | 0.8 | 0.644 | **2 Hz** | 96 |
| N1 (label_mp) | 0.69 | 0.8 | 0.276 | **4 Hz** | 56 or less |
| B1 (killfeed) | 1.91 | 0.8 | 0.764 | **2 Hz** | about 174 |
| X1 (banner_br) | 1.6 | 0.78 | 0.624 | **2 Hz** | 100 |
| B2 (counter) | 0.96 | 0.7 | 0.336 | **3 Hz** | 195 or less |
| N1 (label_br) | 1.14 | 0.8 | 0.456 | **3 Hz** | 79 or less |
| M1 (postmatch_left) | 1.0 | 0.8 | 0.4 | **2.5 Hz** | 150 |
| M1 (endscreen_row) | 1.05 (hit spans) | 0.8 | 0.42 | **2.5 Hz** | about 325 |
| M2 (header + killed_by) | 7.3 | 0.8 | 2.92 | **0.5 Hz** | 36 |
| K1, N2 | - | - | - | keep 1 Hz until measured | - |

- "Gameplay high, end screens low": the rule gives 2 to 7 Hz for gameplay and 0.5 Hz for M2. M1 does not come out low (2.5 Hz), because its measured p10 is short. The M1 reads are at the limit of the 2 fps re-read, so a 10 fps re-read of M1 could lower this. UNVERIFIED.
- The M3 banner sets the highest rate, only because of chained medals. A cheaper option: banner at 3 Hz. Single medals (about 2.5 s) would still be read, but chained medals shorter than about 0.7 s would get 0 or 1 reads. Whether the text stack (5 Hz) lists every chained medal is UNVERIFIED. That option saves 220 ms/s.
- A proposed schema field, **not added**: `sampleHz` (number, > 0, ≤ 10) per ROI in `detectors.json`, with the evidence (p10, n, date) in the detector's `note` or a sibling `sampleEvidence` object, and a status (unverified|verified). The schema `data/games/detector-pack.schema.json` is unchanged.

### 5.3 Diff gate

The current gate (`g1_scan.scan_frame`) compares the full visible area at 1/4 scale (gray mean absolute difference, threshold 1.5) and skips OCR when the frame has not changed.

**On ROI crops** (simulated on the dense samples of §3: a skipped sample keeps the previous sample's result):

| Type | Skip % at 0.5 / 1.5 / 2.0 / 4.0 | Events lost | Reads lost or wrong at 4.0 |
|---|---|---|---|
| Gameplay types (M3, M4, M5, X1 MP, B2, N1 MP) | 0 to 4 / 0 to 9 / 0 to 11 / 2 to 22 | 0 | M4: 1 false carry. Others: 0 |
| B1 | 4 / 6 / 7 / 11 | 0 | 2 reads lost, 20 false carries |
| X1 BR banner | 3 / 7 / 9 / 19 | 0 | 2 reads lost (1 lost already at 1.5 and at 2.0) |
| N1 BR | 22 / 37 / 43 / 56 | 0 | 0 |
| M1 post-match (2 fps) | 45 / 46 / 47 / 50 | **1 at 4.0** | 27 reads lost |
| M1 scoreboard (2 fps) | 19 / 31 / 33 / 44 | 0 | 0 |
| M2 (2 fps) | 27 / 30 / 32 / 37 | 0 | 0 |

A false carry is a skipped sample whose kept result differs from what OCR would have read.

- In gameplay, an ROI gate skips little (mostly under 10 %). The HUD around the text moves all the time, so the crop changes even when the text does not.
- On end screens, the gate skips 19 to 50 %. It loses nothing up to 2.0. At 4.0 it drops a whole M1 post-match event.
- **Proposal:** keep 1.5 for ROI crops in gameplay (it gains little, but costs nothing measurable). Use 2.0 on end-screen ROIs (about 33 to 47 % skipped, 0 events lost). Do not use 4.0.

**On full frames at 1 fps** (the current W1 method). The gate rule was re-run without OCR on all A5b and A5c footage at 1 fps (3,033 frames; 276 s wall time, 09:39:15 to 09:43:51 UTC). It was checked against the real scans first: at 1.5, the simulation skipped 225 frames and the scans skipped 224, and the two agreed on 3,020 of 3,033 frames. The hits are the existing 1 fps analyse hits (made with the 1.5 gate, so 1.5 loses 0 by construction). A "lost" hit frame is a hit frame that a stricter threshold would skip. It is an upper bound: the skipped frame keeps the previous frame's boxes, and that may still contain the hit.

| Threshold | Frames skipped | Hit frames lost (of 2,068) | B1 (of 681) | M5 (of 1,254) | M1 (of 104) | N1 (of 52) | M2, M3, M4, B2, X1, N2 |
|---|---|---|---|---|---|---|---|
| 1.5 (current) | 7.4 % | 0 | 0 | 0 | 0 | 0 | 0 |
| 2.0 | 10.6 % | 38 | 34 | 2 | 1 | 1 | 0 |
| 3.0 | 14.2 % | 76 | 66 | 8 | 2 | 1 | 0 |
| 4.0 | 16.2 % | 83 | 69 | 12 | 3 | 1 | 0 |
| 6.0 | 19.1 % | 102 | 81 | 17 | 7 | 1 | 0 |

- A stricter full-frame gate gains little: going from 1.5 to 6.0 skips 11.7 % more frames. The losses fall mostly on the BR kill feed (B1), where only the small feed text changes while the scene stays still.
- **Proposal:** keep 1.5 on full frames. A stricter full-frame gate is not worth it.

### 5.4 Cost against real time (CPU, idle ms from §4)

| Set | OCR ms per second of footage | × real time |
|---|---|---|
| MP gameplay (M3 banner, text_stack, M5, X1 card, N1 MP) | 1,158 | **1.16×** |
| MP gameplay, cheaper M3 option (banner 3 Hz) | 938 | 0.94× |
| BR gameplay (B1, X1 banner, B2, N1 BR) | 548 | 0.55× |
| MP end screens (M1 both ROIs, M2) | 511 | 0.51× |
| MP, all ROIs every frame (no screen gate) | 1,669 | 1.67× |
| Current W1 method: full frame at 1 Hz, default profile | 1,073 | 1.07× |

- OCR only. Decode, the gate and matching come on top (in the gate run, decoding one 60 s segment to 1 fps with `hwaccel cuda` took about 5.3 s of wall time, under the other project's load).
- The end-screen set only needs to run on end screens. That requires a screen gate (the detectors' `screens` field); the tracker does not yet use it. The "no screen gate" row is the cost without it.
- **Finding:** at the rule's rates, MP gameplay costs about 1.2 s of 4-thread CPU OCR per second of footage. That is more than real time, so live MP does not fit on the CPU. Options for the user: (a) the cheaper M3 option (0.94×, still close to the limit); (b) a smaller margin; (c) GPU OCR (§6, with the VRAM conflict in §6.3); (d) only post-stream at these rates, with 1 Hz full frames live.
- The proposed rates still read events that the current 1 Hz full-frame method misses: at 1 Hz, every event shorter than about 1 s can fall between two samples. Gameplay p10s range from 0.39 to 1.91 s.

## 6. GPU OCR (read only; nothing installed)

```
nvidia-smi --query-gpu=name,memory.total,driver_version,utilization.gpu,memory.used --format=csv
NVIDIA GeForce RTX 4050 Laptop GPU, 6141 MiB, 621.01, 0 %, 1573 MiB
nvidia-smi (header)
| NVIDIA-SMI 621.01                 KMD Version: 621.01        CUDA UMD Version: 13.5     |
| N/A   43C    P8              3W /   50W |    1573MiB /   6141MiB |      0%      Default |
Win32_VideoController: NVIDIA GeForce RTX 4050 Laptop GPU 32.0.16.2101; Intel(R) UHD Graphics 32.0.101.5542
.venv: onnxruntime 1.31.1 ['AzureExecutionProvider', 'CPUExecutionProvider'] CPU
       onnxruntime-gpu not installed; onnxruntime-directml not installed; rapidocr 3.10.0; Python 3.14.7
```

- **CUDA.** This nvidia-smi does not print a "CUDA Version" line. It prints "CUDA UMD Version: 13.5", the CUDA version that the driver's user-mode driver supports. Driver 621.01. 1,573 MiB of VRAM was already in use by desktop apps (the compute-apps list showed browsers, Discord and others, with N/A per process under WDDM).
- **Providers.** The installed onnxruntime has **no CUDA and no DirectML provider**: only CPU and Azure.
- **RapidOCR.** Both are supported through configuration: `EngineConfig.onnxruntime.use_cuda` (`cuda_ep_cfg` with `cudnn_conv_algo_search: EXHAUSTIVE`) and `use_dml` (see `rapidocr/config.yaml` and `inference_engine/onnxruntime/provider_config.py` in the venv). If the provider is missing, it falls back to CPU with a warning. The RapidOCR usage page (rapidai.github.io/RapidOCRDocs, main/install_usage/rapidocr/usage) recommends starting with onnxruntime CPU and documents GPU only for the torch engine.
- **Models** (in the venv): `PP-OCRv6_det_small.onnx` 9.9 MB, `PP-OCRv6_rec_small.onnx` 21.2 MB, `ch_ppocr_mobile_v2.0_cls_mobile.onnx` 0.6 MB (cls is off in the crop profile).

### 6.1 What would have to be installed (not installed; sizes from the PyPI JSON API, 2026-10-28)

| Option | Package(s) | Size (download) |
|---|---|---|
| CUDA | `onnxruntime-gpu==1.31.1` (`onnxruntime_gpu-1.31.1-cp314-cp314-win_amd64.whl`, 168,776,491 B) with the extras `[cuda,cudnn]`: `nvidia-cuda-runtime~=13.0` (13.4.92, 2,778,543 B), `nvidia-cuda-nvrtc~=13.0` (13.4.92, 46,972,283 B), `nvidia-cufft~=12.0` (12.4.0.43, 160,953,139 B), `nvidia-curand~=10.0` (10.4.4.72, 56,731,059 B), `nvidia-cudnn-cu13~=9.0` (9.27.0.42, 436,469,905 B), which requires `nvidia-cublas` (13.8.0.4 is the newest Windows wheel, 423,266,897 B) | about **1,296 MB** in total. The unpacked size is larger (UNVERIFIED). |
| DirectML | `onnxruntime-directml==1.24.4` (newest; `onnxruntime_directml-1.24.4-cp314-cp314-win_amd64.whl`, 25,571,098 B) | **25.6 MB**. It is a different, older ORT (1.24.4 against 1.31.1). |

- Both packages provide the same `onnxruntime` module, so the CPU `onnxruntime` package would have to be uninstalled first. Both versions would need a re-check against `services/clip/requirements-ocr.lock.txt`.
- CUDA 13 runtime wheels fit the driver's CUDA 13.5 UMD (UNVERIFIED until installed).
- The pip package versions are the newest that match `onnxruntime-gpu`'s pins; the exact resolver output is UNVERIFIED.

### 6.2 Expected speed-up (an ESTIMATE, not measured)

- **ROI crops (the §5 proposal): about 1.5 to 3× for det+rec, maybe less.**
  - The crops are small: 300 to 900 px on the long side. The PP-OCR "small" models are mobile-class networks. On the CPU, one crop takes about 50 to 90 ms (§4).
  - On a GPU, each inference has a fixed cost: kernel launches for every layer, host-to-device and device-to-host copies, and synchronisation. That cost is a few milliseconds per model call. A crop with k text boxes makes 1 det call plus k rec calls (RapidOCR batches rec, so maybe fewer calls).
  - The rec input width changes with each text box. With `cudnn_conv_algo_search: EXHAUSTIVE`, every new shape triggers a cuDNN algorithm search, which makes the first calls slow. It would need `HEURISTIC` or `DEFAULT`, or fixed-width padding (UNVERIFIED).
  - Reasoning: the fixed cost per call is a large share of a 50 ms CPU call. This follows ONNX Runtime CUDA EP practice: the ORT performance-tuning guidance on I/O binding, copy overhead and dynamic shapes, and the RapidOCR recommendation for CPU above. Nothing was measured here.
- **Full visible-area frames (the current W1 method): about 3 to 6×.** At 1566×1080, det is compute-bound, and about 27 boxes go through rec, so the GPU's fixed cost is a small share (an estimate).
- **DirectML:** expected to gain less than CUDA for small dynamic-shape models. It is an older ORT. UNVERIFIED.
- To measure: install one option into a separate venv (with approval), then run the same `bench` on the same folders.

### 6.3 VRAM rule conflict (flag for the user)

CLAUDE.md says: while live, only the live-AI sidecar (small Whisper on GPU, C4 classifier on CPU) stays loaded. GPU OCR in the live coverage tracker would be a second GPU model set. It would also add a CUDA context with cuDNN and cuBLAS workspaces: likely a few hundred MB of VRAM (UNVERIFIED) on a 6 GB card that already shows 1.5 GB in use at idle. So GPU OCR while live breaks the rule, unless the user counts the tracker's OCR as part of the sidecar's budget. **Decision needed.**

Until then, the live tracker stays on the CPU. With ROI crops at the §5 rates, that costs about 0.55× real time for BR gameplay and 1.16× for MP gameplay (§5.4), so live MP does not fit at those rates on the CPU. GPU OCR could still be used for post-stream work, because post-stream models load and unload one at a time.

## 7. UNVERIFIED items and risks

- The load during W1 (apart from the overlapping `files` run) and the power state at the time.
- Why idle today is faster than A5 §6 on the same crop folders.
- The idle ms for B1/killfeed and M1/endscreen_row (estimates). B2 and N1 ms are from a loaded run, so they are upper bounds.
- The cause of the slow ms from about 09:02 to 09:12 UTC. Durations are not affected.
- M1 scoreboard read durations (a matcher limit; see §5.1). M1 values are limited by the 2 fps re-read.
- Small n: N1 BR (3), M2 (5); B1, B2 and X1 BR come from A5b only; K1 and N2 were not measured.
- The cheaper M3 option depends on the text stack listing chained medals. Not checked.
- Every GPU number in §6 (size unpacked, speed-up, VRAM use).
- Risk: the rule uses p10 over at most 10 events per type, so a rare shorter event (for example, a 0.3 s chained medal) can still be missed. Both sessions are from one day and one device setup.
- Risk: a rate change also changes cooldown and window behaviour in the event step. That was not looked at here.

## Files created or changed

- Created: `docs/evidence/2026-10-28-p2b-ocr-timing.md` (this file).
- Created (private, gitignored): `docs/evidence/private/ocr-timing/` with `frames-full/` (30 PNG), `bench-full-frames.json`, `bench-live-mp-crops.json`, `bench-corpus-crops.json`, `durations-rows.jsonl`, `durations-agg.json`, `durations-summary-*.json`, `roi-cost.json` (load-affected, not used), `check/`, `gate-full-1fps.json`.
- Not changed: `data/games/codm/detectors.json`, `data/games/detector-pack.schema.json`, `services/clip/g1_scan.py`, `services/clip/coverage.py` (for this task).
