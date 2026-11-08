# Game audio missing from recordings: root cause, fix, watchdog (D297 proposed)

Date: 2026-11-08. Result: PASS for the fix and the tests (headless, no device opened). The real-device check is
**awaiting the user's yes** (capture card + mic): UNVERIFIED on hardware.

## Symptom

Installed build alpha.8. In two host sessions the recording had the mic only; the game audio (`wasapi_input_capture`
`ujw:audio:aud-game` on the capture card's "HDMI/Line In" endpoint) was silent for the whole session. Same binary
worked in four other sessions the same day.

## Log evidence (`%LOCALAPPDATA%\Ujwalam\data\host\logs\`)

Failing, `host-2026-11-08T18-55-08.log`:

```
18:55:12.316Z error: RTWQ setup failed: RtwqLockSharedWorkQueue failed (0xC00D3E85)      <- the mic source
18:55:12.317Z debug: source 'ujw:audio:aud-game' (wasapi_input_capture) created
18:55:12.364Z info:  WASAPI: Device 'HDMI/Line In (...)' [48000 Hz] initialized (source: ujw:audio:aud-game)
18:55:12.475Z error: Could not requeue sample receive work
18:55:12.479Z info:  Device 'HDMI/Line In (...)' invalidated.  Retrying (source: ujw:audio:aud-game)
18:55:13.000Z info:  WASAPI: Device 'Microphone (...)' [48000 Hz] initialized (source: ujw:audio:aud-mic)
18:55:25.472Z info:  [host] rpc record.start role=api ok        (no further aud-game line until 19:45, end of log)
```

Failing, `host-2026-11-08T18-36-22.log`: the same `initialized` -> 75 ms -> `Could not requeue sample receive work` ->
`invalidated. Retrying` for aud-game, then for the mic
`[WASAPISource::TryInitialize]:[Microphone (...)] RtwqPutWaitingWorkItem failed: C00D36FF` and `failed to start`.
At exit: `WASAPI: Device 'Microphone (...)' Terminated` at 18:52:10.605, `obs_shutdown begin` at 18:52:11.621, and
the log ends there: no `obs_shutdown returned`, no `exit` (the process hung in shutdown).

Working sessions (13-23-50, 14-17-02, 16-28-07, 18-32-27): the same create order (dshow capture layers, then aud-mic,
aud-game, then the test-card placeholder `card-v` sources destroyed within ~50 ms) and no RTWQ error. The order is not
what differs.

HRESULTs (Windows SDK 10.0.26100 `um/Mferror.h`):

```
#define MF_E_INVALID_WORKQUEUE           _HRESULT_TYPEDEF_(0xC00D36FFL)
#define MF_E_SHUTDOWN                    _HRESULT_TYPEDEF_(0xC00D3E85L)
```

## Root cause (confidence: high for the mechanism; the component that shut RTWQ down is UNVERIFIED)

obs-studio 32.1.2 `plugins/win-wasapi/win-wasapi.cpp`:

- Constructor (l.347-401): if `GetModuleHandle(L"RTWorkQ.dll")` is non-null (Windows 10 1703+), capture runs as work
  items on the shared RTWQ queue from `RtwqLockSharedWorkQueue(L"Capture", ...)`; on failure it logs
  `RTWQ setup failed` and falls back to its own capture thread. The comment says "OBS will already load DLL on startup".
- The OBS frontend (`frontend/obs-main.cpp` l.913-918 and l.1058-1063) calls `RtwqStartup()` at program start and
  `RtwqShutdown()` at exit: it holds a process-lifetime reference on the RTWQ platform.
- **ujwalam-host never called RtwqStartup.** RTWorkQ.dll was loaded by some other in-process component (Media
  Foundation users start and stop the platform with their own startup/shutdown pairs). When the last such user shut
  down, the platform went down under win-wasapi: queues dead (`MF_E_SHUTDOWN` on lock, `MF_E_INVALID_WORKQUEUE` on put).
- `OnSampleReady` (l.1265-1283): the requeue fails -> `Could not requeue sample receive work` -> `invalidated. Retrying`
  -> `SetEvent(reconnectSignal)`.
- `ReconnectThread` (l.921-955) waits 3000 ms (`RECONNECT_INTERVAL`) and calls `Start()`, which is
  `rtwq_put_work_item(startCapture.GetQueueId(), ...)` (l.423-424) with **the return value ignored**. On the dead
  queue nothing runs, no log line, no further retry: the source is silent for good. That is the 25-minute gap.
- `Stop()` (l.430-456, from the destructor) waits `INFINITE` for `idleSignal`, which only the (dead) work items set.
  libobs destroys sources on one destruction thread and `obs_shutdown` waits for it (`libobs/obs-source.c` l.762,
  `obs.c` l.1381): the 18-36 exit hang.
- Intermittent because it depends on whether another component's platform reference drops to zero while the WASAPI
  sources run (timing of device-graph and source start-up/teardown around project.load). Which component it is was not
  identified (UNVERIFIED): no symbol trace was taken and no device was opened for this investigation.

Host code checked: `app/host/src/studio.cpp` creates each project device audio source once per load
(`load_model`, `obs_source_create` + `obs_set_output_source`), no double create/destroy, no second update; the host's
only COM use (`devices.cpp`, MTA on its own thread) does not touch MF/RTWQ.

## Fix

1. **Root cause** (`app/host/src/obs_runtime.cpp`): `obsrt::start` loads RTWorkQ.dll and calls `RtwqStartup` before
   `obs_startup` (so before win-wasapi loads); `obsrt::shutdown` calls `RtwqShutdown` after `obs_shutdown`. Same as the
   OBS frontend. Log: `RTWQ platform held for the process lifetime (RtwqStartup)`; `host.status.audioHealth.rtwqHeld`.
2. **Shutdown guard** (`obsrt::shutdown(guard_ms)`): if `obs_shutdown` does not return in `shutdownGuardMs`, the
   reason is logged and the process ends with exit code 9. Outputs are stopped and released before this point.
3. **Audio health watchdog** (`app/host/src/audio_health.{h,cpp}`, `Studio::audio_watch_tick`): every
   `checkIntervalMs` each project device audio source is checked for audio packets (libobs audio capture callback
   timestamp; WASAPI sends packets, silent ones too, every ~10 ms). No packet for `noDataMs` = missing: log warning,
   event, warning "<Name> audio missing"; then a fresh source with the same type, settings, volume, mute, tracks and
   monitoring is put on the same output channel, at most `maxRecreates` per source per load. The old source is parked
   (off the channel, out of every track, muted, renamed `...:stale-N`) and released only when the studio goes at exit,
   because destroying a source on a dead queue never returns. A new win-wasapi instance whose RTWQ lock fails falls
   back to its capture thread (as the mic did at 18:55:13), so the restart works even on a dead platform.
   Flag choice: **no feature flag**. It is pure resilience on the live path: it does nothing while audio flows and only
   acts on a source that is already delivering nothing; a flag that is off by default would leave the defence off.
   The switch and the numbers live in `data/audio/health.json` (`enabled` false = report only), copied by the launcher
   into the host config `audioHealth`; the host has no built-in numbers (without the key: watchdog off, receiving null).
4. **Readiness before going live**: `host.status.audioHealth` (`ok`, `warnings`, per source `state`
   ok|starting|missing|inactive|unknown, `receiving`, `lastDataMs`, `recreates`, `events`, `watchdog`, `rtwqHeld`);
   `mixer.list` rows gain `receiving` and `lastDataMs`. The UI server passes a trimmed view in the status snapshot,
   the control page shows an "Audio: OK" / "Game audio missing" pill, and the typed confirmation for
   `record.start` / `stream.start` ends with `WARNING: Game audio missing` when a source is missing (never blocks).

`data/audio/health.json` values (status unverified): `noDataMs` 5000 = win-wasapi's own 3000 ms retry + 2 s;
`checkIntervalMs` 1000; `maxRecreates` 3; `shutdownGuardMs` 20000 (clean shutdowns in today's logs took < 1 s).

## Tests (headless, `UJWALAM_HEADLESS=1`, no device opened)

`app/host/tests/host-audio-health.test.mjs` uses the host's test source type `ujw_test_audio` (only with
`--test-hooks`; RPC `audio.testAdd`, `audio.testStall`): 10 ms silent packets from a thread; a stalled instance sends
nothing, like the dead WASAPI source; a new instance sends again.

```
UJWALAM_HEADLESS=1 node --test --test-timeout=300000 app/host/tests/host-audio-health.test.mjs
✔ root cause fix: the host holds the RTWQ platform; no device sources = nothing to report
✔ readiness: a source that sends packets is ok and receiving (host.status audioHealth and mixer.list)
✔ watchdog: a source that stops sending is reported missing, recreated on the same channel, and recovers
✔ watchdog: after maxRecreates it gives up and the "Game audio missing" warning stays
✔ report only (enabled false) never recreates; no config = receiving unknown; test methods need --test-hooks
✔ host config: bad audioHealth values stop the host with exit 64
ℹ tests 6  ℹ pass 6  ℹ fail 0
```

```
node --test tests/studio-ui-server.test.mjs tests/studio-ui-alpha.test.mjs
ℹ tests 65  ℹ pass 64  ℹ fail 0  ℹ skipped 1   (the face-worker test: no face venv in this worktree)
```

Runs:

```
UJWALAM_HEADLESS=1 npm run test:host          (concurrency 2)
ℹ tests 131  ℹ pass 116  ℹ fail 5  ℹ skipped 10
```

The 5 failures (host-a0-day2: replay binds / feedback / panic, a 30 s timeout under load; host-face: generation) all
pass when their files are run alone with the same exe:

```
UJWALAM_HEADLESS=1 node --test --test-timeout=300000 app/host/tests/host-a0-day2.test.mjs   -> 10 pass, 0 fail
UJWALAM_HEADLESS=1 node --test --test-timeout=300000 app/host/tests/host-face.test.mjs      -> 3 pass, 0 fail, 8 skipped
node --test tests/package-alpha.test.mjs                                                    -> 12 pass, 0 fail
node tools/ci.mjs --quick                                                                   -> ci: 8/8 passed
```

Timing flakes under parallel load, not caused by this change (UNVERIFIED against a run of the old exe in parallel).

## Not checked (UNVERIFIED)

- The real capture card and mic with the fixed host (needs the user's yes; no device was opened).
- Which in-process component shut the RTWQ platform down; whether holding the reference alone prevents every case
  (the watchdog covers the rest).
- The watchdog against a real dead WASAPI source (only the fake source was used); that the parked dead source's
  destroy blocks at exit is inferred from the source code and the 18-36 log, and the guard then ends the process.
- Layer audio (the capture card's dshow audio, media files) is reported in `mixer.list` but never restarted.
- The Qt studio shell does not show the warning yet (control page only).
