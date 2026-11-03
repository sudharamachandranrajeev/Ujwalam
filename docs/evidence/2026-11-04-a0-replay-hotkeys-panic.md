# A0 day 2: replay buffer, global hotkeys, panic, markers, feedback capture

Date: 2026-11-04 (runs made 2026-11-03, local).
Result: PASS for the loopback and test-card checks below. **Awaiting live test**: nothing here ran on a real stream.

Scope: alpha plan Part A items 6-8 and Part B "Capturing feedback"; panic contract in
`services/event-core/api/panic.mjs` (lines 9-21); output graph rule (sinks and replays bind to rungs, audio encoded once).

## What was built

| Item | Where | Entry points |
| --- | --- | --- |
| Replay buffer H and V | `app/host/src/replay.cpp`, `outputs.h/.cpp` | `replay.start {seconds?}`, `replay.stop`, `replay.status`, `replay.save {canvas?}` |
| Global hotkeys | `app/host/src/hotkeys.h/.cpp` | `hotkeys.status`; `hotkeys.trigger {name}` only with `--test-hooks` |
| Panic | `app/host/src/panic.h/.cpp`, `studio.cpp` | hotkey `panic`; `panic.now`, `panic.status`, `panic.clear` |
| Markers | `app/host/src/moments.h/.cpp` | hotkey `marker`; `marker.add {source: hotkey\|chat\|audio\|api, note?}` |
| Feedback capture | `app/host/src/moments.h/.cpp` | hotkey `feedback`; `feedback.capture {note?}`, `feedback.status` |
| Host config | `app/host/src/host_config.h/.cpp` | `--host-config <file.json>` |

### Replay buffer

- A libobs `replay_buffer` output per canvas. It binds to the canvas's largest created rung (w x h, then bitrate) and the shared AAC encoder, so it adds no encoder.
- When a canvas has no rung, the host builds a record-less **fallback rung** for that canvas only. The defaults are NVENC H.264 CBR, H 12000 / V 8000 kbps (`replay.fallbackKbps`), with x264 if NVENC is missing, plus one fallback AAC at 160 kbps. `replay.status` reports `fallback: true`.
- Every output-graph change (`outputs.configure`, `reconfigure`, `clear`, project load) detaches the replays and attaches them again to the new graph. The buffer restarts empty after any graph change.
- `replay.save` writes `<recordings>/replay/replay-<H|V>-<YYYYMMDD-HHMMSS>.mkv`. It waits for libobs' `saved` signal (10 s timeout) without holding the graph lock.
- The default length is 30 s; the configured range is 5..600 s. A new length restarts the buffer.
- In a bare host the replay is off until `replay.start`. `replay.autoStart: true` in the host config starts it at boot. It works whether or not a stream is running.

### Global hotkeys

- `RegisterHotKey` with `MOD_NOREPEAT` on its own message-loop thread.
- Defaults: panic Ctrl+Alt+P, feedback Ctrl+Alt+F (D136), marker Ctrl+Alt+M. Each is configurable, or `null` to unbind.
- A combo that is taken or invalid is logged and reported in `host.info.hotkeys` and `hotkeys.status`. The host keeps running.
- Off unless `hotkeys.enabled: true` in the host config, so tests and bare hosts never take the user's keys.

### Panic

The host acts in-process first:

1. Hide every visible browser layer.
2. Refuse `effect.fire` with `{ok:false, reason:"panic"}`.
3. Leave outputs and audio untouched.

Then a sender thread sends `actions.panic` over the event-core **system pipe**:

- The pipe name comes from the owner-only `system.json`, set by host config `eventCore.systemFile`.
- The token is read from `UJWALAM_EVENT_CORE_SYSTEM_TOKEN`.
- It makes up to 5 attempts, 50/100/200/400 ms apart, only on refused or reset connects. A missing `system.json` counts as refused.

`panic.clear` restores the hidden layers only. Event-core's own panic is cleared in event-core.

### Markers

`<markersDir>/<session>.jsonl` gets one JSON line per marker:

```
{"v":1,"at":"…Z","source":"hotkey","note"?:…,"hostMs":…,"streamMs":…|null,"recordMs":…|null,"scenes":{"H":…,"V":…}}
```

- `session` is the host start stamp (local `YYYYMMDD-HHMMSS`).
- `streamMs` counts from the first stream sink going live, and `recordMs` from the first recording.
- Notes are capped at 500 bytes. Control characters become spaces, and the note is stored as data only.
- The hotkey source is wired now. Chat and audio are API entry points only; no caller exists yet.

### Feedback capture

The capture writes to `<feedbackDir>/<YYYY-MM-DD>/<HHMMSS>[-n]/`. `feedbackDir` comes from the host config and defaults to `<dataDir>/feedback`.

- `log.txt`: the last 200 lines from the D144 ring, which redacts 32+ hex runs. Multi-line libobs entries are split into lines first.
- `moment.json` holds:
  - `at`, `local`, `trigger`, `version`, `session`
  - active scene per canvas
  - `stats` (cpuPct, gpuPct, droppedFrames, totalFrames, fps, renderLagged/Total, encodeSkipped/Total, avgFrameTimeMs, streamMs, recordMs)
  - the full `host.status`
  - `replay`: pending, then done with file names only
  - `voiceNote: {done:false}`
- `replay-H.mkv` and `replay-V.mkv`: the last replay seconds. They are saved by a worker thread, and `moment.json` is rewritten when they are done.
- The voice note is **not done**.

## Commands and output

Pre-run check each time: no `ujwalam-host` process and NVENC sessions at 0.

```
tasklist | grep -i ujwalam-host        (no output)
nvidia-smi --query-gpu=encoder.stats.sessionCount --format=csv,noheader
0
```

### Day-2 suite

```
node app/host/tools/build.mjs
node --test --test-timeout=300000 app/host/tests/host-a0-day2.test.mjs
```

```
✔ host.info: config, session, hotkeys off but listed, test hooks on
replay fallback H: {"durationSec":4.095,"w":1920,"h":1080,"fps":59.99508237029752,"kbps":6024}
replay fallback V: {"durationSec":4.05,"w":1080,"h":1920,"fps":59.75700471113315,"kbps":4093}
✔ replay: refused before start, then H and V on fallback rungs, replay.save writes playable mkv
replay on rung h1: {"durationSec":5.119,"w":1920,"h":1080,"fps":60.00000000000001,"kbps":8027}; recording {"durationSec":3.455,"w":1920,"h":1080,"fps":60.00582580833091,"kbps":8040}
✔ replay: binds to the configured rungs (no extra encoder), shares the encoder with a recording, follows clear
✔ markers: api, chat and hotkey sources append JSON lines with stream-relative time
✔ feedback: the hotkey handler writes moment.json, log.txt and the last replay H and V into feedback/<date>/<time>/
✔ panic: in-process first (browser layers hidden, effects refused), event-core retries then is told over the system pipe
✔ hotkeys.trigger: unknown name and bad params are refused
SKIP: key injection is opt-in (UJWALAM_HOTKEY_INJECT=1); WM_HOTKEY delivery not exercised in this run
✔ second host: real RegisterHotKey, a taken combo and a bad combo are reported, not fatal; no --test-hooks = no trigger
✔ host config: unknown keys and bad values stop the host with exit 64
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

What the suite checks:

- **Fallback replays:** ffprobe on the saved mkv files. The 10 s test buffer had about 4 s of content.
- **Rung binding:** three rungs (h1 1080p60 8000, h2 720p30 3000, v1 1080x1920 6000). The replays bind to h1 and v1.
- **NVENC sessions:** NVML reports **2** with the replays bound, and still 2 with a recording on h1. No extra encoder was created.
- **Shared encoder:** the replay saved during the recording has the rung's bitrate (8027 kbps against 8040 kbps for the recording).
- **Clear:** after `outputs.clear` the replays go back to the fallback rungs.
- **Markers:** api, chat and hotkey lines, control characters removed, `streamMs: null` when not streaming, scenes `card-h`/`card-v`, bad params give -32602.
- **Feedback:**
  - The folder name matches `YYYY-MM-DD/HHMMSS`.
  - It contains exactly `log.txt`, `moment.json`, `replay-H.mkv` and `replay-V.mkv`. Both clips pass ffprobe.
  - `log.txt` has 10..200 lines, with no 32+ hex run and no event-core token.
  - `moment.json` holds file names only.
- **Panic, event-core down:**
  - The browser layer is hidden in-process.
  - `panic.now` returns in under 1.5 s.
  - `effect.fire` is refused with reason `panic`.
  - The core notification ends `send-failed` after 5 attempts.
- **Panic, event-core up:** the real event-core is started with `startService`, which has the owner-only DACL pipe. The next panic gives `panic-engaged`, and the one after gives `already-panic`.
- **Second host:**
  - Real `RegisterHotKey`. A combo the first binding already holds is reported "already registered". A null binding is skipped.
  - Without `--test-hooks`, `hotkeys.trigger` returns -32001.
  - A third host with bad combos reports them and keeps running.
- **Bad host config:** unknown keys or out-of-range values exit with code 64.

### Regression: all host tests

```
npm run test:host
```

```
ℹ tests 53
ℹ pass 48
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
```

The 5 skipped tests are `host-browser.test.mjs`. The worktree has no `legacy/` overlay root. They were run again against the main checkout's `legacy/`, read-only:

```
UJWALAM_OVERLAY_ROOT='C:\AI\Claude\Ujwalam\legacy' node --test --test-timeout=300000 app/host/tests/host-browser.test.mjs
```

```
✔ overlay server runs under the host: 127.0.0.1, not 8093, obs-browser loaded, no token in its environment
✔ effect.fire validates its input and reports the guards verdict
✔ project v1 overlay layer: URL via feedQuery, relay page, gg-burst draws on effect.fire and clears after
✔ overlay child restart: new pid, same ports, effect.fire UNAVAILABLE while down, recording unaffected, pages reconnect
✔ overlay ports: 8093 is refused before anything starts
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

### Lint

```
npm run lint
lint: 0 finding(s), 27 allow marker(s), in 2.5s
```

## Not checked / UNVERIFIED

- **Real stream:** awaiting live test. No replay, marker or feedback capture has run during a real stream. `streamMs` was not checked with a live stream sink.
- **WM_HOTKEY delivery from a real key press:** UNVERIFIED. Registration was checked against the real Win32 API; the press path ran through `hotkeys.trigger`. The opt-in check (`UJWALAM_HOTKEY_INJECT=1`, Ctrl+Alt+Shift+F21 through `keybd_event`) was not run, because it types into the user's desktop session.
- **Default combos on the user's desktop:** UNVERIFIED. Another app may already hold Ctrl+Alt+P, F or M. The host would report it, not fail.
- **Alpha launcher wiring:** not done. The launcher does not yet pass `--host-config` (hotkeys on, replay autostart 30 s, feedback at repo-root `feedback/`, event-core `system.json`) or the system token. This belongs to `services/studio-ui/launch.mjs`, and `tests/studio-ui-alpha.test.mjs` must be updated with it. Until then, the alpha host runs with hotkeys off and replay off.
- **Replay length after a graph change:** the buffer restarts empty, so a feedback capture right after `outputs.configure` holds less than the configured seconds.
- **Voice note:** not implemented.
- **Two NVENC sessions with V fallback plus H rung (mixed):** not measured separately. Only the all-fallback and all-rung cases were measured.
