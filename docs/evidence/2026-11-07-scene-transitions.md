# 2026-11-07 Scene transitions (P5b, D239)

Status: tests pass (native host with a recorded canvas, importer, UI server sync); flag `transitions` off by default; not yet used on a real stream.

## Checks

- `node --test app/host/tests/host-transitions.test.mjs`: 2/2.
  - Cut by default on H and V; `transitions.set` per canvas; bad type, duration over 10000 ms and unknown canvas refused (-32602); `host.status.transitions` reports the values.
  - Recorded H canvas, 640x360 at 30 fps: white, fade 1000 ms to black, cut back to white. Luma per frame (ffmpeg signalstats YAVG): 94 frames, one in-between run of 22 frames (the fade), no in-between frames at the cut.
- `node --test tests/project-import-meld.test.mjs`: 23/23. Meld `sceneTransition` (H) and `verticalSceneTransition` (V) become a fade with their duration; an enabled stinger gives a warning (not guessed).
- `node --test tests/studio-ui-transitions.test.mjs`: 1/1. With the flag off the host is kept on cut; with it on, the project values are applied; a project file change is picked up.
- Studio-ui, project, Meld and alpha suites: 248/248. Flags 7/7. `npm run validate:registry` OK. `node tools/lint.mjs`: 0 findings.

## Values

- Alpha project: H fade 2006 ms, V fade 1000 ms (the user's Meld session values; Meld's stinger is disabled there).

## Limits

- Cut and fade only. Stinger (video file + audio routing) is not built yet.
- The fade's 22 measured in-between frames are fewer than 30 because frames close to pure white or black fall outside the 40-200 luma band used to count them.
