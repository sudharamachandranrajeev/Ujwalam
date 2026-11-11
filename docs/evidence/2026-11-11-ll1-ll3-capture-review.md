# 2026-11-11 LL1 live evidence capture and LL3 review of low-confidence reads (D340)

Branch `ll/capture-review` (from `claude/alpha0-d1` at ee06e6a, which holds LL2). Spec:
`docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` section B, LL1 and LL3 (approved, D324). Built on
LL2's store (`services/learning/store.mjs`, D338): same session folders, same 5 GB cap, no second store. Decision: D340.

Result: PASS on tests and fixture runs (temp folders, synthetic rows, placeholder texts, no OCR model on a real frame,
no network, no devices, no windows). Not yet run on a real stream or a real recording: **UNVERIFIED in real use**.

## What changed

- `services/clip/learning_capture.py` (new): `LiveCapture` (live worker side: bounded queue, writer thread, never
  raises), `SessionWriter` (appends under the session's share of the cap), `review_reads()` (the LL3 rules),
  `queue_unknown_modes()` (live-review side). Files per session: `evidence.jsonl`, `review.jsonl`, `frames/<id>.jpg`,
  `session.json`.
- `services/clip/live_worker.py`: `Worker.start_capture()` (session `live-<stamp>`), `tick()` hands each frame to
  the capture; closed when the launcher goes. `--once` checks and tests run without capture.
- `services/clip/detector_pass.py` `FrameScanner`: keeps `boxes` (last OCR boxes) and `fresh` (OCR ran on this frame).
- `services/clip/clipper.py` `_live_matches()`: after the match gate's matches, `_queue_unknown_modes()` queues the
  matches with an end screen and no game mode, with one ffmpeg frame at the end screen (post-stream).
- `services/learning/store.mjs`: action `confirmed`, source `review`.
- `services/learning/review.mjs` (new): list, frame, confirm.
- `services/studio-ui/server.mjs`: `GET /ui/api/learning/review`, `GET /ui/api/learning/frame`,
  `POST /ui/api/learning/confirm`; 404 `learning-review-off` while the flag is off.
- `app/studio/src/main_window.cpp|h`: **Review reads (N)** button beside My clips (flag on and items queued) and the
  Review reads window; probe fields `shown.review`, `review { items, choices }`; probe actions `review-open`,
  `review-confirm:<n>`.
- `data/flags.json`: `learning-review`, off by default.

## Done-when checks

| Item | Status | Evidence |
|---|---|---|
| LL1: on a loopback or fixture run, the store is written | PASS (fixture run) | `tests/learning-review.test.mjs` "LL1 fixture run": the real Python writer (`LiveCapture`, as the live worker calls it) over 30 frames -> `evidence.jsonl` 30 rows, 2 review items with frames, stats `{evidence: 30, items: 2, dropped: 0}`; `tests/py/test_learning_capture.py` "evidence and review items are written" (unchanged frames add nothing, one item per appearance, frames only for items) |
| LL1: the cap still holds | PASS | same fixture run: `enforceCap()` over the Python-written session plus two older ones removes the oldest first and never the live one; `test_the_session_never_passes_the_cap` (the writer refuses writes past the session's share; budget 2000 B, never exceeded) |
| LL1: writing never slows or breaks the clipper | PASS | `test_a_busy_writer_drops_items_and_never_blocks` (40 frames < 1 s with a writer stuck; drops logged), `test_a_failed_write_drops_the_item_and_logs`, `test_bad_input_never_raises`, `test_a_store_that_cannot_open_turns_capture_off`, `test_tick_feeds_the_capture` |
| LL1: no extra model or GPU work while live | PASS (by construction) | the capture uses the hit rows and OCR boxes the scanner already made; JPEG encode (OpenCV, CPU) only for review items; no import of onnxruntime or any model |
| LL3: low-confidence reads are queued (thresholds from data) | PASS | `test_unclassified_banner_and_ocr_low`, `test_thresholds_come_from_the_pack_only` (CODM `ocr.minConfidence` is null: no ocr-low items), `test_live_review_queues_matches_without_a_mode` (live-review, no duplicate on a re-run), `test_mode_choices_are_the_packs_modes` |
| LL3: the review page lists the queued items | PASS | `tests/learning-review.test.mjs` "lists queued items ..." and server "flag on: list, frame, confirm ..."; `tests/studio-qt-learning-review.test.mjs` "flag on: the button shows, the window lists both items ..." (headless Qt probe) |
| LL3: a confirm writes a label | PASS | same tests: one row `{action: confirmed, source: review, ref: {item, kind, detector, label, value, corrected}}` in `labels.jsonl`; the item leaves the list |
| LL3: behind flag `learning-review`, off by default | PASS | server "flag off (the default): every route answers 404 ..."; Qt "flag off: no Review reads button ..."; `tests/flags.test.mjs` (every default off) |
| LL5: frames and OCR text stay local | PASS | written only under `<dataDir>/learning-store/` (gitignored; private scan refuses the path, D338 tests); review list omits OCR texts; fixtures synthetic |

## Commands and results (2026-11-11, one suite at a time)

```
python -I -m unittest discover -s tests/py -t tests/py -p test_learning_capture.py           Ran 16  OK
.venv python (numpy, OpenCV) same file                                                        Ran 16  OK
python -I -m unittest ... -p test_live_worker.py                                             Ran 8   OK (skipped=2, no numpy)
.venv python ... -p test_live_worker.py                                                      Ran 8   OK
python -I -m unittest ... -p test_clip_live_review_gate.py                                   Ran 6   OK
python -I -m unittest ... -p test_clip_detector_pass.py                                      Ran 37  OK (skipped=1)
.venv python ... -p test_g1_detector_pass.py (real OCR on generated frames, FrameScanner)    Ran 1   OK
node --test --test-timeout=60000 tests/learning-review.test.mjs                              tests 7  pass 7  fail 0
node --test --test-timeout=60000 tests/studio-qt-learning-review.test.mjs                    tests 2  pass 2  fail 0
node --test --test-timeout=60000 tests/learning-signals.test.mjs                             tests 10 pass 10 fail 0
node --test --test-timeout=60000 tests/flags.test.mjs                                        tests 7  pass 7  fail 0
node --test --test-timeout=60000 tests/studio-ui-flags-feedback.test.mjs                     tests 16 pass 16 fail 0
node --test --test-timeout=60000 tests/studio-ui-server.test.mjs                             tests 40 pass 40 fail 0
node --test --test-timeout=60000 tests/guide.test.mjs                                        tests 14 pass 14 fail 0
node --test --test-timeout=60000 tests/data-reload.test.mjs                                  tests 13 pass 13 fail 0
node --test --test-timeout=60000 --test-name-pattern="defaults: every flag|flags on: structure" tests/studio-qt-shell.test.mjs   tests 2 pass 2 fail 0
node app/studio/tools/build.mjs                                                              built ujwalam-studio.exe
node tools/lint.mjs <changed files>                                                          0 finding(s)
pre-commit quick checks (build, lint, build-host, build-studio, validators, private-scan, legacy-verify)   9/9 PASS
```

Full CI and the soak were not run (other agents test in parallel; the brief excluded them). The whole
`studio-qt-shell.test.mjs` (70 headless probes) did not finish inside a 590 s run limit; its two tests that compare
the probe's `shown` object exactly failed on the new `review` key and were updated (`review: false`), then passed. The
other 68 do not read `shown` (checked with a search) and were not run to the end: UNVERIFIED in this branch.

## Judgement calls

- **"Unknown match mode"** is the game mode of a match (match_gate `gameMode` null), queued after the stream by
  live-review, not the HUD family (mp/br): the scanner keeps the last known HUD family, so "unknown" there only
  happens before the first cue. Only matches with an end screen are queued (a match without one has no mode screen).
  Only live-review with `--recording` and the match gate on produces them (that is where the matches are computed).
- **OCR below threshold** uses `game.json` `ocr.minConfidence`, the only OCR-confidence threshold in the data files.
  It is null for CODM, so this kind is inactive until the user sets it. `nameMin` (detector-pass.json) is a
  name-match threshold, not an OCR confidence, and was not used.
- **Only signalled rows** are looked at for review: a low-score read that the rules already discard changes nothing.
- **One item per appearance**, not per frame; frames only for review items (as the spec says).
- **Queue size 8, drop on full**: an implementation limit, not a detector value. At 1 sample per second the writer
  never falls behind; a burst (the fixture run without pacing) drops items and logs it, by design.
- **Session share of the cap**: the writer refuses writes that would make its own session pass 5 GB, because the cap
  pass never removes the newest session; older sessions are still removed by the launcher's cap pass.
- **Review in the Qt studio**: My clips is a Qt top-bar button (opens the folder); the web control page has no clips
  view, so the review is a button beside it plus a non-modal window, like Posts.
- **No dismiss button**: an item not answered just stays (the list hides answered ones). Not asked for; keeps the
  review optional without another label kind.

## UNVERIFIED

- Capture on a real live stream (frame rate, evidence size per hour, JPEG size of a real 1080p frame).
- unknown-mode frames from a real recording (ffmpeg seek at the end screen).
- The Review reads window's look on the real display (headless probe only; no picture taken).
