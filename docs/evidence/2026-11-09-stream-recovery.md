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

- **Authority.** The user's typed "yes, on air" on the control page is the only authority. The UI server writes it
  to `<data dir>/live/stream-intent.json` as `{ v, session, armed, reason, at }`:
  - `armed: true` is written only after a confirmed `stream.start` that the host accepted.
  - `armed: false` is written before a confirmed `stream.stop` or End all reaches the host. A stop pressed while the
    host is down still counts.
  - The launcher writes `armed: false` with reason `recovery-limit` when the recovery limit is reached.
- **Session.** At every start, the launcher makes a random session id (`UJWALAM_LIVE_SESSION`, given to the UI server
  by environment). The launcher deletes the intent file at start and honours only an intent from its own session.
- **Which streams.** The launcher restarts the stream sinks that its last `outputs.status` poll saw as
  `starting`, `live` or `retrying` before the crash. It never starts a sink that was not live. It calls
  `stream.start { sinks: [...] }` and then waits up to `startCheckMs` for each sink to report active.
- **Conditions.** All of these must hold:
  - the flag is on;
  - this session's intent is armed;
  - the project reloaded into the restarted host;
  - the restarted host was ready within `maxGapMs` of the crash;
  - fewer than `maxRecoveries` stream recoveries happened in `windowMs`.
- **Repeated crashes.** When the limit is reached, the streams stay off and the intent is disarmed. The page says:
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

### Why a launcher restart never goes live by itself

When the launcher exits, the host and every stream end with it. A new launcher start is a new session:

- the intent file is deleted at start;
- an intent with an old session id is refused (`no-confirmation`);
- the restart set comes only from streams this launcher saw live.

Going live again after a full restart could happen hours later, from another context, or after the user decided to
stop. So a new broadcast always needs a new "yes, on air" (AGENTS.md: never go live on your own). Recovery covers
only the seconds-long gap inside one session that the user already put on air.

### Files

- New: `services/studio-ui/stream-recovery.mjs`. It holds the policy, the intent and status files, the event text
  and the wait-for-active check.
- New: `data/live/recovery.json`.
- Changed: `services/studio-ui/launch.mjs`. It adds the session id, clears the intent at start, and carries the
  streams across a crash (the first crash time is kept across a "host not ready" attempt). It adds
  `recoverStreams`, the marker text and the crash-log fields `streamsRestarted` and `streamsByHand`.
- Changed: `services/studio-ui/server.mjs`. It arms the intent after a confirmed start and disarms it before a
  confirmed stop or End all. `recovery` is added to the status snapshot.
- Changed: `data/flags.json`. Adds `stream-recovery`, default `false`.
- Changed: `ui/index.html` and `ui/js/app.js`. Add the recovery pill.
- Changed: `tests/fixtures/studio-ui/fake-host.mjs`. Adds stream sinks, `stream.start` and `stream.stop`,
  `UJWALAM_FAKE_HOST_STREAMS`, `UJWALAM_FAKE_HOST_STREAM_FAIL` and `UJWALAM_FAKE_HOST_CRASH_ON`.
- New tests: `tests/stream-recovery.test.mjs` and `app/host/tests/host-stream-recovery.test.mjs`.

### Tests

Headless tests with the fake host go through the real launcher, UI server and confirm flow (scripted login, no
window):

```
UJWALAM_HEADLESS=1 node --test --test-concurrency=1 tests/stream-recovery.test.mjs tests/record-clips.test.mjs
ℹ tests 23   ℹ pass 23   ℹ fail 0   ℹ skipped 0   (duration 38 s)
```

`tests/stream-recovery.test.mjs` has 10 tests:

- **Unit tests:**
  - config checks;
  - the flag is off by default;
  - sink labels;
  - each decision reason (none-live, flag-off, no-confirmation, stopped, too-late, limit, restart) with a fake clock;
  - the intent and status files (session filter, capped strings);
  - `waitStreamsUp`.
- **Flag on:**
  - YouTube H, YouTube V and Twitch were live, and Kick had failed. After a crash, exactly youtube-h, youtube-v and
    twitch are restarted; Kick is not.
  - The recording resumes, the marker is written, and the page shows "streams restarted: YouTube H, YouTube V,
    Twitch".
  - After End all, a second crash restarts nothing (reason `stopped`).
- **Flag off:** nothing is restarted, and the page gives the reason (feature flag).
- **Repeated crashes:** two recoveries, then the third crash gives `limit`. Nothing is restarted, and the intent
  becomes `armed: false, reason: recovery-limit`.
- **Stale intent:** an armed intent from an earlier launcher is deleted at launcher start.

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
[studio] Host crashed at 07:51, streams restarted: Twitch
# recordings: recovery-rec-h-<t1>.mkv, recovery-rec-h-<t2>.mkv
ℹ tests 1   ℹ pass 1   ℹ fail 0
```

This worktree has no `out/` host build, so the test ran against the host binary built on 2026-11-08 in the main
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
private-scan PASS, legacy-verify PASS   ci: 8/8 passed in 27.1s
```

The full CI was not run (per the task). `npm run test:host` now includes the new real-host test.

## UNVERIFIED and risks

- **Platform grace windows.** How long YouTube, Twitch and Kick keep a broadcast open after the ingest drops is not
  checked. `maxGapMs` (90 s) is a design value.
- **Limit values.** `maxRecoveries` (2 in 10 min), `windowMs` and `startCheckMs` are agent defaults, not yet
  approved by the user or tried on a real stream.
- **Per-sink stop race.** A sink can stop by itself, or through the live guard's per-sink `outputs.stop`, and the
  host can crash within one poll interval (`UJWALAM_HOST_WATCH_MS`, default 2 s). In that case the sink can still be
  restarted, because the intent covers all streams and the last poll still showed it live. The user's Stop and
  End all are not affected: they disarm the intent before the host call.
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
when all of these hold: this launcher session's "yes, on air" still stands; the project reloaded; the host was ready
within `maxGapMs`; and fewer than `maxRecoveries` recoveries happened in `windowMs` (`data/live/recovery.json`,
proposed values 2 / 10 min / 90 s).

The authority is the intent file `<data>/live/stream-intent.json`, written by the UI server: it is armed after a
confirmed start the host accepted, and disarmed before a confirmed Stop or End all reaches the host. It carries the
launcher's random session id, and the launcher deletes it at start, so a launcher restart never goes live by itself.
Past the limit, the streams stay off, the intent is disarmed (`recovery-limit`) and the page says to check the host
log. Every decision is logged, added to the restart marker and shown on the control page
(`<data>/live/stream-recovery.json`, no keys or URLs). Platform grace windows are UNVERIFIED. Evidence:
docs/evidence/2026-11-09-stream-recovery.md.

**D304 (2026-11-09) Match gate on the "while" clip path.** `record-clips` live-review jobs pass the H recording to
`clipper.py live-review`. When the D286 match gate is on in Settings and no `--matches` file is given, live-review
runs the detector pass on the recording, segments and decides matches with `match_gate`, writes `matches.json` and
drops saves inside gated-out matches. A gate that is off, a missing recording or any error keeps every save, with a
reason. The runtime of the detect pass on a long recording is UNVERIFIED. Evidence: docs/evidence/2026-11-09-stream-recovery.md.
