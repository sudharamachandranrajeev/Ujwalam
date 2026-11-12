# RP2: story montages and no result screens from other matches (2026-11-12)

Result: **PASS** for the code and a render from the reported session. The structure is the user's (D361); the numbers in
`data/clip/montage.json` `story` are **proposed**. Behind the flag `montage-story`, off by default: **awaiting the
user's check** and a new stream.

## The report (triage F1)

The user, on the 8-kill montage of 2026-11-11: "the clips are good but the final montage doesn't make sense as the
victory screen of multiple games and modes were clubbed".

## Cause

The montage's pieces mapped onto the session's matches (match_gate.segment of the recording):

```
M08  2433-2444 @4 domination   2695-2708 @4 domination   3220-3224 @5 domination   3229-3234 @5 domination
     822-826 @1 br              968-972 @2 hardpoint
matches: 1 br end screen 821 s; 4 domination end screen (VICTORY) 2675 s; 5 domination end screen 3200 s
```

2695–2708, 3220–3234 and 822–826 are after their match's end screen: kill-feed and medal reads on the VICTORY / DEFEAT,
MVP and summary screens counted as kills. The montage then joined those pieces from three modes.

## Fix

- Every montage (flag or not): `clip_montage.drop_end_screens` removes hits from a match's `endScreenAt` to its end;
  every piece stops at its match's end screen (`_units`). `plan_montages(..., matches)`; `cmd_montage` segments the
  matches first.
- Story montages (`plan_story_montages`, flag `montage-story`):
  - Part 1, before the title (`story.titleAt`): 3 cuts of 0.8 s before to 0.6 s after the strongest kills (4.2 s).
    The cuts come from the montage's own kills or kills no montage uses. A moment opens one montage only, and never
    opens on a death.
  - Part 2: one match in time order, dead time cut. Kills of other matches top it up after the story only when it is
    short of the 30 s target.
  - The story match's result screen ends the montage only when the match qualifies (won or top 3), nothing from
    another match follows, and the montage holds the match's last kills. Each result screen plays once.
  - Kill groups inside the stream's live clips (DIR/render.json) are used only when a montage cannot be made without
    them. Each kill group is used in one montage only.
  - The ED1 reorder hook does not run on a story montage (`hook.used: "story"`): part 1 is its opening.

## Tests

```
python -m unittest tests.py.test_clip_montage
Ran 32 tests ... OK
python -m unittest discover -s tests/py
Ran 591 tests in 61.482s
OK (skipped=49)
```

New: hits on an end screen never reach a montage, and a kill's piece stops at the end screen. One match is told in
order after a 3-cut opening and ends on its own result. A short match is topped up after the story and shows no
result. Live-clip kills are left out when possible, no piece is used twice, and no opening moment is used twice. The
flag is off by default.

## The reported session, re-planned (real hits)

Old planner with the end-screen fix: no piece after any end screen. Story planner (live-clip spans avoided):

```
29.2 s  5 kills  match 1 br          result -        top-ups -
41.2 s  8 kills  match 5 domination  result -        top-ups -
40.2 s  7 kills  match 3 hardpoint   result VICTORY  top-ups -
34.2 s  7 kills  match 5 domination  result -        top-ups [2]
...
46.2 s  8 kills  match 4 domination  result VICTORY  top-ups -
13 montages; every result screen once; every opening 4.2 s
```

The 40.2 s match-3 montage was rendered from the session's V recording (h264_nvenc). A contact sheet (one frame per
2 s) shows the opening cuts, then one hardpoint match on one map in order, then that match's VICTORY screen at the end
only. The video and sheet show the streamer's face and channel names, so they stay in the session scratchpad and are
not committed.

## Not checked

- The flag switched on in the app and a full `live-review --montage` run (awaiting the user and a new stream).
- The title card between part 1 and part 2 (RP4, not built; `titleAt` marks the place).
- Whether 13 montages per session is too many to post (auto-posting picks; UNVERIFIED with the user).
