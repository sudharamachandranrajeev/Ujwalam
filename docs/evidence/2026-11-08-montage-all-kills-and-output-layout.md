# 2026-11-08 — Montage from all kills, output folder layout, audio facts in validate

Status: code + tests PASS; real-recording run PARTIAL (see "Real run"). Decision text proposed as D298 (not yet in
the decisions file).

## User instructions (approval, 2026-11-08)

- A. "combine kills and make a montage. priority given to streaks of course."
- B. "use a folder and file name convention accordingly"; "there are useless things in recordings and clips folder.
  that folder is to find uploads if app cannot automatically upload."
- C. Clips and montages keep the source audio as recorded; validate reports audio track count and loudness per
  output (no game-audio detector).

## What changed

### A. Montage from every own kill (services/clip/clip_montage.py, data/clip/montage.json 0.2.0)

- Kills: own-kill kill-feed lines (M5, B1 with signal true) plus medal-inferred kills (unchanged rule).
- Groups: kills/medals within chainGapSec, split at a streamer death. A group whose medal score reaches
  ranking.minScore is a streak; every other group is single kills (new: they are used, not dropped).
- Order for selection and playback: streaks by score (best first), then single-kill groups (most kills first, then
  time). First-fit into montages up to targetMaxSec (45 s); an empty montage takes a group up to maxSec (60 s). Short
  montages join inside maxSec; a montage still under minSec (20 s) gives its groups to the others inside maxSec.
  More kills than fit = more montages.
- Unchanged: 3 s before / 1.5 s after each kill, hard cuts with 80 ms audio fade, matches may be joined, the death
  rule (hard negative). Short clips and the live clipper stay streak-only (`streaks()` keeps the old filter).

### B. Output layout (services/clip/clip_names.py, services/clip/clip_publish.py, clipper.py, record-clips.mjs)

Clips folder (Settings > Clips folder) holds finished, validated videos only:

    <clips>\YYYY-MM-DD\<game>_<kind>_<YYYYMMDD-HHMMSS>_<label>_<nn>_<canvas>.mp4
    e.g. 2026-11-08\codm_montage_20261108-185824_kills-5_01_v.mp4
         2026-11-08\codm_short_20261108-185841_triple-kill_01_v.mp4
         2026-11-08\codm_won-reel_20261108-185824_victory-kills-4_01_v.mp4

- kind: short | montage | won-reel. label: best medal (short), kills-N (montage), victory-kills-N (won reel).
- time: local wall time of the clip's first moment (short: start; montage/reel: earliest piece; live clip: save
  wall time). nn: 01.. per kind; never overwrites (next free nn).
- canvas: `v` = cut of the V canvas recording; `v-<layout>` = vertical layout made from H (full-crop, ...); `h`
  reserved for horizontal outputs.
- Run folders live in app data: `<data>\clips\runs\<recording name>\` (candidates.json, detector-hits.jsonl,
  detector-pass.json, match-stats.json, matches.json, render.json, report.json, published.json, montage\, working
  videos). The run log stays at `<data>\clips\run-<name>.log`. Upload list: `<data>\clips\uploads.json`
  ({file, kind, label, seconds, run, recording, posted: []}).
- Publishing hard-links the validated file (same drive: no second copy on disk; copy otherwise); the run folder
  keeps its file, so services/posting packageRun keeps working on the run folder.
- Launcher (record-clips.mjs): `--out <data>\clips\runs\<name>` + `--publish <clips folder>`; a whole-recording run
  adds `--montage` when the V recording exists; a review run adds `--drop-used-saves`. countClips counts published
  videos; status `last.folder` = the clips folder.
- Replay saves: the folder and name are decided in native host code (app/host/src/methods.cpp
  `replay-{canvas}-%CCYY%MM%DD-%hh%mm%ss` in `<recordings>\replay`; replay.save takes only {canvas}). Not changed
  (no native restructure). Instead `live-review --drop-used-saves` deletes the window's live-clipper saves (H and V,
  host-named, in a `replay` folder only) once every clip rendered and validated. Hand-made replay saves are not in
  saves.jsonl and are never touched.
- Recordings: names come from the host (app/host/src/outputs.cpp `<sink name base>-<stamp>.<ext>`, base from the
  outputs plan, e.g. data/outputs/alpha-practice.json `practice-h.mkv`), giving `<profile>-<h|v>-<YYYYMMDD-HHMMSS>.mkv`.
  This already matches the convention; date sub-folders would need native code and were not done.
- Migration: `clipper.py tidy --recordings DIR --clips DIR [--dry-run | --apply]`. Default is a read-only listing;
  `--apply` is required to act; renames/moves never overwrite; deletes only host-named live-clipper replay saves that
  were already edited into clips; empty run folders removed afterwards.

### C. Audio

- Single clips map every source audio track (`-map 0:a`, was `0:a:0`); montages concat every track as its own track
  (`audio_tracks` in render_argv). Track 1 stays first (the studio mix).
- validate: per file `audio: {tracks, sourceTracks, loudness: [{track, lufs, peakDb, quiet}]}` (ebur128 integrated
  loudness and true peak); fewer tracks than the source = FAIL; `quiet` (< -50 LUFS) is a note to listen, never a
  failure. report.json carries `audioRule`.

## Tests

- `npm run test:py`: Ran 343 tests, OK (skipped=49; skips are the numpy/OCR-venv tests on the system Python).
  New: tests/py/test_clip_output_layout.py (15: names, publish, idempotence, montage/won-reel names, live wall time,
  drop saves, tidy dry run is read-only, tidy apply, dropped-track fail, loudness parse). tests/py/test_clip_montage.py
  (+7: singles without streaks, streaks first then singles, extra montages, leftovers top-up, death cut, streak-only
  kept for short clips, all audio tracks). tests/py/test_clip_pipeline.py end-to-end: `run --publish` puts 3 convention
  names in the clips folder, uploads.json has 3 rows, report has audio tracks 1/1 and loudness.
- `node --test tests/record-clips.test.mjs`: 12/12 pass (run folder in app data, --publish, --montage only with V,
  --drop-used-saves, countClips from published.json, last.folder).
- `node tools/ci.mjs --quick` (the pre-commit hook): 8/8 PASS (build, lint, build-host, validate-registry,
  validate-outputs, validate-games, private-scan, legacy-verify), after configuring the native builds in this worktree
  (app/spike/build and out/host/build, gitignored; no native code changed). Full CI not run (by instruction).

## Real run (practice recording 2026-11-08 18:55:25, 25 min)

Venv `C:\AI\Claude\Ujwalam\.venv`, below-normal priority, 4 threads, one heavy job; outputs only under the scratch
folder `...\scratchpad\clips-test`; the user's data dir read only (project and settings copied).

1. Detector pass 1 (worktree had no data/profile.local.json, so the own name never matched): 461 hits, 76 with
   signal, kill feed M5 0 own. Montage from it, rendered from the real V recording:
   - M01 22.0 s, 4 pieces, 5 kills (5 in 4 streaks, 0 single) — medal-inferred kills only.
   - W01 won-match reel 22.0 s, 4 kills.
   - Both PASS validate; audio 1 track (source 1). Loudness: M01 -70.0 LUFS, peak -51.7 dBTP (quiet); W01 -46.0 LUFS,
     peak -29.9 dBTP. This matches the known missing game audio in today's recordings (native bug fixed separately).
   - Published (hard links): `2026-11-08\codm_montage_20261108-185824_kills-5_01_v.mp4`,
     `2026-11-08\codm_won-reel_20261108-185824_victory-kills-4_01_v.mp4`; uploads.json 2 rows; nothing else in the
     clips folder.
2. Detector pass 2 with the profile (`--profile` = the main checkout's local profile, read only): 519 hits, 146 with
   signal, M5 56 own-kill lines, match stats ownKills 125. Plan (clip_montage.plan_montages on these hits):
   - 67 own kills in 49 groups; 5 streaks (14 kills). 14 kills fall inside a death window (KILLCAM) and are cut by the
     death rule; the other 53 are all used.
   - M01 52.0 s, 13 kills (11 in 4 streaks + 2 single); M02 43.5 s, 10 kills (2 in 1 streak + 8 single);
     M03 44.5 s, M04 45.0 s, M05 44.0 s, 10 single kills each. Old rule (streak kills only): 5 streaks.
   - Won-match reels: 69.5 s (18 kills), 73.0 s (19 kills).
   - Not rendered: the V recording `practice-v-20261108-185525.mkv` (and the 18:37:55 recordings, the replay folder
     and the clips folder contents) were removed from the user's folders at about 20:57 by something outside this
     task, between pass 2 starting and finishing. This task never wrote to or deleted from those folders (tidy ran
     as a dry run only, before that time).

## Tidy dry run on the user's folders (before the 20:57 clean-up)

`clipper.py --data-dir %LOCALAPPDATA%\Ujwalam\data\core tidy --dry-run --recordings "...\Ujwalam Recordings"
--clips "...\Ujwalam Clips"`: 5 rename, 10 move, 10 delete, 6 keep, 0 leave. Renames: the five live clips
L01-L05 `stream-v.mp4` to `2026-11-08\codm_short_<stamp>_<medal>_<nn>_v.mp4`; moves: the analysis JSON of both run
folders to `<data>\clips\runs\...`; deletes: the 10 replay saves (H+V of 5 saves) already edited into clips; keeps:
the 4 recordings and the 2 replay files of 18:41:00 (a live save never edited into clips). Nothing was changed.

## Risks / open

- Montage M01 in pass 2 is 52 s (inside 20-60 s, above the 30-45 s target) because a top-up step adds leftovers
  inside maxSec.
- Kill-feed own kills need the local profile; a worktree or install without it falls back to medal kills only.
- App-data run folders keep a hard link of every published video; no retention rule yet.
- uploads.json `posted` is not yet filled by services/posting (follow-up).
