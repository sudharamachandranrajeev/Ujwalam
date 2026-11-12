# CL2: Battle Royale short re-cut from the recording's kills (2026-11-12)

Result: **PASS** for the code and the re-cut of the reported clip. The data values are **proposed** (D365) until the
user has watched the re-cut. Not yet used on a new stream: **awaiting live test**.

## The report (triage F2)

The user, on the BR short of the 2026-11-11 session (3X MULTI-KILL): "there was 2 kills before that which was not
captured, and the single kill after that captured, then it's boring long footage of streamer just running through the
map."

## Cause, from the session's detector hits

Session recording 2026-11-11 21:10:46 UTC (3242.8 s). The live clip L01 covered recording time 567.2–587.2 s (17 s
before the medal, 3 s after). Hits around it (seconds into the recording):

```
555.0 B2 KNOCKED DOWN True br
560.0 B2 ELIMINATED   True br
561.0 B2 KNOCKED DOWN True br
580.0 B2 KNOCKED DOWN True br
581.0 B2 ELIMINATED   True br
582.0 X1 3X MULTI-KILL True br
```

- The BR kill feed (B1) gave no own kill in the whole session (B1 signal true 3 of 300; the own name is cut off in
  the V cutout). The own HUD text B2 read every knock and kill (21 hits, all BR, all signal true) but was not a kill
  detector for clips.
- The live window starts 17 s before the medal, so 555–561 s were outside it, and 567–580 s (running) was inside.
- The medal's kills spanned 555–582 s (27 s), longer than the 12 s chain gap used for every mode.

## Fix (D365)

- `data/clip/montage.json`: `killDetectors` adds `B2:ELIMINATED` (a `DET:Label` spec), new `actionDetectors`
  `["B2:KNOCKED DOWN"]` (a piece, no kill count), new `chainGapSecByMode` `{"br": 30}`; the `cl2` block records the
  evidence and status `proposed`.
- `services/clip/clip_signals.py`: `read_hits` keeps the hit's `mode`.
- `services/clip/clip_montage.py`: `_events` (kills, actions, medals with mode), `groups` (gap per mode, action-only
  groups dropped), `_pieces(..., actions)`, `groups_in`, `live_clip_pieces` (all pieces of the clip's chains, dead
  time cut, padded to the minimum from the build-up before the first kill, never into a death or outside the save).
- `services/clip/clipper.py`: `_retime_live_clips` in `live-review` after `merge_saves`, when the recording's hits and
  `matches.json` (`recordStartUtc`) exist. A chain seen by two clips goes to the clip whose save file holds most of it;
  the other clip joins it (labels kept). Re-cut clips render through the pieces path; `render.json` rows say
  `retimed`. Without hits, or with no chain in a window, a clip keeps its live window.

## Tests

```
python -m unittest tests.py.test_clip_montage
Ran 27 tests ... OK
python -m unittest discover -s tests/py
Ran 585 tests in 64.616s
OK (skipped=49)
```

New tests: BR knocks and kills chain into one group (kills 560 and 581, actions 555, 561, 580); the BR gap leaves
multiplayer at 12 s; a knock alone makes no kill group; the live re-cut gives 548.0–562.5 and 577.0–582.5 (20.0 s, 2
kills); the re-cut stays inside the save and ends before a death; no chain keeps the live window; in `live-review`
two clips of one chain become one, and the save that holds the whole chain wins.

## Re-cut of the session's live clips (real hits)

The session's saves were deleted after publishing (live clipper intermediates), so the clip windows come from the
run's `render.json` and the save length is taken as 60 s (replaySec).

```
L01 ['3X MULTI-KILL'] 20.0 s: 2 pieces, 2 kills (was one 20 s window with 1 kill and 13 s of running)
L02 joined L03 (one chain; L03's save holds all of it)
L03 25.0 s: 3 pieces, 5 kills
L04 20.0 s: 1 piece, 3 kills
L05 20.0 s: 1 piece, 2 kills
L06 25.5 s: 2 pieces, 5 kills
L07 25.5 s: 2 pieces, 5 kills
L08 20.0 s: 3 pieces, 4 kills
```

L01 re-rendered from the session's V recording (recording time 548.0–562.5 and 577.0–582.5, h264_nvenc, 20.000 s).
A 1 fps contact sheet shows the aim-in, both KNOCKED DOWN banners and both ELIMINATED banners, and no running between
the two pieces. The video and the sheet show the streamer's face and channel names: kept in the session scratchpad
only, not committed.

## Not checked

- A full `live-review` run end to end on a new stream with the re-cut (awaiting live test).
- Other BR sessions: the 30 s gap and the B2 rules come from one session (UNVERIFIED beyond it).
- Non-canvas layouts (full-crop, game-facecam, blurred-fill) render the re-cut clip's whole span from first to last
  piece, dead time included; only the default canvas layout (stream-v) cuts it out.
