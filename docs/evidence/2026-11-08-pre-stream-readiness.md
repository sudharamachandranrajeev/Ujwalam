# Pre-stream readiness check and End all streams (2026-11-08)

Result: **PASS (tests and a smoke run) — awaiting live test.** The feature is behind the flag `readiness` (off by
default). It is not done until it has been used before at least one real stream with no high-severity feedback.

Decision text proposed as D299 (see the end of this file). Branch `live/readiness`.

## What was built

1. **"Ready to go live?"** — `services/studio-ui/readiness.mjs` plus `GET /ui/api/readiness` in
   `services/studio-ui/server.mjs`. Ten items, each `pass` / `warn` / `fail` with a plain-English message:

   | Item | What it checks | Fails when | Warns when |
   |---|---|---|---|
   | host | studio host connected, outputs set up, stream outputs present, live or loopback targets | stand-in (fake) host, host down, no outputs, no stream outputs | streams go to loopback test targets (no `--live`) |
   | credentials | per configured live stream sink: `keyPresent` / `urlPresent` from the host's `outputs.status`; for a sink with a server address in Credential Manager (`twitch-server`, `kick-server`) the address is read in memory and only its scheme is compared with the sink's transport (rtmp vs rtmps) | key or address missing, scheme differs (the known `twitch-server` rtmp:// issue) | Twitch bandwidth test on, an address could not be read |
   | | not live-configured: the live plan `data/outputs/alpha-live.json` targets are checked for presence directly | never (warn only without `--live`) | key or address missing, wrong scheme, key with a `?` ending |
   | disk | free space on the drive of the host's recordings folder (`host.info recordingsDir`, else the data folder) | below `disk.failBelowGB` | below `disk.warnBelowGB` |
   | encoders | other streaming apps by process image name (tasklist, no console window) | an app with severity `fail` (Meld, OBS) | an app with severity `warn` (Streamlabs, XSplit) |
   | streamerbot | event core's Streamer.bot connection state (`core.status`), else a TCP check of the profile's port | never | not connected / not answering |
   | speakerbot | TCP check of the profile's port (sends nothing) | never | not answering |
   | loopback | newest full-CI pass stamp (`tools/ci-stamp.mjs`; the full CI's `test-host` runs the loopback output tests with ffprobe) | never | no stamp, or older than `loopback.maxAgeDays` |
   | clips | `clipTools` (clip root + `.venv-gpu`/`.venv` + clipper.py), flag `live-clips` state | never | clip maker missing |
   | audio | pluggable: host method `audio.method` (assumed `audio.status`) when it exists; muted sources in the stream mix (`mixer.list`) | a source in `audio.failStates` | host has no audio-state call yet ("unknown"), a source in `audio.warnStates`, muted sources |
   | gpu | `host.info` adapter name and Windows graphics preference of the host exe | adapter does not match `gpu.adapterPattern` (NVIDIA) | NVIDIA but no High performance preference stored |

   Every threshold, name and timeout is in **`data/live/readiness.json`** (each section has a `source`; `status:
   proposed`). Each check runs in parallel with its own timeout; a check that throws or hangs becomes a warning that
   says so. The smoke run below took 1.2 s.

2. **Go-live flow.** With the flag on, `POST /ui/api/host {method: "stream.start"}` runs the check (a result younger
   than `goLiveMaxAgeMs` is reused) and puts it into the typed-confirmation record. The summary text starts with
   "Start the stream." and lists every warning and problem; the control page also shows the items as a list in the
   confirm window and in a "Ready to go live?" panel (Check now button). **Failures block**: the phrase becomes
   `yes, on air, override` instead of `yes, on air`, so "yes, on air" alone is refused. Confirming with the override
   phrase appends one line to `<data dir>/logs/readiness-overrides.jsonl` with the time and the failed / warned item
   ids only (no messages, no keys, no addresses). Warnings never change the phrase. If the check cannot run at all the
   start is refused (fail closed) with a hint that switching the flag off bypasses it.
   **Qt studio:** no C++ change was needed. The Qt shell already shows the server's `summary` and `phrase` in its
   confirm window (`MainWindow::confirm`), so the readiness list and the override phrase appear there too. A separate
   Qt readiness panel was not built (it would need C++ in `app/studio`).

3. **End all streams.** `POST /ui/api/streams/end-all` (typed "yes", "yes, on air" while live), then the host's
   existing `stream.stop {}`: with no sink ids the host selects every sink of kind `stream` (`Outputs::select`), sets
   `want = false` (no retry) and calls `obs_output_stop`, which closes each connection. Both YouTube outputs, Twitch and
   Kick stop; the recording sink is kind `record` and is not touched. The server then polls `outputs.status` until no
   stream sink is starting / live / retrying / stopping, or `endAll.waitMs` passes, and answers `{ allStopped, sinks:
   [{id, platform, state}], recording }`. The control page shows an **End all streams** button while live. Qt: the
   existing "Stop stream" button already calls the same `stream.stop {}` (every stream sink, recording keeps running);
   no new Qt button.

4. **Flag decision.** `readiness` is a new feature: flag, off by default, switchable from the control page (data/flags.json).
   End all streams has **no flag**: it adds no new stop behaviour (it is the host's existing `stream.stop {}`, the same
   call as the Stop stream button) plus a read-only check of the result; hiding a stop control behind an off-by-default
   flag would make the safe action harder to reach. It keeps the normal typed confirmation of a studio write.

## Commands and output

```
UJWALAM_HEADLESS=1 node --test --test-timeout=60000 tests/studio-ui-readiness.test.mjs
ℹ tests 26
ℹ suites 5
ℹ pass 26
ℹ fail 0
```

Covered: config loads and nothing is hardcoded; malformed config refused; all-pass; twitch-server rtmp:// vs rtmps://
fails and the stored address never appears in the result; missing key / address fails; bandwidth test warns; no
`--live` = host warns and the plan's keys are checked (warn only, `?` ending and scheme reported, key never in the
result); fake host and no stream outputs fail; disk fail / warn / pass at the data-file thresholds; Meld / OBS fail,
Streamlabs warns; bots only warn; CI stamp missing or old warns; clip maker missing warns; audio unknown (no host
method) warns with `unknown: true`, a missing source fails, a muted mix source warns, a plugged-in `audioCheck`
replaces the default; GPU not NVIDIA fails, no preference warns; a hanging or throwing check becomes a warning;
`credentialFacts` returns facts only; override log holds ids only; result caching. Server: flag off = route 404 and
plain "yes, on air"; route returns items; a failure refuses "yes, on air" and accepts the override (stream.start
called, one log line, failed ids only); warnings only = "yes, on air", no log; a check that cannot run refuses
go-live (503); End all while live = "yes, on air", exactly one `stream.stop {}`, waits for stopped, recording
reported running, no `record.stop` / `outputs.stop`, no credential target name in the answer; a sink that does not
stop in time is reported; extra body fields refused; not live = plain "yes", works without the readiness flag.

```
UJWALAM_HEADLESS=1 node --test --test-timeout=300000 "tests/studio-ui-*.test.mjs"
ℹ tests 162
ℹ pass 161
ℹ fail 0
ℹ skipped 1   (face worker test: no .venv-gpu in this worktree; unrelated)

UJWALAM_HEADLESS=1 node --test tests/flags.test.mjs tests/studio-qt-shell.test.mjs tests/guide.test.mjs (with the above)
ℹ tests 111   ℹ pass 111   ℹ fail 0

UJWALAM_HEADLESS=1 node tools/ci.mjs --quick
build              PASS
lint               PASS
build-host         PASS
validate-registry  PASS
validate-outputs   PASS
validate-games     PASS
private-scan       PASS
legacy-verify      PASS
ci: 8/8 passed in 61.5s
```

Smoke run on the laptop with the real probes (tasklist, disk, CI stamp, TCP to the bot ports, clip tools) and **the
credential store stubbed** (nothing read from Credential Manager), no host running:

```
fail host         The studio host does not answer.
warn credentials  Not started with --live, so these are the live plan's keys: ... stream key not set. (stub)
pass disk         293.2 GB free on C:\.
pass encoders     No other streaming app is running.
warn streamerbot  Streamer.bot does not answer. Chat feedback, alerts and Kick need it.
warn speakerbot   Speaker.bot does not answer: the spoken test announcement will not play.
pass loopback     Last full CI pass (loopback ffprobe tests) 4 h ago.
pass clips        Clip maker ready. Live clipping is off.
warn audio        (before the host-down message was added: "The check could not run.")
warn gpu          The host does not report its GPU.
counts {"pass":4,"warn":5,"fail":1} ok false ms 1188
```

## Not checked / UNVERIFIED

- **Audio item: unknown.** The host's per-source live audio state call is being added in `app/host` by another change
  (not touched here). The method name `audio.status` and the shape `{ sources: [{ id, name, state }] }` are
  assumptions in `data/live/readiness.json`; until the host has it the item warns "unknown". TODO: when that RPC lands,
  set `audio.method`, `failStates` and `warnStates` to its real names (or plug a different `audioCheck`) and add a test
  against its real output.
- Credential reads against the real Credential Manager were **not** run (the smoke stubbed the store). The real path
  is `createCredentialStore(ref).get()` (the existing helper, PowerShell child with `windowsHide`), used only for the
  server address scheme of live sinks with a `urlRef`, and for presence when not live-configured. UNVERIFIED on the
  laptop.
- Process image names: `MeldStudio*` (prefix, as in `tools/soak/stream-day.mjs`) and `obs64.exe` are UNVERIFIED on
  this PC; Streamlabs / XSplit prefixes are UNVERIFIED.
- The loopback item reads the full-CI stamp, which shows that the full CI (including the host's loopback output tests
  with ffprobe) passed on some tree on this PC; it does not prove the currently built host passed. An installed copy
  without git always warns here.
- Disk thresholds (22 GB fail / 44 GB warn, 11 GB/h) are derived from the preset bitrates, not approved by the user.
- GPU preference value 2 = High performance (Windows `UserGpuPreferences` format) — as read by the host's
  `stats::gpu_preference`; not re-verified here.
- The control page and the Qt confirm window were not opened (headless only). The Qt path needs no rebuild (no C++
  changed) but was not exercised against a running shell.
- No real stream: End all streams was tested against a fake host only; the real host's `stream.stop {}` behaviour is
  read from `app/host/src/outputs.cpp` (`select`, `stop`), not run here.

## Proposed decision text (D299)

> **D299 (proposed, 2026-11-08): Pre-stream readiness and End all streams.** Before going live the studio runs a
> "Ready to go live?" check (flag `readiness`, off by default): host and outputs, stream keys present per live sink and
> the server-address scheme (rtmp vs rtmps; only the scheme is ever reported), disk space, other streaming apps,
> Streamer.bot and Speaker.bot, last loopback test (full-CI stamp), clip maker, audio sources (pluggable; "unknown"
> until the host reports live audio state) and the NVIDIA GPU pin. Thresholds live in `data/live/readiness.json`.
> Start stream shows the result in the typed confirmation (control page and Qt). A failed item blocks going live unless
> the user types `yes, on air, override`; each override is logged with item ids only to
> `<data dir>/logs/readiness-overrides.jsonl`. Warnings never block. A check that cannot run refuses go-live while the
> flag is on. "End all streams" (control page; Qt's Stop stream is the same call) stops every stream sink with the
> host's existing `stream.stop {}`, waits until each reports stopped and leaves the recording running; it has no flag
> because it adds no new stop behaviour, and it keeps the normal typed confirmation.

## Files

Created: `services/studio-ui/readiness.mjs`, `data/live/readiness.json`, `tests/studio-ui-readiness.test.mjs`,
this file. Changed: `services/studio-ui/server.mjs`, `data/flags.json`, `ui/index.html`, `ui/js/app.js`,
`ui/js/api.js`, `ui/css/app.css`.
