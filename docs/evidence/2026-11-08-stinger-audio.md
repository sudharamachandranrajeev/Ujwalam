# 2026-11-08 Stinger audio switch (P5b, D244)

Status: tests pass (native host with recorded audio, schema/validator, Meld import, UI server route); flag `transitions` off by default; not yet used on a real stream.

## Finding

The D242 evidence said stinger audio stays off the stream. A probe recording (1 kHz tone in the stinger, H canvas recorded) showed the tone in the recorded mix at about -24 dBFS for the stinger's 1 s. OBS mixes a transition's own audio into the canvas output; `audio_monitoring 0` only keeps it off the local monitor. Meld has a per-stinger audio switch (`audioEnabled`), which the user's session had off, so an imported stinger would have played sound the user had turned off.

## Checks

- `node --test app/host/tests/host-stinger.test.mjs`: 3/3. New: `transitions.set ... audio:false` mutes the stinger source; recordings: `stinger audio: loudest on -24.1 dBFS, off -Infinity dBFS`. `transitions.get` reports `audio`.
- `node --test tests/project-import-meld.test.mjs`: Meld `audioEnabled: false` imports as `audio: false`; `audio` on a non-stinger is refused by schema and validator.
- `node --test tests/studio-ui-transitions.test.mjs`: 2/2. The form's "Stinger sound" switch saves `audio: false`; the status poll applies it; `audio` with a non-stinger type is 400; sound on by default.
- Project, studio-ui and flags suites pass. `npm run lint`: 0 findings.

## Design

- Project transition `audio` (boolean, stinger only, absent = true). Host: `obs_source_set_muted` on the stinger transition source; the video still plays.

## Limits

- Stinger sound volume is not adjustable (on or off only).
