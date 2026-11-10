# 2026-11-10 Task panel: top-right button, full task rows, stall warning

Branch `ui/task-panel`. User feedback 2026-11-10: the task strip was barely visible and always shown, the
notifications belonged at the top right, and a clip job showed only an animation with no time left for 38 minutes
(a real hang, fixed separately in `clip_common.py`, abc3007). Nothing showed that the job had stopped making progress.

## What changed

- **Button**: the task button is now in the top bar at the right, before My clips. It shows "1 task running",
  "2 tasks running - 1 may be stuck" (red outline), or a quiet "Tasks" when only finished tasks are listed. It is
  hidden when no task is listed.
- **Panel**: collapsed until clicked. It is 440 px wide and opens under the top bar at the right edge. It scrolls
  when it would be taller than the window and folds away when nothing is left.
- **Each row shows in full (wrapped, never cut)**:
  - the title and its state (Running / Waiting / Done / Failed / May be stuck)
  - "Step 1 of 5: Reading the game screen"
  - "412 of 3148 frames (13%)" and the bar
  - "Elapsed 7:02 · About 46 min left in this step", or "Estimating time left..." until a rate is measured, or
    "Time left unknown" when the amount of work is unknown (never a guessed number)
  - "Last progress 2 s ago", or "No progress yet (started 5 min ago)"
  - the job's own note
  - "No progress for 5 min - it may be stuck"
  - a **Stop** button. It uses the existing `ui/api/tasks/stop` route, asks first on a real click, and stops all
    background jobs (clip making, uploads).
- **Notifications**: at the top right under the top bar, stacked downward, and to the left of the panel when it is
  open. The title is 11 pt and bold, in the theme's text colour on the panel colour, with a 2 px accent edge (danger
  for a failure). They say "Started:", "Done:", "Failed:", and "May be stuck:" (once per stall). They stay 6 s, and a
  click opens the panel.
- **Data** (`services/studio-ui/tasks.mjs`):
  - Tasks may carry `stages`, `stageText`, `unit`, `activeAt`, `progressAt` and `measured`.
  - `list()` adds `silentMs`, `stalled`, `stallAfterMs` and `step`.
  - Silence is measured from the last progress line, or else from when the job began working (the user's case).
- **Stall threshold**: `stallAfterMs` = 180000 (3 min, proposed), in the new file `data/studio/tasks.json`, with a
  `$comment` and `source`. It is added to the package manifest. No existing data file fitted the task panel. A
  missing or wrong file turns the warning off.
- **Clip jobs** (`record-clips.mjs`): the stages of each job type, plain words per stage, and `activeAt` /
  `progressAt` from the stderr progress lines. Before the first progress line the stage reads "Starting".
- **No false stall for silent stages**: `clipper.py` now writes a progress line when `publish` and `montage` start
  (new stages in `clip_common.PROGRESS_STAGES`). Those stages are `measured: false`, so their silence never counts as
  stuck, and their bar shows "amount unknown". `validate`, `render` and `detect` already write lines while they work.
- **Uploads** (`auto-chain.mjs`): stage "Uploading to YouTube", counted in MB; each chunk counts as progress.
- **Guide**: the `taskBar` anchor is now the top bar; the hint and tour texts say "top right".
- **Tray and close question**: they read the same time text, which now says "estimating time left" and adds
  "no progress for N min" when stalled.

## Commands and results

| Command | Result |
|---|---|
| `node --test --test-reporter=tap tests/studio-tasks.test.mjs tests/record-clips.test.mjs tests/posting-auto-chain.test.mjs tests/posting-e2e.test.mjs tests/guide.test.mjs` | tests 86, pass 86, fail 0 (rerun after the last changes: 86/86) |
| `python -I -m unittest discover -s tests/py -t tests/py -p "test_clip_match_gate.py"` | Ran 37 tests, OK |
| `node app/studio/tools/build.mjs` | built: `[33/34] Linking CXX executable ujwalam-studio.exe`, no errors |
| `UJWALAM_HEADLESS=1 node --test --test-reporter=tap tests/studio-qt-shell.test.mjs tests/studio-tray.test.mjs` | tests 63, pass 63, fail 0 (after the fix below) |
| `node tools/ci.mjs --quick` | ci: 9/9 passed in 57.6s |

First shell run: 61 of 63 passed. Two new tests had wrong expectations:
- The waiting row also shows its elapsed time.
- With the window shown, a preview "Done" notification came after the "May be stuck" one.

The tests now read a probe log of the last 10 notification titles; the rerun passed 63/63.

## What the tests prove (headless, offscreen platform)

- The button is in the top bar. The panel's right edge is 14 px from the window edge, its top is under the top bar,
  and it is at least 400 px wide.
- A clip job that has written no progress line for 5 min shows "Step 1 of 5: Starting", "No progress yet (started
  5 min ago)" and "No progress for 5 min - it may be stuck", with a Stop button. The button reads
  "2 tasks running - 1 may be stuck".
- A job with progress shows "412 of 3148 frames (13%)", "Last progress N s ago", and a measured time left or
  "Estimating".
- A "May be stuck" notification appears at the right edge under the top bar. A click on it opens the panel.
  `tasks:stop` writes `clips/stop-tasks.json`.
- The panel stays collapsed until clicked. With only finished tasks, the button is a quiet "Tasks".
- A 20-minute montage (no progress lines) is not called stuck. A job silent for 10 minutes without any progress line
  is.

## UNVERIFIED

- How it looks on a real screen: readability and contrast of the notifications and the panel in both themes, the
  animations, the top bar at small window widths. Only the offscreen platform was used; no screenshot was reviewed.
- The 3 min threshold on real clip runs. Any single step that writes no line for more than 3 min (one very long clip
  render, the candidates step on a long recording) would still warn.
- The time left on a real 50-minute recording (rate from the detector pass at about 1 frame/s).
