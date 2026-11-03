# 2026-11-03 — F6 clip pipeline: plumbing evidence

Plan: `docs/plan/2026-11-03-f6-clip-pipeline-plan.md`. Flag: `clip-pipeline` (off by default). Status: **plumbing works end to end on generated media. Not done**: no real stream yet, captions have no transcriber installed, ranking weights are proposed (unapproved), `game-facecam` geometry is a placeholder.

## 1. What was run

All CPU (`libopenh264`, 4 threads, below-normal priority) while the 1 h soak held the GPU. Inputs were generated with ffmpeg lavfi (`testsrc2` 1920x1080 30 fps, 90 s, a 440 Hz tone with two loud bursts at 40 s and 70 s) and a fixture markers file (one hotkey marker at recordMs 20000, one from another recording, one with recordMs null). No corpus files, real chat or labels were used. Media stayed in the session scratchpad, outside the repository.

```
python -I services/clip/clipper.py --data-dir <tmp>/dataoff candidates --recording <tmp>/rec-h-20261103-070000.mkv --markers <tmp>/markers.jsonl --record-start 2026-11-03T07:00:00Z --out <tmp>/out
clipper: the 'clip-pipeline' feature flag is off (switch it on from the control page)
rc=3

python -I services/clip/clipper.py --data-dir <tmp>/data candidates ...   (flags.local.json: clip-pipeline true)
candidates: 2 from 3 events (markers 1, chat off, audio on, detectors 0); ranking proposed
markers: rows 3, matched 1, noRecord 1, otherRecording 1
audio: 900 ebur128 blocks, baseline median -36.9 LUFS
c01 0.0-51.5 score 1.4 [marker.hotkey 20.0, audio.loudness 41.5]
c02 51.5-81.5 score 0.4 [audio.loudness 71.5]

python -I services/clip/clipper.py --data-dir <tmp>/data render --recording ... --out <tmp>/out --encoder libopenh264
render c01/full-crop: 13.47 s   c01/game-facecam: 15.64 s   c01/blurred-fill: 20.0 s
render c02/full-crop: 7.01 s    c02/game-facecam: 8.88 s    c02/blurred-fill: 10.88 s
render: 6 file(s), 0 failed, with libopenh264, captions none     (76 s wall for 6 x 1080x1920 files, 245 s of output)

python -I services/clip/clipper.py --data-dir <tmp>/data validate --out <tmp>/out
validate: 6/6 PASS   (h264, 1080x1920, yuv420p, aac, duration within 0.6 s, full decode clean; checked against youtube-shorts, tiktok, instagram-reels)
```

Visual check (contact sheet of one frame per layout, looked at by the agent): full crop shows a centred 9:16 slice; game-facecam shows the top-right quarter of the source over the cover-cropped game; blurred fill shows the whole 16:9 frame over a blurred background. Caption burn-in (fixture ASS, `subtitles` filter, Arial via libass) renders two centred lines above the bottom safe margin on all three layouts.

## 2. Tests

`tests/py/test_clip_pipeline.py`: 32 tests (flag reader, out-dir safety, recording start, marker matching, read-only chat counts, intent pattern, ebur128 parsing, detector-hit seam, ranking, ASS writer, whisper.cpp JSON parsing, backends without install, filter graphs, argv, validation rules, plus 3 end-to-end cases on a generated 12 s source: flag off refuses, `run` gives 3/3 PASS, caption burn-in validates).

```
npm run test:py      Ran 177 tests ... OK (skipped=16)   (16 skips are the existing OCR/capture suites)
npm run lint         lint: 0 finding(s), 27 allow marker(s)
node --test tests/flags.test.mjs tests/studio-ui-flags-feedback.test.mjs   7 + 16 pass
npm run validate:games   OK: 1 game pack(s) valid: codm 0.3.0
```

## 3. Findings during the build

- No ffmpeg ships in the repo or the vendored OBS runtime; the one on PATH (winget, BtbN 8.1) is an LGPL build: no `libx264`, no `boxblur`; `gblur` and `libopenh264`/`h264_nvenc` are used instead. It has libass (`subtitles`) and no `whisper` filter.
- `ebur128=framelog=verbose` prints nothing at ffmpeg's default log level; `framelog=info` is used.
- Chained, touching windows merged into one 80 s span on the first run; merging is now capped at `clip.maxSec` and a candidate more than half inside a better one is dropped.

## 4. Placeholders, mocks, UNVERIFIED

- Captions: backends `whisper-cli` and `faster-whisper` are seams; neither is installed (UNVERIFIED). Default `none`.
- Ranking weights/windows: `data/clip/ranking.json` status `proposed`, not approved, not tuned on labels.
- Short-form limits and safe zones: `data/clip/targets.json`, all `unverified` (agent knowledge, not official pages).
- `game-facecam` rectangle: placeholder (geometry `unverified`).
- CODM detectors: only a hits-file seam; no full-frame pass on the H recording exists (detectors unverified, P2 parked).
- Chat: `chat_raw` rows are any event with text (chat and alert messages); whether rows are present during a real stream is UNVERIFIED here.
- NVENC render path: see §5.

## 5. NVENC

Not run (UNVERIFIED). The GPU was held by the soak, then by a coordinator hold for a device test and a live test stream. The `h264_nvenc` argv is unit-tested only. Next GPU slot: `clipper.py render --encoder h264_nvenc` on the same generated source, then `validate`.
