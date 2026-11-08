# 2026-11-08 Stinger transitions (P5b, D242)

Status: tests pass (native host with a recorded canvas, project schema and validation, Meld import, UI server route); flag `transitions` off by default; not yet used on a real stream.

## Checks

- `node --test app/host/tests/host-stinger.test.mjs`: 2/2 (built host, headless, ffmpeg makes a 1 s red VP8/Opus WebM).
  - `transitions.set` type `stinger` with `file` (pathRef under a load base) and `pointMs` is reported back (`file: "media:sting.webm"`, `pointMs: 500`).
  - Refusals leave the transition as it was: missing file (-32004), a path leaving the base (-32602), a non-video extension (-32602), no file (-32602), a base not given at load (-32004).
  - Recorded H canvas (NVENC 640x360 30 fps): starts white, one red run of 29 frames (the 1 s stinger), ends black. Output: `stinger: 81 frames, red runs [29]`.
- `node --test app/host/tests/host-transitions.test.mjs app/host/tests/host-structure.test.mjs`: pass (cut/fade and structure unchanged).
- `node --test tests/project-import-meld.test.mjs`: an enabled Meld stinger with a local video imports as `stinger` with its mid point (rounded ms) under the media base; a remote URL stays a fade with a warning; a stinger on another drive than the layers' media stays a fade with a warning; the track matte is reported as not imported (the audio switch is imported since D244). Schema and validator refuse `pointMs` on a non-stinger and a stinger without `file`.
- `node --test tests/studio-ui-transitions.test.mjs`: the transition form saves a canvas's transition (only videos in the stream assets folder; refused while live); the status poll applies it; a stinger the host refuses is remembered and that canvas cuts without retrying.
- Project, studio-ui and flags suites: 256/256. `npm run lint`: 0 findings.

## Design

- Host: `obs_stinger_transition` (`path`, `tp_type` 0 = time, `transition_point`, monitoring off, no audio fade), swapped onto the canvas's channel 0 with `obs_transition_swap_begin/end`; leaving stinger releases it. The file is resolved with the last load's bases (`model::resolve_path_ref`).
- Schema: transition `{type: stinger, durationMs, file, pointMs}`; `file`/`pointMs` only for a stinger.

## Limits

- Track matte stingers are not supported.
- Correction (same day, D244): an earlier version of this file said stinger audio is not routed to the stream. That was wrong: a probe recording measured the stinger's tone in the canvas mix (loudest 100 ms -24.1 dBFS). Monitoring off only keeps it off the local monitor. The audio switch is D244.
- On an imported Meld project a stinger chosen from the stream assets folder resolves under the Meld media base and may be refused; that canvas then cuts.
