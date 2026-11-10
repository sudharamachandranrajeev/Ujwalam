# LU8 live-soak release gate (2026-11-10): gate built; RESULT PENDING (see "Runs")

Plan: `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` (LU8, D324). Decisions: D325.

## How it works

```
npm run soak                 # 30 min, the release gate
npm run soak -- --short      # 3 min
node tools/soak/live-soak.mjs [--minutes N] [--sample-s 10] [--work-dir DIR] [--out-dir docs/evidence] [--keep-media] [--no-record] [--wait]
```

- Refuses to start (exit 4) while Meld Studio, an installed Ujwalam (a process under `%LOCALAPPDATA%\Ujwalam`, or one
  using it), or a detector job runs; `--wait` waits for those processes to exit (Wait-Process, no polling).
- Stages the runtime (`tools/soak/stage.mjs`: services, overlay child, host lib and projects, data, registry, control
  page, the tools the services import) into the work dir, so data files can be changed without touching the repo.
- Starts the same headless stack as the stream-day run (`tools/soak/stack.mjs`, shared with `stream-day.mjs`):
  ujwalam-host (`UJWALAM_HEADLESS=1`, no `--allow-devices`, no `--allow-live`, hotkeys off), four 127.0.0.1 RTMP
  listeners (ffmpeg `-listen 1`, 60 s segments, every one kept until probed), the event core fed by the mock
  Streamer.bot, the studio UI server. Every process BelowNormal.
- Session while all four streams and the recording run: placeholder chat (1 per 1.5 s, a burst of 15 every 4 min),
  scene switches on H and V (an extra colour scene, every 30 s; 20 s short), effect bursts (storm, charge, gg), clip
  saves (`replay.save`), one data hot-reload of each LU2 kind (valid change, broken file, fix).
- Checks (all must pass): 0 dropped frames (host and every sink), 0 render-lagged, 0 encode-skipped (host counters
  read every second), every stream live in every sample, 0 video timestamp gaps in every received segment (ffprobe; the
  very last step of a stream at stop is listed apart), each listener received the whole run, no process exit, overlay
  no restart, host exits 0 on shutdown, no crash report, no error-level log line (host incl. overlay child, event core,
  UI server; known benign lines listed with the reason), no process left, a quiet machine during the run (checked
  every minute), every reload applied / kept / cleared.
- Writes `docs/evidence/YYYY-MM-DD-live-soak-<mode>-HHMM.{json,md}` (numbers and base names only; paths in log lines
  become `<path>`), exit 1 on any failure. Every lost frame is listed with the script action in the 3 s before it and
  the CPU of the stack against the rest of the machine at that moment.

Pure parts are tested (`tests/live-soak.test.mjs`, 8 tests: arguments, timestamp gaps, end-of-stream step, error-level
lines, warning lines without paths, the staged runtime resolves every relative import, the report).

## Runs

| Run | Mode | Result | Notes |
|---|---|---|---|
| 11:13 (report not kept) | short | FAIL | Found two gate bugs: the stage lacked `tools/diag` (UI server did not start) and the last step at stream stop counted as a gap. Fixed. Render lag 130 / encode skipped 251 in one stall at t ~55 s. |
| 11:21 (report not kept) | short | FAIL | All 8 reloads passed. Render lag 15 / encode skipped 15, spread over the run, system CPU 50-80 % while the stack used ~6 %. |
| `2026-11-10-live-soak-short-1128` | short | FAIL 31/33 | Only the two render checks failed (lagged 333, skipped 367). Every lost frame came with another agent's detector job (python) at 31-48 % of all 16 cores, the stack at 5-13 %; the large burst at t 166-181 s started when the installed Ujwalam was launched on the same machine (its CEF and workers). 0 dropped on every sink, 0 timestamp gaps, all reloads, no error line. |
| `2026-11-10-live-soak-short-1225` | short | FAIL 31/34 | Started on a quiet machine (start check empty). At t ~92 s another agent's clipper job started (process start 12:27:01) (the minute check saw it at t 122 s, "quiet machine" FAIL); from then on render lag 632 / encode skipped 2021, NVENC load up to 98 % (our three sessions plus theirs), "audio is lagging" warnings from t 96 s. 0 lost frames before t 92 s (first loss at 92.4 s). 0 dropped on every sink, 0 timestamp gaps, all 8 reloads passed, no error line. |

Cause of the lost frames: load outside the stack while the stack runs BelowNormal (as the resource rules require for
agent runs), not the scripted actions (no lost frame followed a scene switch, effect burst, clip save or reload except
one frame at t 80 s next to a scene switch, under the same outside load). The soak-replay / soak-system flakes noted
in `docs/evidence/2026-11-09-flaky-tests.md` are not part of this gate (it does not use the replay core child).
