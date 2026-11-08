# Task bar, stats cards and motion in the Qt studio (D287)

Date: 2026-11-08. Branch `ui/taskbar` (from `claude/alpha0-d1` @696e01e).

## What was built

- `services/studio-ui/tasks.mjs`: task model `{id, title, kind, state running|done|failed|waiting, done, total (null = unknown), stage, note, startedAt, updatedAt}`. Sources: files `<dataDir>/tasks/<id>.json` (atomic write; dropped after 10 min without update) and in-memory tasks of the UI server. Text fields are cut to fixed lengths; error text never reaches a task.
- UI server (`services/studio-ui/server.mjs`): `GET /ui/api/tasks`; `tasks[]` in the status snapshot (so the SSE `status` event and the Qt poll carry it, no extra poll). Tasks for: Meld import, project load, transition apply, YouTube private upload, settings save, preview open.
- `services/studio-ui/record-clips.mjs`: reads the clipper's stderr (`ujwalam-progress {...}`, parsed defensively by `parseProgress`, paths stripped, lengths capped), still copies stderr to the run log, writes one task file per clip job: waiting ("Waiting until the stream ends" while live, else "Waiting for its turn"; "Paused while the stream runs"), running ("Finding the best moments in <name>", "Editing clips (3 of 7)"), done / failed.
- Qt (`app/studio/src/taskbar.*`, `motion.*`, `stats_cards.*`, `theme.cpp`, `main_window.*`): status-bar chip with thin bar, slide-up task list with per-task bars and an X for finished tasks, toasts (4 s). All are child widgets of the main window: no top-level window, no focus (NoFocus everywhere), no modal dialog, no `QApplication::alert`; toasts are transparent for mouse events except their close button.
- Motion: OutCubic 150-250 ms for panel slide/fade, toast in/out and restack, bar value glide, chip pulse (only while a task runs and the chip is visible), indeterminate sweep (only while visible), hover glow on buttons and mixer cards (a mouse-transparent overlay per widget), Live / Recording chip colour fade. Skipped when Windows "animation effects" are off (`SPI_GETCLIENTAREAANIMATION`), when `UJWALAM_REDUCE_MOTION=1`, or when the widget is not shown. `UJWALAM_REDUCE_MOTION=0` forces motion on.
- Stats cards in the right column: session clock (1 s timer only while live or recording), GPU, CPU, FPS with a history line from the existing 2 s status poll (90 samples). The old stats pill in the status bar is hidden.
- Settings dialog: "Which matches get clips": checkbox "Only make clips from matches where I finish in the top 3" (default on), checkbox "...or where I get at least [N] kills" (off). Sent as `clips.matchGate = {"top3": bool, "minKills": int|null}` through `POST /ui/api/settings`, only when it differs from the defaults or was already stored. A 400 (older server) gives a plain message and the other settings are saved without the key.

## Evidence

Commands run in the worktree:

```
node app/studio/tools/build.mjs                       -> built out/studio/build/ujwalam-studio.exe (no warnings)
node --test --test-concurrency=2 tests/studio-qt-shell.test.mjs
    -> pass 13, fail 0 (3 smoke + 10 probe, incl. 3 new D287 tests and the look test)
node --test --test-concurrency=2 tests/studio-ui-server.test.mjs tests/record-clips.test.mjs tests/studio-ui-alpha.test.mjs tests/studio-tasks.test.mjs
    -> tests 75, pass 75, fail 0 (record-clips 11 incl. 3 new, studio-tasks 4 new)
node tools/lint.mjs                                   -> lint: 0 finding(s)
```

Look shots (headless render of the hidden window, real Windows fonts, 1600x900, the PNG size is asserted by the look test):

- Task list open plus a toast: `final-panel.png` in the session scratchpad (`<scratchpad>\final-panel.png`)
- Chip in the status bar plus a toast: `...\scratchpad\final-toast.png`

Probe output (`tasks`) with two running, one waiting, one failed and one just finished: `{"chipText":"2 tasks running","chipHidden":false,"panelOpen":true,"rows":5,"running":2,"waiting":1,"toasts":1,"total":5}`.

## UNVERIFIED

- Real screen: the shell was never shown on a display in this work (D191, one display). Motion, hover glow, the chip pulse and toast slide are exercised only as code paths; the headless render shows final states.
- Windows "animation effects" are OFF on the development PC (`SPI_GETCLIENTAREAANIMATION` returned false), so every animation is skipped there by design. Turn them on in Windows (Settings > Accessibility > Visual effects) or set `UJWALAM_REDUCE_MOTION=0` to see them.
- CPU cost of the animations was not measured; by construction nothing runs while idle (no running tasks, no hover, no toast), and nothing repaints the preview slots.
- The clipper's real `ujwalam-progress` lines (added by another branch) are tested with a fake child only.
- `clips.matchGate` validation lives in another branch; until it is merged the server answers 400 and the dialog says so in plain words (tested).
- 125 % scaling: the 1600x900 assertion holds in the offscreen render; a real 125 % display was not checked.
