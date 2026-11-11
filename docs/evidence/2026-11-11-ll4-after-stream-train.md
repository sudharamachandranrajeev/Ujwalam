# 2026-11-11 LL4 after-stream game pack check (D342)

Branch `ll/after-stream-train` (from `claude/alpha0-d1` at 4ae8c60, which holds LL1, LL2 and LL3). Spec:
`docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` section B, row LL4 (approved, D324). Decision: D342.

Result: PASS on tests and a fixture run (temp folders, synthetic label stores, placeholder texts, no images, no model,
no network, no devices, no windows). No real labels exist yet, so it has not proposed anything from a real stream:
**UNVERIFIED in real use**.

## What changed

- `services/clip/pack_tune.py` (new, stdlib only): `propose` (read the learning store, tune, score on held-out
  sessions, write a candidate when it wins), `list`, `approve --candidate <id>`. Every command needs the flag
  `learning-train` (exit 3 when off); `propose` also refuses while the live clipper is asked to watch.
- `services/studio-ui/record-clips.mjs`: job type `train` (spec, stage `train`, task title and note via
  `trainNote()`); queued last when a stream's (`kind: live`) clip job ends and `trainFlag()` is on; restored at the next
  start like the other jobs.
- `services/studio-ui/launch.mjs`: passes `trainFlag` (the `learning-train` flag) to the clip queue.
- `data/flags.json`: `learning-train`, off by default.
- `tests/py/test_pack_tune.py` (new, 14 tests), `tests/record-clips.test.mjs` (+2 tests).
- No pack file changed in this branch (the pack stays 0.8.0).

## How it decides

Inputs per store session: `review.jsonl` items, the user's `confirmed` answers in `labels.jsonl`, and the W1 rows of
`evidence.jsonl`.

| Pack value | Labels | Tuning | Held-out score |
|---|---|---|---|
| detectors.json W1 `banner.kinds` y0/y1 | `unclassified-banner` answers: round, match or not a banner; y = centre of the item's OCR box whose text is the read word | widen a kind's range to the training reads of that kind, rounded outward to 0.001; skipped when a read answered otherwise lies inside; no overlap | accuracy of the kind each held-out read gets ("not a banner" = none); and 0 held-out evidence banners the current pack placed may change kind |
| game.json `ocr.minConfidence` | `ocr-low` answers: kept read = right; `wrong read` or a typed correction = wrong | the lower threshold (candidate cut points of the training scores) with the best training accuracy; never raised | accuracy of "right iff score >= threshold" |

Split by session: per value, the newest 2 sessions (by `session.json` start) that hold labels for it are held out, the
older ones train. Offered only when held-out accuracy is strictly higher than the current pack's. Minimums (agent
settings, proposed): 3 sessions with labels for the value, 10 training and 6 held-out labels; below that nothing is
proposed and the report says why. Kept / deleted / posted / renamed clip rows, feedback rows and `unknown-mode`
answers are counted in `labelCounts` but give no pack value (no row links them to a read).

`ocr.minConfidence` is null in the CODM pack, so the review queues no `ocr-low` read and the check reports "the value
is not set"; nothing is invented.

Output: `data/games/<id>/local/candidates/<YYYYMMDD-HHMMSS>-<version>.json` (gitignored): `status: unverified`,
`state: proposed`, base version and the version it proposes (patch + 1), base hashes of `game.json` and
`detectors.json`, the changes, the per-value score and evidence (label and session counts, dates) and a changelog
draft. `last-run.json` holds the newest run report. `approve` writes the values, the version and the changelog entry;
refuses a candidate whose base files or version changed, or one already approved.

## Done-when checks

| Check | Result | Evidence |
|---|---|---|
| A proposal is produced only when it beats the current pack on held-out sessions | PASS | `Banner.test_proposal_only_when_it_beats_the_current_pack_held_out` (3 train + 2 held-out sessions; held-out 0.2 -> 1.0); `Banner.test_no_proposal_when_held_out_disagrees` and `Ocr.test_no_threshold_when_held_out_disagrees` (held-out answers disagree: status `not-better`, no candidate file); `Ocr.test_lower_threshold_proposed_when_it_beats_held_out` (0.5 -> 1.0) |
| No proposal with insufficient data | PASS | `Insufficient.*`: empty store, 2 sessions only ("3 or more are needed"), enough sessions but 6/4 labels ("at least 10 and 6"), `ocr.minConfidence` null ("not set") |
| The flag defaults off | PASS | `FlagAndGuards.test_flag_off_by_default_runs_nothing` (definition `default: false`; propose, list and approve exit 3, nothing written); record-clips test: flag off, a stream's clip job queues no check |
| Nothing runs while a stream is live | PASS | record-clips LL4 test: the check is stopped when a stream starts, nothing starts while live, it runs again after; `FlagAndGuards.test_refuses_while_a_stream_is_watched`; no model or GPU module in pack_tune.py (`test_no_model_or_gpu_module_is_imported`) |
| A proposal never applies itself; approval behind the flag | PASS | the beats test checks game.json, detectors.json and CHANGELOG.md are byte-identical to the repo pack after `propose`; `test_approve_writes_...` (0.8.1, round y0 0.3, note, changelog entry above 0.8.0, weights/windows/patterns and events.json unchanged; a second approve refused); `test_stale_candidate_is_refused` |
| No new event names or weights | PASS | approve test compares every detector's id, weight, window and patterns and events.json with the repo pack |

## Commands and output

```
python -I -m unittest discover -s tests/py -t tests/py -p "test_pack_tune.py" -v
Ran 14 tests in 0.694s
OK

node --test --test-timeout=60000 tests/record-clips.test.mjs
ℹ tests 21  ℹ pass 21  ℹ fail 0

node --test --test-timeout=60000 tests/flags.test.mjs                  ℹ tests 7   ℹ pass 7
node --test --test-timeout=60000 tests/studio-ui-flags-feedback.test.mjs  ℹ tests 16  ℹ pass 16

node tools/lint.mjs
lint: 0 finding(s), 34 allow marker(s)
```

Fixture run (scratchpad copy of `data/games`, synthetic store of 5 sessions from the test helpers; `propose` then
`approve`), then the repo's own validator on the approved copy:

```
detectors.json W1 banner.kinds: beats, held-out accuracy 0.2 -> 1.0; train 3 sessions / 15 labels
  (2026-11-01..03), held out 2 sessions / 10 labels (2026-11-04, 2026-11-05); held-out evidence banners 4, changed 0
game.json ocr.minConfidence: insufficient (the value is not set)
candidate 20261111-074206-0.8.1 -> approved 0.8.1
node tools/game-validate.mjs <scratch>/games .
OK: 1 game pack(s) valid: codm 0.8.1
```

## Placeholders, limits, UNVERIFIED

- No real stream has produced labels yet; every run so far is synthetic. Real use is UNVERIFIED.
- The minimums (3 sessions, 10/6 labels) are agent settings, not tuned.
- Approval is a command (`python -I services/clip/pack_tune.py --data-dir <data> approve --candidate <id>`), not a studio
  button. It writes into the pack folder of the clip maker's checkout; the user commits the result (a pack change is
  versioned with a changelog, existing rule).
- Review items carry no game id: with one game pack (CODM) every answer belongs to it. A second game would need the
  game id in the item.
- `ocr.minConfidence` gates only the review queue today (no detector reads it), so a lower value means fewer reads
  queued for review, not different clips.
