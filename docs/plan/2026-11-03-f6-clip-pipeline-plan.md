# 2026-11-03 — F6 clip pipeline plan (post-stream)

Scope: v1 F6 "Automatic clipping" (`2026-10-29-ujwalam-v1-10-day-plan.md`, days 6–8) and alpha plan Part B item 1 (`2026-11-01-ujwalam-alpha-live-testing-and-continuity.md`). Post-stream only: recording + markers + chat log → ranked candidates → 3 vertical variants → local Whisper captions burned in → validated files. Behind the existing flag `clip-pipeline` (`data/flags.json`, off by default). Live signal fusion, the review screen and posting are separate items.

## 1. What exists vs F6

| F6 piece | Exists | Gap |
|---|---|---|
| Replay buffer H and V | Host `replay.cpp` (A0 d2) | none for post-stream |
| Hotkey markers | Host `moments.*`: `<dataDir>/markers/<hostSession>.jsonl`, `{at, source, note, recordMs, streamMs}` | nothing reads them yet; chat/audio sources are API entry points only |
| Recording | Host record sinks: `<recordings>/<base>-YYYYMMDD-HHMMSS.mkv` (local time) | no link from a marker to a file except `at − recordMs` |
| Chat log | Event core `event-core.db`, table `chat_raw (received_at ms, platform, text)` | nothing turns it into a per-second signal |
| Chat / audio baselines | Approved P2 baselines (`2026-10-27-p2-clip-baselines.md`): chat velocity vs session baseline, short-term loudness peaks | not built (P2 parked) |
| CODM detectors (medal banner, multi-kill) | `services/clip/g1_scan.py` OCR on vertical cutouts; pack `data/games/codm/` | every detector `unverified`, every weight `null`; tuned on cutouts, not the full H recording (no layout for it). Not proven; P2 parked |
| Candidate ranking | none | build |
| 3 vertical variants | none | build (build plan §4.10: full crop, gameplay + facecam, blurred fill) |
| Captions (local Whisper) | none; no Whisper package, model or binary on the laptop; ffmpeg 8.1 build has no `whisper` filter | seam + ASS writer + burn-in; transcriber needs an install |
| Validation | `tools/` ffprobe loopback checks for live outputs only | build for clip files |
| Short-form platform limits | `data/platforms/*` cover live delivery only | add `data/clip/targets.json` with source + checked, UNVERIFIED until checked |
| Feature flag | `clip-pipeline` in `data/flags.json`; Node reader `services/flags/` | Python reader with the same rules |

## 2. Build steps (in order)

1. **Flag + common** (`services/clip/clip_common.py`): Python flag reader (same semantics as `services/flags/index.mjs`: unknown id off, local file overrides default), data-dir resolution (`--data-dir` or `paths.event_core_data`), ffmpeg/ffprobe lookup on PATH or `--ffmpeg`, below-normal priority children, ffmpeg threads capped (4), output folder refused in the repo unless gitignored, never inside the corpus.
2. **Signals** (`clip_signals.py`):
   - markers: read host jsonl, keep markers whose recording start (`at − recordMs`) matches the recording's start (file-name stamp, or `--record-start`) within 5 s; marker time in the file = `recordMs`.
   - chat: read `event-core.db` read-only (`mode=ro`), per-second message counts and "clip it" intent counts for the recording span; text is matched in memory and never written.
   - audio: ffmpeg `ebur128` short-term loudness (S) per 100 ms → per-second max, CPU only, audio stream only.
   - detector hits (seam): optional jsonl `{t, detector, label}` from a future full-frame CODM pass; read only if given.
3. **Ranking** (`clip_rank.py`): per-second fused score → windows. Hotkey/chat/api markers are explicit candidates (backdated per §4.10). Chat velocity vs session median and loudness z-score vs session median give peaks. Overlapping windows merge; reasons kept (source, value, baseline). Weights, windows and thresholds live in `data/clip/ranking.json` with `status: proposed` until the user approves them. Output `candidates.json` (times, score, reasons; no chat text, no names).
4. **Captions** (`clip_captions.py`): transcriber seam with backends `none` (default; no captions, recorded as such), `whisper-cli` (a whisper.cpp binary path given by the user; UNVERIFIED), `faster-whisper` (used only if the package is importable; not installed). Segments → ASS with safe-zone margins from the target intersection, word wrap, max two lines.
5. **Render** (`clip_render.py`): one ffmpeg run per (candidate, layout), 1080×1920, H.264 + AAC, +faststart. Layouts from `data/clip/layouts.json`: `full-crop`, `game-facecam` (regions are UNVERIFIED placeholders until the user marks the facecam rectangle), `blurred-fill`. Captions burned with the `subtitles` filter (libass). Encoder: `libopenh264` (CPU; default while another GPU job runs) or `h264_nvenc` (GPU; one GPU job at a time).
6. **Validate** (`clip_validate.py`): ffprobe each file: codec, size, fps, duration, audio, file size and duration against every target in `data/clip/targets.json`; `report.json` with PASS/FAIL per target.
7. **CLI** (`services/clip/clipper.py`): `candidates`, `render`, `validate`, `run` (all three). Refuses with exit 3 when `clip-pipeline` is off.

Later (not in this pass): review screen wiring (agent B), posting (P16/F7), full-frame CODM detector pass on the H recording, live fusion.

## 3. Inputs and outputs

- In: one H recording (`.mkv`), the host markers jsonl (0..n files), optional `event-core.db`, optional detector hits jsonl.
- Out (`--out`, outside the repo or gitignored): `candidates.json`, `clips/<candId>/<layout>.mp4`, `clips/<candId>/captions.ass`, `report.json`. Never media in git.

## 4. Tests and evidence

- `tests/py/test_clip_*.py` (stdlib unittest, `npm run test:py`): flag reader, marker mapping, chat bucketing (timestamps only), intent regex, ebur128 parsing, ranking merge/backdate, ASS writer, filter graphs, validation rules.
- Plumbing end to end with a generated lavfi source (`testsrc2` + tone with loud bursts) and a generated markers file in a temp folder; skipped when ffmpeg is missing. No invented labels or synthetic chat used for evaluation.
- Evidence: `docs/evidence/2026-11-03-f6-clip-pipeline-plumbing.md`.
- Not evidence of clip quality: ranking quality needs a real stream (T6) and the user's top-10 check.

## 5. Risks

- Ranking without labels is a guess; hotkey markers carry most of the value until T6 feedback.
- `game-facecam` crop regions depend on the user's scene layout; wrong regions cut the face or the HUD.
- CPU encode (`libopenh264`) is slow and lower quality; NVENC is the target but competes with a live stream (post-stream only, one GPU job).
- Chat volume is low (A3: ≤ 0.19 viewer msgs/min), so chat peaks will rarely fire.
- Short-form limits change often; values are UNVERIFIED until checked against official pages.

## 6. Needs the user (each has a default)

1. **Whisper install** (pip `faster-whisper` into `.venv`, or a whisper.cpp release binary) and **model download** (default: `small` or `base.en`? default `small`, multilingual, because of Malayalam/Manglish speech). Default until then: captions off (`none`).
2. **Ranking weights/windows** in `data/clip/ranking.json` (status `proposed`). Default: hotkey 1.0, chat-intent 0.6, chat velocity 0.3, loudness 0.4; backdate 30 s before / 10 s after a marker; peaks 20 s before / 10 s after. Approve or edit.
3. **Facecam rectangle** in the H canvas for `game-facecam`. Default: top-right 25 % placeholder; layout skipped in the report as UNVERIFIED geometry until set.
4. **Variants vs platforms:** default is three layout variants, each checked against all three targets (Shorts, TikTok, Reels), captions inside the intersection of their safe zones. Alternative: one file per platform.
5. **Short-form limits** (`data/clip/targets.json`): default values from agent knowledge, marked UNVERIFIED; please confirm or point at the official pages.
6. **Encoder for post-stream renders:** default `h264_nvenc` when no `ujwalam-host` is live, else `libopenh264`.
7. **Real data for T6:** a recorded stream with hotkey markers and the event-core db, to run the clipper and check the top 10.
