# Caption seam on synthetic speech (2026-11-09)

Result: **PASS** (caption path on synthetic speech). Caption quality on real stream speech stays **UNVERIFIED**.
Decision: D312 (fixture generated at test time).

Handover item: "caption seam on a fixture wav" (`docs/plan/2026-11-03-handover.md`, Session 2026-11-09 afternoon).

## What the gap was

- Captions run only in the post-stream clipper: `services/clip/clipper.py render --captions faster-whisper`
  extracts the clip audio (`clip_captions.extract_wav`), transcribes it (`clip_captions.transcribe`, faster-whisper
  1.2.1 + `small`, CPU int8, D176) and writes `captions.ass`, which the render burns in. There is no live-caption or
  live-AI-sidecar caption code in `services/` or `app/host` (searched for `caption` and `whisper`).
- Before this change the tests covered only the pieces around the transcriber: the ASS writer, the whisper.cpp JSON
  parser, the `unavailable` paths, and the burn-in filter on a hand-written ASS (`tests/py/test_clip_pipeline.py`).
  The E2E (`tests/py/test_clip_e2e.py`) checks the captions seam only as `off`. The 2026-11-05 transcriber check fed a
  440 Hz tone (0 segments). Nothing fed speech through the real path, so a speech check needed a real mic or
  recording.
- The studio's clip jobs (`services/studio-ui/record-clips.mjs`) never pass `--captions`, so the shipped app runs
  with captions off.

## The seam

- **Fixture, generated at test time (D312).** The wav is never committed, because the repo is public and the audio
  is Microsoft-voice output.
  - `tests/fixtures/captions/make-fixture.ps1` uses the Windows built-in synthesizer (System.Speech, voice
    "Microsoft David Desktop", no install) to write 16 kHz mono 16-bit PCM.
  - It speaks the recipe in `tests/fixtures/captions/speech-en.json`: "Clip it. That was a clean triple kill on the
    last round." There is no recorded voice and no private content.
  - The test runs the generator through `clip_common.run_tool`: hidden (`CREATE_NO_WINDOW`), BelowNormal priority,
    `powershell.exe -NoProfile -NonInteractive`.
  - The output is cached in `out/caption-seam/speech-en-<hash>.wav`, which is gitignored. The hash covers the recipe
    and the generator script.
  - Synthesis can differ between Windows builds, so the tests check the transcript and the timing, not bytes.
  - If System.Speech or the voice is missing, the generator exits 3 and every test that needs the wav is skipped with
    the reason. On this laptop the wav is 148,526 bytes (4.64 s).
- **Model lookup** (`model_dir()` in the test):
  1. `UJWALAM_WHISPER_MODEL`.
  2. Otherwise, `models/faster-whisper-small` beside the clipper's own data dir. That data dir is
     `clip_common.resolve_data_dir()`, the `paths.event_core_data` folder of `data/profile.local.json`.
  3. Otherwise, skip.

  The clipper itself has no default model path: it takes only `--whisper-model`, and `record-clips.mjs` passes no
  captions options. So "the path the clipper resolves" is its data-dir resolution. On this laptop the existing model
  folder sits beside that data dir, so full CI runs the whisper part with no extra setup. `ModelLookupTests` covers
  the lookup order on temporary folders.
- **Test:** `tests/py/test_caption_seam.py`.
  - `FixtureTests` checks the generated wav's format and that its length fits the recording.
  - `WhisperSeamTests` generates a 20 s recording (testsrc2 video; AAC 48 kHz stereo audio with the speech starting
    at 6.0 s and silence elsewhere) and a hotkey marker. It then runs the real clipper in the project venv
    (`.venv-gpu`, then `.venv`, the same order as `record-clips.mjs`): `candidates`, then
    `render --layouts full-crop --encoder libopenh264 --captions faster-whisper --whisper-model <model> --language en`.
    It checks the following:
    - `render.json` captions status is `ok`.
    - Every key word is in the ASS Dialogue text.
    - The first caption starts within 1.0 s of the real speech start.
    - The last caption ends no later than the speech end plus 1.0 s.
    - The style margins equal the safe-zone intersection.
    - The video is 1080x1920 and has audio.
    - A direct `transcribe()` of the wav contains every key word, its word count is within 2 of the recipe, and its
      segment edges are within the wav.
- **Test-only:** no product entry point was added. The test drives the clipper's existing command line from a test file.
  The shipped launcher and the studio never reach it.

## Bug the seam found (fixed)

The first run (fixture then committed, model from `UJWALAM_WHISPER_MODEL`) failed:

```
FAIL: test_ass_has_the_words_at_the_right_time
AssertionError: 0.0 != 6.0 within 1.0 delta (6.0 difference)
```

faster-whisper without VAD stamped the segment after 6 s of leading silence from 0.0 s. The caption would have
shown about 6 s before the words. The same delayed wav through `WhisperModel.transcribe(language='en', ...)` gave:

```
{}                        0.0  10.0  Clip it. That was a clean triple kill on the last round.
{'vad_filter': True}      5.81  9.81  Clip it. That was a clean triple kill on the last round.
{'word_timestamps': True} 5.88  9.7   Clip it. That was a clean triple kill on the last round.
```

Fix: `services/clip/clip_captions.py` now calls `transcribe(..., vad_filter=True)`. Silero VAD ships inside
faster-whisper (from the hashed lock `services/clip/requirements-whisper.lock.txt`). It runs on the CPU through
onnxruntime, so there is no install and no network.

## Commands and output

The seam test, with no environment variable set (the model was found beside the data dir). The first run is cold and
generates the wav; the second uses the cached wav. Both ran at BelowNormal priority:

```
python -I -m unittest discover -s tests/py -t tests/py -p test_caption_seam.py -v
test_generated_wav_format ... ok
test_env_then_data_dir_sibling ... ok
test_ass_has_the_words_at_the_right_time ... ok
test_direct_transcription_has_the_words ... ok
test_render_reports_captions_ok ... ok
test_rendered_video_with_captions ... ok
Ran 6 tests in 16.995s   OK     (cold: wav generated)
Ran 6 tests in 18.429s   OK     (cached wav)
```

The full Python suite, as CI runs it (BelowNormal priority):

```
npm run test:py
Ran 389 tests in 72.107s
OK (skipped=49)
```

The caption seam's six tests all ran and passed inside it. Time added to `test:py`: about 17-19 s. The time is spent
on the venv probe, a 20 s recording, faster-whisper twice on the CPU, and one 1080x1920 libopenh264 render.

The clip and caption suites, then quick CI:

```
python -I -m unittest discover -s tests/py -t tests/py -p "test_c*.py"
Ran 184 tests in 48.781s
OK (skipped=1)

node tools/ci.mjs --quick
ci: 9/9 passed in 26.7s
```

## Not checked / UNVERIFIED

- Caption quality on real stream speech (Malayalam, Manglish, game noise, music). The fixture is clean synthetic
  English.
- The skip path when System.Speech is missing: it was not exercised, because this laptop has System.Speech. The code
  path is exit 3, then a skip with the reason.
- Other Windows builds or voices: synthesis may differ, and the assertions allow for that (key words, word count
  within 2, timing within 1.0 s). Only this laptop was tested.
- How VAD affects real stream audio with constant game noise: VAD may drop quiet speech under loud game sound.
  UNVERIFIED.
- The `whisper-cli` backend: still no binary on the laptop (unchanged).
