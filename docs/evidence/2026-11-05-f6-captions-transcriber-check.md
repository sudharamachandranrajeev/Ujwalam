# F6 captions transcriber: verified installed and working (2026-11-05)

Picked this up from the "waiting on the user" list in
`docs/plan/2026-11-03-handover.md` ("captions transcriber install").
Turned out to already be done (by an earlier session, never checked off)
— verified it end to end rather than assuming.

## What was checked
- `faster-whisper` 1.2.1 is importable in the project's `.venv`
  (`.venv/Scripts/python.exe -c "import faster_whisper"` → succeeds).
- The local model it needs is already downloaded at
  `C:\AI\Claude\_data\Ujwalam\models\faster-whisper-small\` (`model.bin`,
  483 MB, plus `config.json`, `tokenizer.json`, `vocabulary.txt`) — matches
  what `docs/evidence/2026-11-03-f6-whisper-captions.md` says it should be.
- Ran `clip_captions.transcribe('faster-whisper', wav, {...})` directly
  (not a unit-test mock) against a real 2-second generated WAV file, with
  `whisper_model` pointed at that local directory, `local_files_only=True`
  (no network access, matches the existing design note). Result:
  `{'backend': 'faster-whisper', 'status': 'ok', 'segments': 0}` — `ok`
  status, zero segments is correct (the test tone was a 440 Hz sine wave,
  no speech to transcribe; a crash or `unavailable` status would have been
  the real failure signature, and there was neither).

## Conclusion
The transcriber backend genuinely works end to end on this machine: import
succeeds, model loads, inference runs, returns a well-formed result. **This
item should come OFF the "waiting on the user" list** — there was nothing
left for the user to install.

## Still open (unchanged, not touched by this check)
- Caption quality on **real speech** is still UNVERIFIED (per
  `docs/evidence/2026-11-03-f6-whisper-captions.md`) — this check used a
  tone, not speech, deliberately (no real recording available here to test
  against, and generating fake "speech" audio would prove nothing about
  real transcription quality). That still needs an actual recorded stream
  segment to validate against.
- `data/clip/ranking.json` weights are still `status: proposed`, not
  approved — a judgment call on priority weighting, not a technical gap.
- `game-facecam` clip layout rectangle is still a placeholder — needs the
  user to mark the real facecam region from an actual rendered frame of
  their scene, not something derivable from code alone.
- FIFINE mic `spikeLevel` scale (0.12) still needs a live check against the
  physical microphone — hardware-in-the-loop, not a remote/build task.
