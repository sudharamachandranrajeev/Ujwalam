# 2026-11-10 LC1 live clips ready: H + V recording while live, clip readiness, visible state (D333)

Branch `live/clips-ready` (from `claude/alpha0-d1` at 34552e5). User request, 2026-11-10: "make the app live stream
ready as a priority with auto clipping feature while live and reel creation in the background from clips as per
existing rules." Decision record: D333 in `docs/plan/2026-10-29-v1-decisions.md`.

Result: PASS on tests and a loopback host run. Not yet used on a real stream: **awaiting live test** (UNVERIFIED live).

## What changed

- **V recording while live** (`data/outputs/alpha-live.json`, `app/host/lib/outputs-plan.mjs`,
  `services/studio-ui/stream-setup.mjs`): a `record-v` file sink on the existing `vert` rung (no new encoder, audio
  encoded once), crash-safe .mkv named `<record name>-v-<stamp>.mkv`. File targets take a plan-only
  `"optional": true`. When a streaming plan has no stream on that rung (YouTube V off through the D327 toggles or
  `--sinks`), the recording is dropped and does not add an encoder. Settings > Stream adds the V recording in the
  H + V canvas mode only. Replay buffer binding unchanged. `record.start` with no ids starts both recordings.
- **Clip readiness** (`services/studio-ui/readiness.mjs`, `data/live/readiness.json` `clips`, `server.mjs`): when
  live clipping is wanted (flag `live-clips` or Settings clips "while"), these FAIL with a plain reason and the fix:
  - no clip Python (.venv-gpu / .venv);
  - no `services/clip/live_worker.py`;
  - ffmpeg or ffprobe not on PATH;
  - the live clipper did not start (reason from the launcher, for example "the game layer has no capture device");
  - the live clipper gave up after 5 restarts.
  A missing or stale launcher status, or a clipper that is restarting, is a WARN. With clipping off the check is
  unchanged. The disk check gives hours left from the recordings' bitrates (falls back to `disk.gbPerHour`).
- **Launcher** (`services/studio-ui/launch.mjs`): plain reasons; the start is retried every clip tick (5 s), so a
  device chosen later starts the clipper; state `running` / `stopped` / `not-started` with restarts (max 5).
- **Visible state** (`services/studio-ui/record-clips.mjs`): `clips/status.json` carries `liveClipper` (state,
  reason, restarts, watching, since, moments kept). The task panel (task file `tasks/live-clipper.json`) shows
  "Live clips: watching the game" with "N moments kept so far", or "Live clips are not being made" with the reason,
  and "Live clips: N moments kept" when the stream ends. A finished clip job without reels has the note
  "N clips made. Reels not made: <reason>", taken from the job (no H, no V, file missing) or from the run's
  `render.json` `montage` status (skipped or failed, with its reason). The Qt studio already shows task files; no Qt
  change was needed.
- No typed confirmation and no new "are you sure" (D332). No feature flag (D333, as D330–D332).

## Loopback host run (live plan, `--allow-live` host, every target on 127.0.0.1)

```
UJWALAM_HEADLESS=1 node --test app/host/tests/host-live-plan-record.test.mjs
```

```
✔ live plan on loopback (--allow-live host): H and V recordings beside four streams, three encoders, both ffprobe (13106.2186ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

`result.json` and ffprobe of the two recordings (about 6 s each):

```
rungs: yt-h, reencode-tk, vert                      (3 encoders, as before; record -> yt-h, record-v -> vert)
alpha-20261110-172013.mkv    video h264 1920x1080 369 packets, audio aac 287 packets, 13,197,444 bytes
alpha-v-20261110-172013.mkv  video h264 1080x1920 365 packets, audio aac 284 packets,  5,805,154 bytes
ffprobe format: 6.150000,17167406  /  6.084000,7633338   (duration s, bit_rate bps)
listeners: youtube-h 17,489,887 B, youtube-v 7,778,116 B, twitch 6,218,289 B, kick 6,218,289 B (all playable video)
```

The test also checks that `finishedRecording()` turns that host status into `{ h, v }` and that the after-stream
review job gets `--v-recording <V file>` and `--montage`. An earlier run (alpha-20261110-170758) gave the same result.

## Disk numbers

From `data/outputs/presets/youtube-1080p60.json`: yt-h 17,000 kbps, vert 7,500 kbps, audio 160 kbps per file.

| Recorded | kbps | bytes per hour | GB (1024^3) per hour |
|---|---|---|---|
| H only (before) | 17,160 | 7.72e9 | 7.2 |
| H + V (now) | 24,820 | 11.17e9 | 10.4 |
| V adds | 7,660 | 3.45e9 | 3.2 |

The loopback files agree (17.17 and 7.63 Mbps). Readiness thresholds unchanged: fail below 22 GB (about 2.1 h of
H + V), warn below 44 GB (about 4.2 h); the data fallback `gbPerHour` is 11.

## Tests

```
UJWALAM_HEADLESS=1 node --test tests/record-clips.test.mjs tests/studio-ui-readiness.test.mjs tests/studio-ui-alpha.test.mjs tests/stream-setup.test.mjs tests/studio-launch-d327.test.mjs app/host/tests/outputs-plan.test.mjs tests/studio-tasks.test.mjs tests/stream-day.test.mjs
ℹ tests 143
ℹ pass 142
ℹ fail 0
ℹ skipped 1

UJWALAM_HEADLESS=1 node --test tests/studio-ui-server.test.mjs tests/studio-qt-d327.test.mjs tests/package-alpha.test.mjs
ℹ tests 55
ℹ pass 54
ℹ fail 0
ℹ skipped 1
```

The two skips are existing environment gates: "full build" needs `UJWALAM_PACKAGE_E2E=1`, and the face worker test
needs `.venv-gpu` in the worktree. Per file: record-clips 19 (4 new for LC1), readiness 39 (clips off, each clips-on
fail/warn, disk derived), studio-ui-alpha 36.

Pre-commit hook on both code commits (build, lint, build-host, build-studio, validate-registry, validate-outputs,
validate-games, private-scan, legacy-verify):

```
ci: 9/9 passed in 15.3s
```

`npm run validate:outputs` passes. The full `npm run ci` and the soak were not run (brief: one heavy job at a time).

## Codex review

- **P2, readiness failed during the last scheduled restart** (`services/studio-ui/readiness.mjs`, launcher). The
  launcher counted the fifth restart before its 10 s delay. During that delay readiness saw `stopped` with
  restarts >= max and failed, although a restart was still pending. Fixed: the launcher's exit step is now the pure
  `clipperExited()` in `launch.mjs`. It publishes `restarting` while a restart is scheduled (the fifth included) and
  `gave-up` only when the fifth restarted process also stops. Readiness fails only on `gave-up`, warns on
  `restarting`, and warns on any unknown state. The task panel shows "Live clips: restarting the live clipper" while
  a restart is pending.
  Tests: `tests/studio-ui-alpha.test.mjs` (five exits give `restarting` 1..5 with a restart each; the sixth exit gives
  `gave-up`, no restart), `tests/studio-ui-readiness.test.mjs` (fifth restart pending = warn, `gave-up` = fail,
  unknown state = warn), `tests/record-clips.test.mjs` (restarting row).

```
UJWALAM_HEADLESS=1 node --test tests/studio-ui-alpha.test.mjs tests/record-clips.test.mjs tests/studio-ui-readiness.test.mjs
ℹ tests 96
ℹ pass 95
ℹ fail 0
ℹ skipped 1
```

## LC2: Record while live (D334), soak probes H and V

- **Record while live** (`services/studio-ui/record-live.mjs`, `server.mjs`, `user-settings.mjs`): new setting
  `clips.recordLive`, default on. Once the host accepts a stream start and the stop-wins checks pass, the UI server
  starts the recording (H and V). When the stream ends, it stops that recording: by Stop stream, End all, or the
  status poll seeing no stream sink running (30 s grace when the stream was never seen running). The launcher's
  finishedRecording then fires and the review job runs with `--v-recording` and `--montage`. These rules hold:
  - A recording already running is left alone.
  - A Record or Stop recording click hands the recording back to the user.
  - A failed `record.start` leaves the stream live. The answer carries a warning and the task panel a failed row.
  - A Stop that arrives during `record.start` wins.
  - The UI server needs a data folder for the setting. Without one (older tests) nothing changes.
- **End all**: the answer adds `recordingStopped: true`. The control page says "The recording started with the
  stream stopped too." The End all summary now says that a recording you started keeps running.
- **Qt Settings > Clips**: a "WHILE I STREAM" box with the "Record while live" switch row and its explanation. The
  switch is a draft until Save (D332). The probe reports it, and the probe action `settings-record-live:on|off`
  clicks it.
- **Text judgement**: the coordinator's wording said "to your clips folder". Recordings are saved to the recordings
  folder (Settings > Folders), so the explanation reads "Records the stream (H and V) to your recordings folder so
  reels can be made after it ends. Uses about 10 GB per hour."
- **Fake host** (`backends.mjs`): `record-...` ids count as record sinks, as on the real host.
- **live-soak** (`tools/soak/live-soak.mjs`): every file sink is checked: it must have started, been live in every
  sample, and have its own stamped file probed for gaps and coverage. `recordingFileFor()` matches
  `<base>-YYYYMMDD-HHMMSS.<ext>`, so "alpha" never takes "alpha-v-...". The soak itself was not run (brief).

```
UJWALAM_HEADLESS=1 node --test tests/studio-qt-shell.test.mjs
# tests 64
# pass 64
# fail 0

UJWALAM_HEADLESS=1 node --test tests/record-live.test.mjs tests/record-clips.test.mjs tests/user-settings-match-gate.test.mjs tests/user-settings-theme.test.mjs tests/guide.test.mjs tests/studio-ui-server.test.mjs tests/studio-ui-readiness.test.mjs tests/studio-ui-alpha.test.mjs tests/live-soak.test.mjs tests/stream-recovery.test.mjs tests/studio-tasks.test.mjs tests/stream-day.test.mjs tests/stream-setup.test.mjs tests/studio-launch-d327.test.mjs tests/studio-qt-d327.test.mjs tests/package-alpha.test.mjs app/host/tests/outputs-plan.test.mjs
ℹ tests 260
ℹ pass 258
ℹ fail 0
ℹ skipped 2   (the same two environment gates as above)
```

New tests:
- `tests/studio-ui-server.test.mjs` "record while live" (6):
  - auto start and stop;
  - a hand-started recording is untouched, and a Record click takes the recording over;
  - a `record.start` failure leaves the stream live with a warning and a task note;
  - setting off gives the old behaviour;
  - End all, and the host reporting every stream stopped;
  - Stop wins during `record.start`.
- `tests/record-live.test.mjs` (4): off or closing; unreadable outputs or no record sink; grace and reconnecting;
  stop-wins and handOff.
- `tests/studio-qt-shell.test.mjs`: the Settings switch.
- `tests/live-soak.test.mjs`: `recordingFileFor`.
- Settings tests: the `recordLive` default, validation and merge.

UNVERIFIED for LC2: a real stream started from the studio that records H and V by itself and makes the reels after
it ends.

## Not checked (UNVERIFIED)

- A real stream: H + V recording, the live clipper and the task panel rows on a real live session.
- OCR GPU cost of the live clipper next to NVENC with three encoders running.
- A real montage (kill montage and match reel) made from a live H + V recording.
- `tools/soak` live-soak now probes every file sink (LC2); the soak itself was not run.
- Going live now records by itself (LC2, D334, on by default); before LC2 the reels needed Record pressed.
