# Stream recovery after a host crash, and the match gate on the "while" clip path (2026-11-09)

Result: **PASS (headless tests, a real-host loopback crash test, quick CI). Not yet tried live.** Stream recovery
is behind the flag `stream-recovery`, which is off by default. It is not done until it has been used on at least one
real stream with no high-severity feedback. Branch `live/stream-restart`. Proposed decisions D303 and D304 are at
the end of this file.

## 1. Stream recovery (proposed D303)

### What it does

The host can crash while live. The launcher (`services/studio-ui/launch.mjs`, `superviseHost`) already restarts the
host, reloads the project and starts the recording again in a new file. With the flag on, it now also starts the
stream sinks again, but only those that were live before the crash.

- **Authority.** The user's typed "yes, on air" on the control page is the only authority. The launcher is its only
  owner and keeps it in memory (`createLiveAuthority` in `stream-recovery.mjs`); see "Who may restart streams" below.
- **Session.** At every start, the launcher makes a new, unarmed authority and a random session id
  (`UJWALAM_LIVE_SESSION`). The id only tags this launcher's recovery events for the control page.
- **Which streams.** The launcher restarts the stream sinks that its last `outputs.status` poll saw as
  `starting`, `live` or `retrying` before the crash. It never starts a sink that was not live. It calls
  `stream.start { sinks: [...] }` and then waits up to `startCheckMs` for each sink to report active.
- **Conditions.** All of these must hold:
  - the flag is on;
  - the launcher's authority is armed, and the sink was not stopped on purpose by the live-test guard;
  - the project reloaded into the restarted host;
  - the restarted host was ready within `maxGapMs` of the crash;
  - fewer than `maxRecoveries` stream recoveries happened in `windowMs`.
- **Repeated crashes.** When the limit is reached, the streams stay off and the authority is revoked (`recovery-limit`). The page says:
  "Host crashed at hh:mm again (N stream restart(s) already in M min): streams NOT restarted: ... Check the host log
  before going live again." When the host restart policy itself gives up (3 restarts in 5 min), the event says so
  (reason `host-gave-up`).
- **Visibility.** Each decision is logged to the launcher console and the crash log, and added to the restart
  marker note (`streams restarted: ...; streams to restart by hand: ...`). It is also written as one event to
  `<data dir>/live/stream-recovery.json` (the last 20 events; labels and plain text only, no keys and no URLs). The
  control page shows the newest event of this session as a pill next to the host state: `ok` when everything
  restarted, `warn` otherwise. The pill uses safe DOM (`textContent`).
- **Limits.** All limits are in `data/live/recovery.json` (`status: proposed`), with a source note per value:

  | Setting | Value |
  |---|---|
  | `maxRecoveries` | 2 |
  | `windowMs` | 600000 |
  | `maxGapMs` | 90000 |
  | `startCheckMs` | 15000 |
  | `pollMs` | 500 |

### Who may restart streams (final design, after the Codex review)

A second-opinion review (Codex) of the first version (`87649bb`) found three HIGH issues. In that version, the UI
server wrote an intent file and the launcher read it:

1. If writing `armed: false` failed, the old `armed: true` file stayed, and a later crash restarted streams the user
   had stopped.
2. A slow Start armed the intent after its host call returned, so it could arm after a newer Stop had disarmed it.
3. The launcher read "armed", then called `stream.start`. A Stop could reach the restarted host in between, and the
   recovery start then undid it.

The final design has one owner and one serialized authority:

- **One owner, in memory.** The launcher owns the go-live authority: a generation number, armed or not, a reason, a
  closed flag and the sinks the guard stopped. No file is read for a decision. `<data dir>/live/stream-authority.json`
  is a mirror for people and tests only, written by the launcher and never read back.
- **One channel.** The launcher starts the UI server with a Node IPC channel (`stdio: [..., 'ipc']`) and answers on
  it (`serveAuthority`). The UI server uses it through `authorityClient`, only when the launcher started it (parent
  pipe and session id present). The channel offers three requests:
  - `begin` is sent before a confirmed `stream.start` goes to the host. It returns the current generation `g`.
  - `arm(g)` is sent after the host accepted that start. It arms only if `g` is still the current generation. Any
    revoke since `begin` raised it, so a newer Stop always wins over a slow Start (issue 2).
  - `revoke(reason)` is sent before a confirmed Stop or End all goes to the host, and the UI server waits for the
    answer. The generation goes up and the authority is disarmed at once. The answer comes only after any recovery
    start in flight has returned, so the user's stop reaches the host after it and wins (issue 3).
- **Serialized recovery.** The decision and the `stream.start` run together in the authority's serialized section
  (`authority.run`). If a revoke arrived while that start was on its way, the launcher sends `stream.stop` for those
  sinks itself as soon as the start returns. The event reads "streams started again, then stopped because you
  pressed Stop or End all". This also covers a revoke that timed out (below), when the user's stop may have gone out
  first.
- **Fail closed (issue 1).** There is no file left to fail. If the launcher does not answer a revoke within 10 s, the
  UI server closes the IPC channel, and the user's stop still goes to the host at once. When the channel closes, or
  the UI server exits, the launcher closes the authority for the rest of its session (`ui-link-lost`):
  - every later `begin` and `arm` is refused;
  - a crash then restarts nothing, and the page gives the reason (`authority-lost`).
- **Live-test guard.** The launcher's own live-test guard (`runGuard`, `onStop`) acts before it sends a stop:
  - before a per-sink time-limit stop, it excludes those sinks from recovery until the next confirmed start;
  - before it stops everything, it revokes the authority.

### Why a launcher restart never goes live by itself

When the launcher exits, the host and every stream end with it. A new launcher has a new authority, which is unarmed
(generation 0, reason `none`). Nothing an earlier launcher left on disk is read. The restart set comes only from
streams this launcher saw live.

Going live again after a full restart could happen hours later, from another context, or after the user decided to
stop. So a new broadcast always needs a new "yes, on air" (AGENTS.md: never go live on your own). Recovery covers
only the seconds-long gap inside one session that the user already put on air.

### Files

- New: `services/studio-ui/stream-recovery.mjs`. It holds:
  - the policy;
  - the authority (`createLiveAuthority`, `serveAuthority`, `authorityClient`, the mirror);
  - the status events and the event text;
  - the wait-for-active check.
- New: `data/live/recovery.json`.
- Changed: `services/studio-ui/launch.mjs`. It adds:
  - the authority and the session id;
  - the UI server's IPC channel;
  - the streams carried across a crash (the first crash time is kept across a "host not ready" attempt);
  - `recoverStreams` (serialized, with the stop after a cancelled start);
  - the guard's `onStop`;
  - the marker text and the crash-log fields `streamsRestarted` and `streamsByHand`.
- Changed: `services/studio-ui/live-guard.mjs`. Adds `onStop(sinks | null)` before each stop it sends.
- Changed: `services/studio-ui/server.mjs`. It calls `begin` and then `arm` around a confirmed start, and `revoke`
  before a confirmed Stop or End all. `recovery` is added to the status snapshot.
- Changed: `data/flags.json`. Adds `stream-recovery`, default `false`.
- Changed: `ui/index.html` and `ui/js/app.js`. Add the recovery pill.
- Changed: `tests/fixtures/studio-ui/fake-host.mjs`. It adds:
  - stream sinks, `stream.start` and `stream.stop`;
  - `UJWALAM_FAKE_HOST_STREAMS`, `UJWALAM_FAKE_HOST_STREAM_FAIL` and `UJWALAM_FAKE_HOST_CRASH_ON`;
  - `UJWALAM_FAKE_HOST_START_DELAY_MS`, a slow start that is logged as `stream.start.done` when it answers;
  - asynchronous method answers.
- New tests: `tests/stream-recovery.test.mjs` and `app/host/tests/host-stream-recovery.test.mjs`.

### Tests

Headless tests with the fake host go through the real launcher, UI server and confirm flow (scripted login, no
window):

```
UJWALAM_HEADLESS=1 node --test --test-concurrency=1 tests/stream-recovery.test.mjs
ℹ tests 14   ℹ pass 14   ℹ fail 0   (after the authority redesign)
UJWALAM_HEADLESS=1 node --test --test-concurrency=2 tests/live-guard.test.mjs tests/studio-ui-alpha.test.mjs \
  tests/studio-ui-crash-recovery.test.mjs tests/studio-ui-live-test.test.mjs tests/studio-ui-readiness.test.mjs \
  tests/studio-ui-server.test.mjs tests/studio-ui-flags-feedback.test.mjs tests/studio-qt-shell.test.mjs \
  tests/studio-tasks.test.mjs tests/package-alpha.test.mjs tests/project-structure.test.mjs tests/record-clips.test.mjs
ℹ tests 186   ℹ pass 183   ℹ fail 0   ℹ skipped 3   (skips: no Qt shell, package or venv build in this worktree)
```

`tests/stream-recovery.test.mjs` has 14 tests.

- **Unit tests:**
  - config checks;
  - the flag is off by default;
  - sink labels;
  - status events per session and the event texts;
  - `waitStreamsUp`.
- **Each decision reason,** with a fake clock: none-live, flag-off, no-confirmation, stopped (including sinks
  excluded by the guard), limit-earlier, authority-lost, too-late, limit and restart.
- **The authority:**
  - **Race 2:** a start begun before a Stop does not arm afterwards.
  - **Race 3:** a revoke during a run disarms at once but is answered only after the run; the run reports that it
    was overtaken.
  - A guard exclusion lasts until the next confirmed start.
  - Once closed, the authority stays closed.
- **The authority over IPC,** with two fake processes joined like the launcher and the UI server:
  - `begin`, `arm` and `revoke` work end to end, and a stale `arm` is refused.
  - **Race 1:** the launcher does not answer a revoke. The UI server closes the channel, the authority is closed,
    and the decision becomes `authority-lost`.
  - The UI server exiting closes the authority.
- **Flag on (end to end):**
  - YouTube H, YouTube V and Twitch were live, and Kick had failed. After a crash, exactly youtube-h, youtube-v and
    twitch are restarted.
  - The recording resumes, the marker is written, and the page shows the restart.
  - After End all, a second crash restarts nothing.
- **Flag off:** nothing is restarted, and the page gives the reason.
- **Repeated crashes:** two recoveries, then the third crash gives `limit`. The authority mirror reads
  `armed: false, reason: recovery-limit`.
- **New launcher:** an armed authority mirror and an old `stream-intent.json` are left on disk. The new launcher
  shows generation 0, unarmed, and nothing goes live.
- **Race 2, end to end:** the fake host's start is slow (2.5 s). The user confirms Start, then Stop while the Start is
  in flight. The Start answers late, and the host turns the sinks live last, but the authority stays revoked. A crash
  then restarts nothing (reason `stopped`).
- **Race 3, end to end:** End all is confirmed while the recovery start (slow, 2.5 s) is in flight on the restarted
  host. In the host's call log, every `stream.stop` comes after `stream.start.done`: the launcher's own stop of the
  restarted sinks and End all's stop. The event is `cancelled`, and End all reports that every stream stopped.

The real-host test uses the real libobs host. The only network targets are loopback listeners:
`app/host/tests/host-stream-recovery.test.mjs`, part of `npm run test:host`.

- **Setup:**
  - one 640x360 NVENC rung feeds an RTMP sink to an ffmpeg listener on 127.0.0.1, plus an .mkv recording;
  - the stream and the recording are started through the page's confirm flow ("yes" and "yes, on air");
  - the host pid is killed (exit 1).
- **Checks:**
  - a second listener receives the restarted stream (ffprobe: h264 640x360, more than 30 packets);
  - the page status matches `Host crashed at hh:mm, streams restarted: Twitch`;
  - there are two recording files, the cut one and a new one.

```
UJWALAM_HEADLESS=1 UJWALAM_HOST_EXE=C:/AI/Claude/Ujwalam/out/host/build/ujwalam-host.exe \
  node --test --test-concurrency=1 app/host/tests/host-stream-recovery.test.mjs
[studio] HOST EXITED UNEXPECTEDLY (code 1); restart 1 of 3 in 2500 ms; recording was on (rec-h); streams were on (twitch)
[studio] recording started again in a new file (rec-h)
[studio] Host crashed at 08:07, streams restarted: Twitch
# recordings: recovery-rec-h-20261109-080702.mkv, recovery-rec-h-20261109-080710.mkv
ℹ tests 1   ℹ pass 1   ℹ fail 0
```

This output is from the rerun after the authority redesign, with the UI server on its IPC channel. This worktree has
no `out/` host build, so the test ran against the host binary built on 2026-11-08 in the main
checkout. The host's C++ code is unchanged on this branch. After the test, no `ujwalam-host` or `ffmpeg` process was
left running.

## 2. Match gate on the "while" clip path (proposed D304)

Before this change, `clipper.py live-review` (the clips made while recording, via `record-clips.mjs`) applied the
D286 match gate only when given a `--matches` file. The while path never passed one, so every save was kept.

- `record-clips.mjs` now passes `--recording <H recording> --threads 4` for review jobs that have an H recording.
- `clipper.py` adds `_live_matches`:
  - The gate is off in Settings: it returns no matches, so the old behaviour holds.
  - Otherwise it runs the detector pass on the recording (`cmd_detect`, unless hits already exist) and segments it
    into matches (`match_gate.segment`).
  - It decides each match (`match_gate.decide`) and stamps `startUtc`/`endUtc` from the recording start.
  - It writes `matches.json` (tool `clipper.live-review`). `gate_saves` then drops saves inside a match that is
    gated out.
  - Any error gives a reason and keeps every save (fail-open for clips, as in D286).
- With neither `--matches` nor `--recording`, the reason reads "no matches.json (--matches) and no recording
  (--recording): every save kept".

```
py -3 -m pytest -q tests/py/test_clip_live_review_gate.py
6 passed in 0.15s
```

The 6 tests cover:

- matches built from the stream's recording (stamped with UTC times);
- the gate off in Settings (nothing runs);
- a missing recording (every save kept);
- the parser accepting the detect options;
- live-review dropping saves in skipped matches;
- no recording given (every save kept, with the reason).

`tests/record-clips.test.mjs` asserts the review argv with and without the recording.

## Quick CI

```
node tools/ci.mjs --quick
build PASS, lint PASS, build-host PASS, validate-registry PASS, validate-outputs PASS, validate-games PASS,
private-scan PASS, legacy-verify PASS   ci: 8/8 passed in 11.6s (after the authority redesign)
```

The full CI was not run (per the task). `npm run test:host` now includes the new real-host test.

## UNVERIFIED and risks

- **Platform grace windows.** How long YouTube, Twitch and Kick keep a broadcast open after the ingest drops is not
  checked. `maxGapMs` (90 s) is a design value.
- **Limit values.** `maxRecoveries` (2 in 10 min), `windowMs` and `startCheckMs` are agent defaults, not yet
  approved by the user or tried on a real stream.
- **A sink that stops by itself.** A sink can end by itself (not stopped by the user or the guard) shortly before the
  host crashes, within one poll interval (`UJWALAM_HOST_WATCH_MS`, default 2 s). The last poll still showed it live,
  so it can be restarted. The user's Stop and End all, and the guard's stops, cannot be overtaken: they go through
  the authority first.
- **Revoke wait.** A Stop or End all waits for the launcher's answer: at most the length of a recovery
  `stream.start` that is in flight, and never more than 10 s. After 10 s, the stop goes out anyway and the authority
  closes for the session. The 10 s value is a design value.
- **Host ordering.** The host is assumed to apply a `stream.stop` received after a `stream.start` has returned as the
  later call. This is tested with the fake host and not checked on the real host under that race.
- **No restart after a failed reload.** When the project does not reload into the restarted host, no stream is
  restarted. This is by design, but untested on the real host.
- **Qt shell.** The Qt shell has no recovery display of its own. The status shows only on the web control page.
- **Detect pass cost.** The detector pass on the while path runs once per review job over the whole H recording,
  with 4 threads. `record-clips` runs one job at a time, at below-normal priority, and never while a stream is
  live. The runtime on a long recording is not measured.
- **Host binary.** The real-host test used the main checkout's 2026-11-08 host build, not a build from this
  worktree.
- **Real stream.** Nothing in this branch has been tried on a real stream.

## Proposed decision text

**D303 (2026-11-09) Stream recovery after a host crash.** Flag `stream-recovery` (off by default). When the host
crashes while live, the launcher restarts the host, reloads the project and starts the recording in a new file. It
then starts again exactly the stream sinks its last `outputs.status` poll saw starting, live or retrying, and only
when all of these hold: the launcher's go-live authority is armed and the sink was not stopped by the guard; the project reloaded; the host was ready
within `maxGapMs`; and fewer than `maxRecoveries` recoveries happened in `windowMs` (`data/live/recovery.json`,
proposed values 2 / 10 min / 90 s).

The launcher alone owns the go-live authority, in memory; nothing on disk is read for a decision. The UI server uses
it over the launcher's IPC channel:

- `begin` before a confirmed "yes, on air" start, and `arm(generation)` after the host accepted it; a Stop in between
  wins.
- `revoke` before a confirmed Stop or End all reaches the host. It takes effect at once, and its answer waits for any
  recovery start in flight.

The recovery decision and its `stream.start` run in one serialized section. If a revoke overtook the start, the
launcher stops those sinks again. A revoke without an answer within 10 s closes the channel, and a closed channel or
an exited UI server closes the authority for the session (fail closed). The live-test guard excludes the sinks it
stops and revokes before stopping everything. A new launcher starts with a new, unarmed authority, so a launcher
restart never goes live by itself.

Past the limit, the streams stay off, the authority is revoked (`recovery-limit`) and the page says to check the host
log. Every decision is logged, added to the restart marker and shown on the control page
(`<data>/live/stream-recovery.json`, no keys or URLs; `stream-authority.json` is a diagnostic mirror only). Platform
grace windows are UNVERIFIED. Evidence: docs/evidence/2026-11-09-stream-recovery.md.

**D304 (2026-11-09) Match gate on the "while" clip path.** `record-clips` live-review jobs pass the H recording to
`clipper.py live-review`. When the D286 match gate is on in Settings and no `--matches` file is given, live-review
runs the detector pass on the recording, segments and decides matches with `match_gate`, writes `matches.json` and
drops saves inside gated-out matches. A gate that is off, a missing recording or any error keeps every save, with a
reason. The runtime of the detect pass on a long recording is UNVERIFIED. Evidence: docs/evidence/2026-11-09-stream-recovery.md.
