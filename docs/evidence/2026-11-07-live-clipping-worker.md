# 2026-11-07 Live clipping worker (D226–D228)

Status: built and tested offline. **Not yet used on a real stream** (flag `live-clips` off by default). Live behaviour UNVERIFIED.

## What exists

| Part | File | Evidence |
|---|---|---|
| Kill-chain rules (quiet / death / force save) | `services/clip/live_chain.py`, `data/clip/live-clips.json` (proposed) | `tests/py/test_live_chain.py` 6/6 OK; dry run on 2026-11-06 practice hits: 31 saves, 4 overlapping, 1 forced (quietSec 12) |
| Host frame grab (`frames.grab`), `clips` token role, replay save `-2` suffix | `app/host/src/frames.*`, `methods.cpp`, `rpc_server.*`, `replay.cpp` | host-api 16/16, host-project 11/11, host-a0-day2 10/10 |
| ROI OCR, GPU via DirectML | `detector_pass.FrameScanner`, `.venv-gpu` | `docs/evidence/2026-11-07-roi-ocr-speed.md`: 1.93x real time, same rows as CPU |
| Worker (grab → scan → chain → replay.save + marker + saves.jsonl) | `services/clip/live_worker.py` | `tests/py/test_live_worker.py` 6/6 OK (BMP read, bearer + error mapping with a fake host, save order, sidecar row, env check, merge) |
| Launcher start (clips token only, restart ≤5) | `services/studio-ui/launch.mjs` `liveClipsSpec` | `tests/studio-ui-alpha.test.mjs` 27/27 pass |
| Post-stream review | `clipper.py live-review` | smoke run below |

## Runs

Real frame of the 2026-11-06 practice recording (t = 2 s, a medal on screen), GPU venv:

```
.venv-gpu/Scripts/python.exe -I services/clip/live_worker.py --layer game --once f.bmp
live-clips: scanner 1920x1080, ocr gpu (DirectML)
{"rows": 6, "gpu": true}
real 0m2.624s   (includes process start and model load)
```

`live-review` on a synthetic 60 s 1080x1920 V file with one save (startBack 30, endBack 5):

```
live-review L01/stream-v: rendered (25.0 s)
live-review: 1 save(s) -> 1 clip(s), 0 failed render(s)
validate L01/stream-v: PASS
validate: 1/1 PASS
```

## Not verified

- `frames.grab` on a real capture-card (dshow) source while streaming; GPU cost of OCR next to NVENC (6 GB VRAM).
- End-to-end save timing on a live replay buffer (startBack/endBack against real files).
- Detector accuracy is the post-stream pass's (detectors unverified).

## How to try (after "devices ready")

1. Switch on `live-clips` on the control page (and `clip-pipeline` for the review).
2. Start the studio with devices; the log says `live clipper started (OCR GPU, DirectML ...)`.
3. After the stream: `python -I services/clip/clipper.py live-review --saves <data>/live-clips/<session> --out <folder>` then `validate --out <folder>`.
