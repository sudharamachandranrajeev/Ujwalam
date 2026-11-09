# 2026-11-09 visible tasks and the tray: nothing runs on unseen after Ujwalam closes

Status: built and tested headless on branch `ui/tray-tasks`. The changes are not merged and have not been used on a real
desktop or stream yet. Decision D311 is proposed (text below).

## The user's report (2026-11-09)

On 8 Nov, processing showed in a terminal window after Ujwalam had closed. The user's rules:

- Every process shows in the app with a progress bar.
- The user is notified when work starts and ends.
- Nothing runs in the background without the user knowing.
- Pending background tasks go to a tray icon, with a progress bar, elapsed time and an estimated time left per task.

## Root cause (from the user's logs and the installed alpha.8, read only)

Times are local.

1. The alpha.8 shortcuts started `Ujwalam.cmd`, a console program. `Install-Ujwalam.ps1` (alpha.8) set
   `$lnk.TargetPath = Join-Path $InstallRoot 'Ujwalam.cmd'`, so the launcher ran in a visible console window.
2. In session `host-2026-11-08T18-55-08`, recording stopped at 19:20:25. The "while recording" clip review started at
   19:20:29.
3. The studio window crashed at 19:20:35, with the SmoothBar use-after-free described in
   `docs/evidence/2026-11-08-studio-crash.md`.
4. The alpha.8 launcher printed "Qt shell ended unexpectedly; the studio keeps running. Ctrl-C stops everything." and
   kept the host and the clip job running. The window was gone, so the only sign of work was the console window. That
   console was the "terminal after Ujwalam closed". The review log ends at 19:24.
5. The user ended it with Ctrl-C at 20:57:36. The host log shows `STATUS_CONTROL_C_EXIT`.

Already fixed before this work:

- the crash (0f160ca);
- the console launcher. Since alpha.9 the shortcuts start `ujwalam-start.exe` (CREATE_NO_WINDOW).

Gaps found and fixed here:

- **A clip job's child processes outlived it.** The launcher stopped the clip job with `child.kill()`, which on Windows
  is `TerminateProcess` on one process only. ffmpeg, started by `clipper.py` through Python's `subprocess`, is not in
  any job object, so it kept running both on close and on "pause for live". libuv's own job for Node's children has
  `SILENT_BREAKAWAY_OK`, so grandchildren escape it too. Both tests below reproduce this.
- **The clip job had no parent pipe (D234).** If the launcher died, the job did not notice.
- **The launcher could keep running with no window.** After the studio relaunch limit it kept running even when nothing
  was live.
- **The `hidden-window` lint rule did not check PowerShell.** A shortcut whose target is a console program (`.cmd`,
  `.bat`, `.ps1`, `node`, `python`, `powershell`, `cmd`) was not flagged. Neither was `Start-Process` of a console
  program without `-WindowStyle Hidden` or `-NoNewWindow`.

## Design

**Process trees end together.**

- `services/common/kill-tree.mjs` ends a whole process tree. `killTree(pid)` runs System32 `taskkill.exe /T /F /PID`
  with no window. Exit status 128 (already gone) counts as ended. If taskkill fails, it falls back to a plain kill; on
  other platforms it kills the process group.
- The launcher's `stopAll` and `record-clips` (on stop and on pause-for-live) use it.
- The clip job runs with stdin as a pipe and `UJWALAM_PARENT_PIPE=1`.
- `clipper.py` calls `contain_children()` at start. This puts itself in a kill-on-close job object
  (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), so ffmpeg ends whenever the clipper ends, however it ends.
- `clipper.py` also calls `end_tree_when_parent_gone()`. On end-of-file on stdin it runs taskkill /T on itself.

**No windowless launcher.** After the relaunch limit, the launcher checks `outputs.status`:

- If nothing is live, it stops everything and exits.
- If a stream or recording is live, or the status cannot be read, it keeps running so the stream is not cut. This case
  is logged; see "Not verified".

**One task list, with times.**

- `services/studio-ui/tasks.mjs` adds `progress` (0..1 or null), `elapsedMs` and `etaMs` to every task in the
  status snapshot.
- `etaMs` is null ("time left unknown") in these cases:
  - less than 3 s of samples;
  - no progress yet;
  - the task has finished;
  - progress went back or the stage changed (the timing then starts again).
- For a staged task (clip review, then render) the estimate covers the current stage. The text says "this step: about
  N min left".
- Clip uploads to YouTube now write an `upload-<id>` task with MB-sent progress, ending done or failed.

**Taskbar (Qt).** Each task row shows its bar plus a time line:

- `m:ss elapsed · about N min left`
- `time left unknown`
- `waiting its turn`
- `took m:ss`

A toast appears when a long job starts (not `ui-*` tasks), finishes or fails.

**Close with tasks running.** Closing the window while a task runs or waits, and nothing is live, opens a question. It
lists each task with its time and offers three buttons:

- **Keep running in the tray** (the default).
- **Stop them and close.** The window exits 0; the launcher then ends every task's whole tree.
- **Do not close.**

While live, the existing "yes, on air" question comes first and stays as it was.

**Tray (`app/studio/src/tray.cpp`, `TrayKeeper`).**

- **Icon:** `QSystemTrayIcon` with the app icon `res/ujwalam.ico`, or Qt's standard computer icon if the icon file is
  missing.
- **On start:** the window hides and the app no longer quits on its last window. A "still working" notification shows.
- **Tooltip:** "Ujwalam: N tasks running" followed by one line per task, cut at 120 characters for Windows.
- **Right-click menu:** one disabled line per task (title, percent, time), then **Open Ujwalam** and
  **Stop all and quit**. Stop all asks once to confirm.
- **Left click:** opens a small list of the tasks, each with a progress bar and its time, plus Open / Stop all / Hide
  buttons. It is a frameless tool window shown without activation (`WA_ShowWithoutActivating`,
  `WindowDoesNotAcceptFocus`), so it never takes focus. It opens only on a click, never by itself.
- **When the last task finishes:** a "all tasks finished" notification shows. After 3 s the studio exits 0 and the
  launcher stops the rest.

## Review fixes (Codex review, 2026-11-09)

| Severity | Finding | Fix | Test |
|---|---|---|---|
| HIGH | Two tray paths exited without checking `live_`: the "all finished" exit and Stop all. A stream started from the control page while the window was in the tray would have been ended by the launcher's cleanup. | Every tray exit first calls the new `GET /ui/api/quit-check`. It reads `host.status` fresh, never the cached snapshot. It fails closed: a stream, a recording, or a status that cannot be read means "do not quit". **All finished but busy:** the studio stays and the window comes back. **Stop all while busy:** it stops the tasks only. `POST /ui/api/tasks/stop` writes `<dataDir>/clips/stop-tasks.json`. The launcher's record-clips then ends the clip job's tree and marks its task "Stopped by you". The job is kept for the next start and nothing new starts. The upload chain stops at its next chunk; the upload stays queued and the session is kept. A request older than the launcher is ignored. | `tests/studio-tray.test.mjs`: staying open while live, staying open when unreadable, Stop all while live stops the tasks only. `tests/kill-tree.test.mjs`: record-clips stop request. `tests/posting-auto-chain.test.mjs`: upload stopped. |
| HIGH | `killChildTree` checked `exitCode` but not `signalCode`. A child ended by a signal (exitCode null) could get `taskkill /T /F` on its PID, which may have been reused by then. | `hasExited` checks both codes. Node sets them when it reaps the process. Until then libuv holds the process handle, so Windows cannot reuse the PID. An exited child's PID is never targeted. On the Python side, identity is handle-based (the clipper's kill-on-close job object). | `tests/kill-tree.test.mjs`: an exited child, including a real `child.kill()` (exitCode null, signalCode SIGTERM), is never targeted. |
| MEDIUM | `finishing_` in the tray was never cleared when new tasks appeared, so the pending timer exited anyway. | A new active task cancels the countdown (a generation counter) and shows "still working" again. The callback checks again, when it fires, that it is still the same countdown, the tray is still active and nothing is running. `UJWALAM_TRAY_FINISH_MS` sets the countdown for tests. | `tests/studio-tray.test.mjs`: a task starting during the countdown cancels it. |
| MEDIUM | `end_own_tree` never reached `os._exit(1)` if `subprocess.run(taskkill)` raised (for example the 15 s timeout). | `os._exit(1)` now runs in `finally`. | `tests/py/test_clip_contain.py`: exits even when taskkill fails. |

Round 2 (Codex review of a1d0893):

| Severity | Finding | Fix | Test |
|---|---|---|---|
| HIGH | The quit check was only a snapshot. A stream or recording could start between "idle" and `QApplication::exit(0)`, and the launcher would then stop the host. | `GET /ui/api/quit-check` is replaced by a closing lock in the UI server, which is the only writer of starts to the host. `POST /ui/api/quit/begin` works in this order: (1) it sets the lock first, synchronously, so every later `stream.start` or `record.start` is refused with 409 `{ error: 'closing', detail: 'Ujwalam is closing' }`, both when the start is asked for and when it is confirmed, so a start asked for before the quit is refused too; (2) it refuses the grant if a start is under way or ended less than 5 s ago (the host may not show it yet); (3) it reads `host.status` fresh and refuses if live, recording or unreadable; (4) on a grant it revokes the launcher's go-live authority, so no stream recovery runs. A refused quit releases the lock at once. `POST /ui/api/quit/cancel {token}` releases it. (Round 2 also had an expiry after 60 s; round 3 removed it, see below.) The studio exits only with a granted lock. Stops are never blocked. | `tests/studio-ui-quit-lock.test.mjs` (4 tests): quit refused while live, while recording or when unreadable; a granted lock blocks starts (including one confirmed after the grant) and the host never gets them; a start racing the quit refuses the quit; the lock is released by cancel or expiry. |
| MEDIUM | After allFinished, the asynchronous quit callback checked only `tray_->active()`. A task restarted while the request was pending would still be killed. | `allFinished(countdown)` carries its countdown generation. The callback checks `stillFinished(countdown)` again: same countdown, still in the tray, nothing running. If that fails it does not exit, and it releases a granted lock. | `tests/studio-tray.test.mjs`: a task restarting while the (slow) quit request is in flight leaves no exit and releases the lock. |

Round 3 (Codex review of 88f9d78):

| Severity | Finding | Fix | Test |
|---|---|---|---|
| HIGH | The 60 s expiry ran independently of the studio. If Qt stalled after a grant, or the lock expired during `await authority.revoke`, a later start cleared the lock and went live; Qt then exited on its stale grant and the launcher killed the live host. | A granted lock never expires. Only a cancel with its token, or the end of the UI server process, releases it. A studio that hangs holding it leaves every start refused with "Ujwalam is closing" (fail safe). The control page now shows the server's plain detail. Before its grant, the lock exists only while `quitBegin` runs, and each of its waits (`host.status`, the authority revoke) is bounded to 10 s. No answer, or a revoke the launcher does not confirm, refuses the grant and releases the lock, so nothing can expire or clear it in between. Right before `QApplication::exit`, the studio sends `POST /ui/api/quit/commit {token}`, a synchronous check that the token is still the held, granted lock. It exits only on 200; otherwise it releases the lock and stays open (the window comes back). | `tests/studio-ui-quit-lock.test.mjs`: a granted lock still refuses starts an hour later on the test clock; commit holds only for the held token; a stale token after a cancel fails commit; a slow revoke keeps the lock and starts stay refused even when the clock jumps; a revoke with no answer or a refusal gives no grant and releases the lock. `tests/studio-tray.test.mjs`: a commit not confirmed means no exit, the lock is released and the window comes back. |

## Proposed decision D311 (default on)

> D311 (proposed, 2026-11-09): Nothing Ujwalam starts runs on unseen.
> - Every background job is a task in `<dataDir>/tasks/` with progress, elapsed time and time left. The time left is
>   "unknown" when it cannot be estimated.
> - The window shows each task, with a toast on start, finish and fail.
> - Closing the window with tasks running asks: keep running in the tray, stop them, or do not close.
> - Stopping ends each job's whole process tree: taskkill /T, a kill-on-close job in the clipper, and the parent pipe.
> - The tray shows each task and exits with a notification when the last one ends.
> - A tray exit never ends a stream or a recording. It takes the UI server's closing lock first, which fails closed, refuses every start while it is held and never expires once granted. It exits only after the server confirms the grant still stands (quit/commit). While busy, Stop all
>   stops the tasks only.
> - The launcher never stays running without a window unless something is live.
> - The `hidden-window` lint rule also flags PowerShell shortcuts and `Start-Process` calls that start console
>   programs.
> - On by default. There is no flag, because this is a safety rule, not a feature.

## Tests (headless, `UJWALAM_HEADLESS=1`, no window appears)

| What | Test | Result |
|---|---|---|
| Root cause: plain kill leaves the child; killChildTree leaves no strays (`tools/stray-procs.mjs`); record-clips stop and pause-for-live end the whole tree; stdin pipe + env marker; killTree contract | `node --test tests/kill-tree.test.mjs` | 7 pass (after the review fixes) |
| Python: without the job the child outlives a killed clipper; with `contain_children()` it ends; parent-pipe EOF; no marker no watch; `end_own_tree` runs hidden taskkill | `python -I -m unittest discover -s tests/py -t tests/py -p test_clip_contain.py` | 6 pass |
| Task timing: progress, ETA math, stage reset, finished tasks | `node --test tests/studio-tasks.test.mjs` | pass |
| Upload task written and ends done | `node --test tests/posting-auto-chain.test.mjs` | 14 pass |
| Lint catches `.TargetPath = ...\Ujwalam.cmd` and a visible `Start-Process` (fixture lines 4, 6, 8); accepts `**cc.NO_WINDOW` (a false positive in the rule, fixed in the rule) | `node --test tests/lint.test.mjs` | 33 pass |
| Close question with cancel, stop, tray; tray rows, menu, tooltip, click opens list once; tray exits when the last task finishes; Stop all; Open; no tasks means no question; taskbar elapsed + ETA; review fixes | `node --test --test-concurrency=1 tests/studio-tray.test.mjs` | 14 pass |
| Closing lock (rounds 2 and 3) | `node --test tests/studio-ui-quit-lock.test.mjs` | 5 pass |
| Regression: existing studio shell probes (task bar, toasts, crash regression), together with the task, record-clips, auto-chain, lint and kill-tree tests | `node --test --test-concurrency=1 tests/studio-qt-shell.test.mjs tests/studio-tasks.test.mjs tests/record-clips.test.mjs tests/posting-auto-chain.test.mjs tests/lint.test.mjs tests/kill-tree.test.mjs` | 119 pass, 0 fail, 0 skipped |
| Quick CI | `node tools/ci.mjs --quick` (pre-commit hook, every commit on this branch) | 9/9 passed |

Sample output from `tests/studio-tray.test.mjs`. The shell prints its own steps:

```
studio tray: on (1 task(s))
studio tray: all tasks finished; exiting
studio tray probe: {"active":true,"finishing":true,"lastMessage":"all finished","messages":2,"running":0,"tooltip":"Ujwalam: all tasks finished",...}
```

## Not verified (UNVERIFIED)

- **The tray on a real desktop.** The offscreen test platform has no system tray. These are untested: the icon, its
  tooltip, its notifications, and where the click list opens.
- **Where the click list opens.** It opens at the bottom right of the screen under the cursor, near the tray. D191 says
  an app window opens only on a second display; a user-invoked tray popup is treated as an exception. This needs the
  user's yes.
- **The clipper's ffmpeg containment in a real clip run.** It is tested with stand-in processes only.
- **The host in tray mode.** It keeps running until the tasks finish (the launcher stops it when the studio exits 0).
  Previews close with the hidden window. This is not checked on the installed build.
- **A studio crash while live.** The launcher keeps everything running with no window, so the stream is not cut.
  Nothing shows in a tray in that case.
- **Work not yet wired as tasks.** Feedback collection, tidy and packaging jobs do not write task files yet. Clip runs,
  uploads and the UI's own tasks do.
- **Estimate accuracy.** The time left is per stage and assumes steady progress.
- **Starts that bypass the UI server.** The closing lock covers every start that goes through the UI server (control page and studio window). The launcher's own stream recovery is covered by revoking the authority on a grant. A start sent directly to the host's API by another program is not covered.
- **Closing the window directly.** The plain window close (no tray) keeps its existing behaviour: "yes, on air" while live, and closing while only recording stops the recording (D280).

## Setup for this branch

The worktree is `.claude/worktrees/tray-tasks`.

- Junctions to the main checkout: `node_modules`, `.venv`, `legacy`, `app/spike/build`.
- Gitignored local files copied in: `data/profile.local.json`, `app/host/host.local.json`,
  `app/studio/studio.local.json`.
- The studio is built into the worktree's own `out/studio/build` (4 build threads).

## Files changed

- New: `services/common/kill-tree.mjs`, `tools/mock/clip-tree.mjs`, `tests/kill-tree.test.mjs`,
  `tests/py/test_clip_contain.py`, `tests/studio-tray.test.mjs`, `tests/fixtures/lint/hidden-window-ps1.txt`,
  `app/studio/src/tray.h`, `app/studio/src/tray.cpp`, this file.
- Changed: `services/studio-ui/record-clips.mjs`, `services/studio-ui/launch.mjs`, `services/clip/clip_common.py`,
  `services/clip/clipper.py`, `services/studio-ui/tasks.mjs`, `services/posting/auto-chain.mjs`,
  `services/posting/youtube.mjs`, `tools/lint.mjs`, `tests/lint.test.mjs`, `tests/fixtures/lint/hidden-window-py.txt`,
  `tests/studio-tasks.test.mjs`, `tests/posting-auto-chain.test.mjs`, `app/studio/src/taskbar.h`,
  `app/studio/src/taskbar.cpp`, `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`,
  `app/studio/CMakeLists.txt`.
