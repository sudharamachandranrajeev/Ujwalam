# 2026-11-10 Kill montages on the "while" clip path (live-review --montage)

Branch `clip/live-montage`. Decision D322 (proposed). User feedback 2026-11-10: "checked the normal clips. but did not
receive the montage clips from Ujwalam".

## Cause

The studio's clip job for a recorded stream (`services/studio-ui/record-clips.mjs` `clipRunSpec`, type `review`) runs
`clipper.py live-review --recording H ... --publish`. live-review ran `detect` on the H recording for the match gate
(the run folder had `detector-hits.jsonl`, `match-stats.json` and `matches.json`) and made 11 short clips, but it had no
montage step. Kill montages and match reels were made only by `clipper.py run --montage` (type `full`) or
`clipper.py montage`.

## What changed

- `services/clip/clipper.py`
  - `live-review` has three new options: `--montage`, `--v-recording F` (default: the `-v-` sibling of `--recording`),
    and `--montage-config F`.
  - The new helper `_live_montage(a)` runs after the short clips are rendered, validated and published, and after the
    used replay saves are dropped. It reuses `cmd_montage` unchanged: kill montages plus match reels per
    `data/games/codm/match-reels.json` (D315), written to `DIR/montage`, validated, and published with `--publish`.
  - When the run folder has no detector hits of the recording, `detect` runs once. It does not run when the match gate
    already ran a pass (the `detect_ran` mark). `detect` keeps its `HeavyJobLock`.
  - Missing H or V recording: the montage is `skipped`. Any montage exception or a failed montage validation:
    `failed`. Both are logged as `montage: NOT MADE (<reason>); the short clips are kept and published`.
  - The status is stored in `render.json` `montage` = {status made|failed|skipped, reason, rc?, videos?}.
  - **Exit code policy:** the montage outcome never changes live-review's exit code. A non-zero exit would make the
    studio report the whole job as failed, count 0 clips, and skip the post chain for shorts that were published.
  - Progress: `cmd_montage` already writes `montage`, then `validate` and `publish` lines.
- `services/studio-ui/record-clips.mjs`
  - type `review`: when the H recording exists and `job.v` exists, it adds `--v-recording <v> --montage` after
    `--recording <h> --threads 4 [--project P]`.
  - `--drop-used-saves` is unchanged: it deletes only the host-named replay saves (`clip_publish.drop_used_saves` /
    `is_replay_save`) and never the recordings. The e2e test checks that H and V are still there.
  - `jobStages` for a review with H and V: `detect, gate, review, publish, montage`. The tasks.mjs `measured: false`
    rule for `montage` (no stall warning) applies as before.

## Tests

`tests/py/test_clip_live_montage.py` (new):

- `SkipTests`: no V recording -> skipped; no recording -> skipped; when a detector pass already ran and left no hits,
  no second pass runs and the status is `failed`.
- `LiveMontageEndToEnd` (generated 12 s lavfi H and V, fixture hits with two own kills and a VICTORY placed #1, one
  live save, libopenh264):
  - `live-review --montage` -> exit 0; `montage/clips/W01/montage-v.mp4`; montage report W01 PASS; render.json montage
    `made`, 1 video; the clips folder holds 1 short and 1 won-reel; there is a `montage` progress line; H and V are
    still there.
  - the V recording has no audio -> exit 0; montage `failed` ("the V recording has no audio stream"); "montage: NOT
    MADE" in the log; 1 short published; no montage or reel published; `published.json` of the shorts is still there.
  - without `--montage`: no `montage` key and no `montage/` folder.

`tests/record-clips.test.mjs`: review argv with H and V (`--v-recording C:/r/v.mkv --montage`); with V gone, no
`--montage`; with H gone, no `--montage`; `jobStages` review with H and V ends with `montage`, and with V only gives
`review, publish`.

```
> .venv\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_clip_live*.py" -v
Ran 12 tests in 7.091s
OK
> .venv\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_clip_*.py"
Ran 176 tests in 29.686s
OK
> node --test tests/record-clips.test.mjs
tests 15, pass 15, fail 0
> node tools/ci.mjs --quick
ci: 9/9 passed in 67.7s
```

## UNVERIFIED

- Not yet run on a real recorded stream through the studio. The main session ran `clipper.py montage` by hand on the
  2026-11-09 run folder; this branch did not touch that folder.
- Run time on a real 1-2 h stream: when the match gate is off, `--montage` now runs a full detector pass that the review
  path did not run before. This is the same cost as the `full` path.
- The task panel shows `validate` and `publish` lines again after `montage`, because cmd_montage validates and publishes
  its own folder. The step index can go back for those lines (`validate` is not in the review stage list). This was
  already true for the `full` path.
- The studio shows no separate message for a failed montage. It is only in the job log and in `render.json`.
- The decision number D322 may collide with a decision added on another branch at the same time; renumber on merge.
