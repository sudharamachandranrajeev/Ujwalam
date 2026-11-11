# CL1 reel length (D350) — evidence, 2026-11-11

Result: **PASS** (headless, synthetic pieces and hits). A real recording rendered into parts, and the new Settings group at
real DPI, are UNVERIFIED (see the end).

Request (user, 2026-11-11): every montage and concatenated clip at most 1 minute for now, longer ones split into parts;
settings in the app to change the length per reel type. Decision: D350 in `docs/plan/2026-10-29-v1-decisions.md`.

## What was built

- `data/clip/reel-length.json`: defaults per type (montage 20-60 s, match reel 0-60, impact-play reel 10-60, short clip
  10-60, live clip 20-60) and `limitMaxSec` 60.
- `services/clip/reel_length.py`: `split_reel`, `cap_reels`, `effective_limits`, `limits_problems`. Splits only between
  pieces; a piece over the maximum is trimmed around its peak and the trim recorded.
- `services/clip/clipper.py` `cmd_montage`: montage, match-reel and impact-play outputs go through `cap_reels`; ids
  `M01p1`..; render.json, candidates.json and match-reels.json carry `part`, `parts`, `trimmed`, `belowMin`, `reelLength`.
  Short clips read their minimum and maximum (`cmd_candidates`); live clips too (`live_worker.py`, `live_chain.py`).
- `services/clip/clip_montage.py`: the planner uses the montage maximum, no longer cuts a long group to a window (it is
  kept and split); reels carry `peaks`; `impact_play_reels(min_sec=)`.
- `services/clip/clip_names.py`, `clip_publish.py`: file label `kills-12-part-2-of-3` (also won-reel, impact-play); label
  limit in the name 32 -> 40 characters.
- `services/studio-ui/user-settings.mjs`, `server.mjs`: `clips.reelLengths` (checked, merged type by type, defaults not
  stored); `GET /ui/api/settings` also returns `reelLengths` (types, labels, defaults, bound).
- `app/studio/src/main_window.cpp`: Settings > Clips > REEL LENGTH (shortest and longest per type, Reset to defaults, red
  line and a refused Save when shortest > longest, in the dirty check so Save changes / Discard asks); probe action
  `settings-reel:<type>:<min>:<max>`.

## Tests (each run alone, `UJWALAM_HEADLESS=1`)

| File | Result | Covers |
|---|---|---|
| `tests/py/test_reel_length.py` | 18 pass | defaults are data and equal the old minimums; validation (min > max, above 60, below 5, negative, unknown type, non-numbers); settings read, bad value ignored; split only at piece boundaries (pieces whole, in order, kills conserved); every part at most the setting for 20/30/45 s; short last part borrows; unreachable minimum kept and marked; one piece over the maximum trimmed around its peak (window clamped to the piece end, middle piece centred), no peak = middle, trim recorded in its part; part ids; planner keeps a long streak and splits it, honours the montage setting at 60 and 30; match reel of 30 kills split with the result screen last; part file names match `NAME_RE`; render rows name each part; live clip over the maximum cut around the medal |
| `tests/user-settings-reel-length.test.mjs` | 6 pass | server-side checks, per-type merge, default not stored, bad stored value ignored, page info |
| `tests/posting-uploads.test.mjs` | 10 pass | new case: three part files packaged as three separate Shorts (60 s, 33.5 s, 59.9 s), none packaged twice |
| `tests/studio-qt-shell.test.mjs` (pattern "Settings", 14 pass; the whole file exceeds 10 min and was not run in one go) | new case pass | rows with defaults (montage 20/60, limit 60), Save writes only the changed type, shortest > longest shows the line and nothing is saved |

Unchanged and still passing: `test_clip_montage` (20), `test_reel_own_kills_impact_play` (22), `test_match_reel_rules` (22),
`test_clip_output_layout` (15), `test_live_chain` (16), `test_clip_live_montage` (6), `test_clip_pipeline` (37),
`test_clip_e2e` (7), `test_clip_settings` (4), `test_live_worker` (8, 2 skipped), `user-settings-match-gate` (4),
`user-settings-theme` (4), `studio-ui-stream-settings` (16). The commit hook ran the quick CI each time (9/9).

## Placeholders, mocks, risks

- Peaks: montages and match reels use the kill times; a trim is centred on the first kill
  inside the piece. After a trim the kills of the piece are recounted from the kill times inside the kept interval (part counts, file names and match-reel scores follow); `trimmed` records `killsDropped`, and `killsEstimated` when no kill time was known (count scaled by the kept share).
- Whole seconds only: the server (user-settings.mjs) and reel_length.py refuse fractional lengths; Qt shows integers.
- The renderer adds no time (hard concat, fades inside pieces; no xfade, pad, hold). The fps filter may round a piece by up to a frame, so `render_argv(max_sec=)` also cuts the output at the type's maximum. Tested on the planned durations and ffmpeg arguments (`RendererAddsNothingTests`); no ffprobe run.
- Parts of one reel are cut from the reel's own order (montages: best streak first), so part 2 of a montage is not later in
  time than part 1.
- No control-page Clips settings exist, so no control-page equivalent was built.

## UNVERIFIED

- A real recording rendered with ffmpeg into parts (the ffmpeg render path is unchanged and runs once per part; not run on
  a long real session here).
- The REEL LENGTH group at real DPI on the user's screen and with every theme.
- Live clip maximum on a real stream.
