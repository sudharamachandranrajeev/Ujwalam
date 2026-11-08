# 2026-11-08 studio crash: cause, fix, crash capture, windowless start

Status: fixed on branch `fix/studio-crash` (cut from `claude/alpha0-d1` @4b9d0ae). Not yet used on a real stream.

## Symptom

On 2026-11-08 the Qt studio window of the installed alpha.8 closed by itself twice. The launcher printed only the
shell's exit code `3221225477` (= `0xC0000005`, access violation). There was no studio log and no crash report, so the
cause could not be read from the user's machine. The launcher also kept a console window open for the whole session.

## Timeline from the user's logs (read only)

Times are local (UTC offset 0, so log times equal local time).

- Session 1 (`host-2026-11-08T18-36-22.log`): last studio API calls `preview.open` at 18:37:57-58, replay save at
  18:41:01, shutdown by Ctrl-C at 18:52:09. No task file was written in this session, so the exact trigger of the first
  crash is UNVERIFIED. The same use-after-free (below) can be hit by any task chip that shows progress on two
  consecutive polls (for example the UI server's in-memory "Loading your scenes" or preview tasks); whether it crashes
  depends on heap reuse.
- Session 2 (`host-2026-11-08T18-55-08.log`): `record.stop role=api` at 19:20:25.443. The "while recording" clip run
  started its review task at 19:20:29 (`tasks/clip-practice-h-20261108-185525.json`, `running` with `done`/`total`).
  The window exited at 19:20:35, which is the third 2-second status poll after the task appeared: the first poll that
  updates an existing progress bar after its glide animation has finished.

## Root cause

`SmoothBar` (the progress bar in a task row, `app/studio/src/taskbar.cpp`) kept a raw `QVariantAnimation *glide_`.
`motion::run` returns a self-deleting animation (`deleteLater` when it finishes). The next `setProgress()` called
`glide_->stop()` on the deleted object.

Crash report written by the new capture from the pre-fix build (probe, see Reproduction):

```
code: 0xc0000005 (access violation)  read at 0x78
#00 Qt6Core!QAbstractAnimation::stop+0x4
#01 ujwalam-studio!SmoothBar::setProgress (taskbar.cpp:60)
#02 ujwalam-studio!TaskRow::setTask (taskbar.cpp:267)
#03 ujwalam-studio!TaskBar::rebuildRows (taskbar.cpp:414)
#04 ujwalam-studio!TaskBar::update (taskbar.cpp:392)
#05 ujwalam-studio!MainWindow::pollStatus lambda (main_window.cpp:1846)
```

The same code is in alpha.8 (d7dba5f).

Why the tests missed it: the headless probe (`UJWALAM_HEADLESS=1`, offscreen platform) never showed the window, and
`motion::run` does not animate a hidden widget, so no animation was ever created or deleted.

## Fix

- `SmoothBar::glide_` is a `QPointer<QVariantAnimation>`; it reads as null once the animation deleted itself, and a
  running one is stopped and `deleteLater`ed before a new one starts.
- The same pattern elsewhere in the task bar is guarded too: the panel open/close animation (`panelAnim_`, a
  `QPointer`; the previous one is stopped first), and the opacity effects used inside panel and toast animation steps
  are held as `QPointer<QGraphicsOpacityEffect>` and checked before use; the toast's slide-in is stopped before its
  fade-out starts.

## Reproduction and regression test

`tests/studio-qt-shell.test.mjs`, "regression (D296 proposed): a clip task running and finishing with the window shown
and animations on does not crash the studio". It runs the probe for 16 s with `UJWALAM_STUDIO_PROBE_SHOW=1` (the
window is shown on the offscreen platform, without activation, so animations run) and `UJWALAM_REDUCE_MOTION=0`, opens
and closes the task panel, and feeds a clip task that runs 0..4 then finishes at 9.5 s, plus a preview task.

- Before the fix: 4 of 4 runs crashed with `0xC0000005` (the report above is from one of them).
- After the fix: passes (3 separate runs plus the full-suite run).

The probe now reports `windowShown` (true only in this mode) so the test proves the animations ran.

## Crash capture (permanent)

- `app/studio/src/studio_log.cpp`: when the launcher sets `UJWALAM_STUDIO_LOG_DIR` (it passes `<dataDir>/logs`), the
  studio writes `studio-<UTC time>-p<pid>.log` (Qt messages, 2 MiB cap, newest 10 kept) and installs the host's
  text-only crash reporter (`app/host/src/crash.cpp`, now with a configurable file prefix, program name and log label;
  host defaults unchanged). A crash writes `studio-crash-<UTC time>-p<pid>.txt`: exception code, address as
  module+offset, the studio log name and a dbghelp stack (function and line when the PDB is beside the exe). No minidump,
  no registers, no memory (privacy, decision of 2026-11-05).
- The launcher appends one line per shell exit to `<dataDir>/logs/studio-exits.jsonl`: time, exit code (decimal and
  hex), signal, crash yes/no, uptime, report file name.
- After a crash the launcher reopens the shell after 2 s with a new one-time login key (control line
  `rearm <64 hex>` on the UI server's parent pipe; nothing else is accepted on it), at most 3 times in 10 minutes.
  Recording and streaming are in the host and carry on. Exit code 0 (window closed) still stops everything.
- Tests-only crash path: `UJWALAM_STUDIO_TEST_CRASH=av|abort` works only with `UJWALAM_HEADLESS=1` and a log folder;
  otherwise the studio exits 65 and writes nothing. `tests/studio-crash-capture.test.mjs` checks the report format.

Installed builds ship no studio PDB, so their reports give module+offset only; symbolise offline with the PDB of the
same build (`out/studio/build/ujwalam-studio.pdb`).

## Windowless start (D191)

- `ujwalam-start.exe` (`app/studio/src/start_stub.cpp`, GUI subsystem, no Qt) is the shortcuts' new target. Next to
  `current.txt` it runs that version, else the build it sits in; it runs
  `node.exe <build>\tools\package\run-installed.mjs <args>` with `CREATE_NO_WINDOW`, stdin NUL, stdout and stderr to
  `<data root>\core\logs\launcher-<UTC time>-p<pid>.log`, and returns node's exit code. It shows no window and no
  message box. Problems are written to that log with Ujwalam.cmd's exit codes (3 missing version, 9 no Node.js).
- `run-installed.mjs` keeps the newest 10 `launcher-*.log` files.
- `Install-Ujwalam.ps1` copies `ujwalam-start.exe` to the install root and points both shortcuts at it (same arguments);
  `Ujwalam.cmd` stays for terminal use. The packager ships it at the zip root (allowlisted top file).
- Stopping: close the studio window (D280). No tray icon was added.

## Tests

Runs of 2026-11-08 in the worktree, after the fix:

- `node --test tests/studio-qt-shell.test.mjs tests/studio-crash-capture.test.mjs`: 50 tests, 49 pass, 1 fail. The
  failure was "look (D285)", where the probe saw 0 toasts instead of 1. It is a timing flake under machine load: the
  test passed 3 of 3 runs alone on the fixed exe, and 3 of 3 on the pre-change exe of the main tree. The 4
  crash-capture tests and the regression test pass.
- `node --test tests/studio-ui-alpha.test.mjs`: 37 tests, 36 pass, 1 skipped (existing skip). It covers the spawn
  spec's log folder and version, the exit record, the relaunch limit and the rearm control line.
- `node --test tests/package-alpha.test.mjs`: 15 tests, 14 pass, 1 skipped (the full-build E2E needs
  `UJWALAM_PACKAGE_E2E=1`). It checks four things:
  - The stub runs the current version and passes on its arguments, its log and its exit code.
  - A missing or invalid version gives exit 3.
  - The shortcuts target the stub.
  - Launcher logs are pruned.
- `npm run lint`: 0 findings.
- Studio build (`node app/studio/tools/build.mjs`): ok. It builds `ujwalam-studio.exe` and `ujwalam-start.exe`.
- The host was not rebuilt. `crash.cpp` changes only add settings whose defaults keep the old names; it compiles in the
  studio build. Host build UNVERIFIED.

## UNVERIFIED

- The trigger of the first crash (session 1); see the timeline.
- Windows Defender's ML scanning of the new unsigned `ujwalam-start.exe` (the host exe once had a false positive).
- The installed shortcuts were not run on the user's machine (the running alpha.8 was not touched).
- After an automatic reopen, the H and V previews re-embed through the normal startup path; not checked with real
  devices.
- Not fixed, noted: `updateClips` reads `queued` as a number, but it is a list, so "Clips waiting" never shows.
