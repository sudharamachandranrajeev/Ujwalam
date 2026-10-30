# v1 host day 3: browser layers, overlay server child, effect.fire, O2 shared encoders (2026-10-30)

Agent C (libobs host + outputs). Run on 2026-10-29 local time. No devices, no event core, no real Streamer.bot, no
real platform, no stream key. Paths are written as `<repo>`.

Result: **PASS** for every item below, with one O2 run that FAILED for an outside reason and was re-run (see O2,
run 1). UNVERIFIED items are listed at the end.

| Item | Result | Evidence |
|---|---|---|
| devices.list gated behind `--allow-devices` (D38) | PASS | host-project tests below |
| obs-browser (tier B) loads with `--allow-browser`; browser layers build | PASS | host-browser test 1, 3 |
| Overlay server runs as a child of the host (job object, allowlisted env, restart with backoff, pinned ports) | PASS | host-browser test 1, 4 |
| Layer URLs built with `feedQuery(feedPort, scope)`; the host loads only its own overlay URLs | PASS | host-browser test 3 |
| `effect.fire` -> `bridge.publishEffect` (A's guards on) | PASS | host-browser test 2, 3 |
| gg-burst fires through the relay page (BroadcastChannel in CEF) | PASS | host-browser test 3, 4 |
| No token reaches a browser layer | PASS | host-browser test 1, 3 |
| 8093 refused for both overlay servers | PASS | host-browser test 5 |
| O2: H / V / Multi shared encoders, loopback ffprobe | PASS (run 2: 52/52) | O2 section |

## Build, tests, lint

```
UJWALAM_HOST_BUILD=out/host/build-agent-c node app/host/tools/build.mjs
UJWALAM_HOST_EXE=out/host/build-agent-c/ujwalam-host.exe node --test --test-concurrency=1 app/host/tests/
node tools/lint.mjs
```

Final run of the suite (after O2 and all edits):

```
# gg-burst: onset 0 ms after effect.fire (wall clock vs file time), shown 2233 ms, peak 2.2 % of pixels, idle max 0.00 %
# restart in 516 ms; recording 8.17 s
# after restart: gg-burst onset 0 ms after effect.fire, peak 2.2 %
ℹ tests 29
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 97036.1336
lint: 0 finding(s), 27 allow marker(s), in 2.2s
```

29 = 11 API + 8 project/device (new: "browser off"; the two D38 device tests rewritten) + 5 output plan (new: O2
plan) + 5 browser (new file `app/host/tests/host-browser.test.mjs`). The build goes to `out/host/build-agent-c`: another agent's UI
launcher runs `out/host/build-c` (D67), which locked that exe during this work (LNK1168 once).

## 1. devices.list behind `--allow-devices` (D38)

Main's decision: everything device-related waits for "devices ready". `devices.list` now answers -32001 without the
flag, and `project.plan` / `project.load` list devices only with the flag (device layers say "devices were not
listed"). This supersedes the day-2 D30 wording "available without `--allow-devices`".

```
✔ flag off: no device module is loaded and no device source type exists (243.3025ms)
✔ devices.list is refused without --allow-devices; nothing is listed or opened (384.9006ms)
✔ project.plan without --allow-devices does not list devices: device layers say so (286.1545ms)
```

The first test also checks that the Windows camera and microphone consent store is unchanged and that win-dshow and
win-wasapi are not mapped. The R2 upstream filing (libobs GPU-rescale leak, D36) moves to the user's end-list.

## 2. Overlay server under the host

`ujwalam-host --allow-browser --overlay-root <dir> --overlay-script app/host/overlay/child.mjs [--node <exe>]
[--overlay-port n] [--overlay-feed-port n] [--overlay-events-url http://127.0.0.1:<p>/...]`

- `app/host/overlay/child.mjs` runs Agent A's `createOverlayServer` unchanged (guards on:
  `data/effects/guards.json`) and adds a parent-only control channel on stdin/stdout (JSON lines: `effect`, `stats`;
  stdin closed = stop). It opens no extra port.
- `app/host/src/overlay.{h,cpp}`: one child in a job object (kill on close), suspended until it is in the job, no
  window, only its three pipe handles inherited. Environment = an allowlist of 15 system variables; no host token, no
  `NODE_OPTIONS`. The host reads and removes `UJWALAM_EVENT_CORE_API_TOKEN` from its own environment at start, so
  CEF never inherits it; the child gets it only with `--overlay-events-url` (not used in these tests).
- Restart on exit: backoff min(15 s, 500 ms x 2^(n-1)) x (0.5-1.0 jitter), reset after 30 s up. Exit 64 (bad
  arguments) is final. After the first start the ports are pinned, so layer URLs stay valid.
- RPC: `overlay.status` (state, pid, ports, restarts, failures, last exit, env variable NAMES the child reported,
  whether it got an event token); `host.info.overlay`.

```
✔ overlay server runs under the host: 127.0.0.1, not 8093, obs-browser loaded, no token in its environment (921.7415ms)
✔ overlay child restart: new pid, same ports, effect.fire UNAVAILABLE while down, recording unaffected, pages reconnect (10082.8107ms)
✔ overlay ports: 8093 is refused before anything starts (87.0749ms)
✔ browser off: no overlay server, effect.fire refused, overlay layers forbidden (918.1864ms)
```

Smoke run (a scratch script: `launchHost({overlay: true})`, then `overlay.status`, `effect.fire`, `stopHost`; pid and
ports removed from the print):

```
overlay.status {"state":"running","restarts":0,"failures":0,"lastExit":null,"lastError":null,"eventFeed":false,"childEnvKeys":["APPDATA","ComSpec","HOMEDRIVE","HOMEPATH","LOCALAPPDATA","NUMBER_OF_PROCESSORS","PATH","PATHEXT","PROCESSOR_ARCHITECTURE","SystemDrive","SystemRoot","TEMP","TMP","USERPROFILE","windir"],"childHasEventToken":false,"browserAllowed":true}
effect.fire gg {"ok":true}
effect.fire zzz {"ok":false,"reason":"unknown-effect"}
host exit 0
```

Restart test: `taskkill /F` on the child during a recording. `effect.fire` answered -32004 while it was down. The
child came back with a new pid and the same two ports. Over 4 suite runs it took 408-617 ms. The recording ran
through (8.0-8.4 s file for an 8 s window). After the relay page reconnected, gg-burst drew again 0-200 ms after
`effect.fire`.

## 3. Browser layers, layer URLs, relay, gg-burst

- Project v1 `source.overlay` layers: `app/host/lib/project.mjs` reads the ports with `overlay.status` and builds
  `http://127.0.0.1:<static>/overlays/<rel>?<layer query>&<feedQuery(feed, scope)>`. Scope = `display` for the
  folders in `data/overlays/feed-scopes.json` (chat-list, alert-box; D72), else `effects`.
- The host (`model.cpp`) loads an overlay layer only if its URL is exactly
  `http://127.0.0.1:<its own static port>/overlays/<that overlay's rel>` plus an optional query, with no space,
  control character or `#`. Otherwise the layer is listed as unavailable: a forged URL, no URL, or the server not
  running.
- Browser source settings: `webpage_control_level` 0 (the page has no studio access), fps = the largest canvas fps,
  no audio reroute, `shutdown` false, `about:blank` instead of obs-browser's default web page when a URL is empty.
- One relay page per project (`ujw:overlay-relay`, private source, 16x16 at 10 fps, kept showing and active):
  `/_ujwalam/relay.html?feed=<feed>[&scope=display]`. The relay re-posts only `effect` and alert frames (never
  `chat`), so a display-scope relay gives effects pages no chat text.
- Test: a 1280x720@30 H canvas, a colour background and gg-burst at 1920x1080 over it. A local NVENC recording was
  read back as 160x90 grey frames at 30 fps. A pixel counts as drawn when it differs from the first frame by more than
  24 levels.

```
✔ effect.fire validates its input and reports the guards verdict (9.1237ms)
# gg-burst: onset 0 ms after effect.fire (wall clock vs file time), shown 2233 ms, peak 2.2 % of pixels, idle max 0.00 %
✔ project v1 overlay layer: URL via feedQuery, relay page, gg-burst draws on effect.fire and clears after (13291.1476ms)
```

Over 4 suite runs: onset 0-100 ms, shown 2200-2267 ms (gg-burst duration 2400 ms in its page), and 0.00 % drawn
before the fire and after it ends. An unknown effect is refused (`unknown-effect`, see the smoke run above): the
guards fail closed (D79).

Token checks: the layer URL and the plan contain no token. The page, `relay.html` and `relay.js` bodies and headers do
not contain the host API token. The child env has no `UJWALAM_*`, `*TOKEN*`, `*KEY*` or `NODE_OPTIONS` names.

## 4. O2: shared encoders H / V / Multi (loopback only)

```
UJWALAM_HOST_EXE=out/host/build-agent-c/ujwalam-host.exe node app/host/tools/o1-loopback.mjs --plan app/host/outputs/o2-loopback.json --seconds 60
```

Plan `app/host/outputs/o2-loopback.json` = preset `data/outputs/presets/youtube-1440p60.json` unchanged, with
loopback targets on 19451-19453 and 19460 (the O1 ports were in use by another agent's host). The tool writes a copy
of the test card at the plan's canvas sizes (H 2560x1440@60, V 1080x1920@60). The lavfi sources keep the card's own
size, so the larger canvas costs no extra CPU.

Run 2 (`out/host/o2/2026-10-29T22-23-18/result.json`): **52/52 PASS**. Excerpt of `checks[]` (name, then
detail):

```
PASS rung reencode-tk: GPU-scaled 2560x1440 -> 1920x1080 from canvas H scaled true, gpuScaled true, encoder size 1920x1080, canvas 2560x1440
PASS NVENC sessions probed at runtime before configure probe started 3 of 3, nvml before 0
PASS NVENC sessions = rungs, not sinks nvml 0 before -> steady median 3 (max 3); rungs 3, sinks 4
PASS encoding keeps up: skipped frames due to encoding lag <= 1% on every video mix 5/2985 (0.2%), 5/3006 (0.2%), 5/2999 (0.2%)
PASS rendering keeps up: lagged frames <= 1% on every output kick 2 (0.2%), youtube-v 5 (0.2%), twitch 5 (0.2%), youtube-h 5 (0.2%), kick 2 (0.2%)
PASS rung reencode-tk: twitch + kick carry identical video packets (one encoder) 1215 common of 1215
PASS rung reencode-tk: twitch + kick carry identical audio packets (audio encoded once) 948 common of 948
PASS different rungs (yt-h vs reencode-tk) carry different video 0 common
PASS different rungs share the one audio encoder (identical audio packets) 2328 common of 2328
52/52 checks passed
```

| Sink | Rung | Resolution | fps | Video kbps | GOP | Audio |
|---|---|---|---|---|---|---|
| youtube-h | yt-h (H direct) | 2560x1440 | 60.00 | 34012 | 2.00 s | AAC 48 kHz stereo |
| youtube-v | vert | 1080x1920 | 60.00 | 7506 | 2.00 s | AAC 48 kHz stereo |
| twitch | reencode-tk (Multi) | 1920x1080 | 60.00 | 6002 | 2.00 s | AAC 48 kHz stereo |
| kick | reencode-tk (Multi) | 1920x1080 | 60.00 | 6005 | 2.00 s | AAC 48 kHz stereo |

Also in the run: one AAC encoder for 4 sinks (host log: 1 `ujw:enc:audio`, 0 others); every URL 127.0.0.1; all
sinks live in 506 ms; kick listener drop: the supervisor retried, the other 3 sinks stayed live 16/16 samples, and
kick reconnected 1008 ms after the listener came back; clean stop and host exit 0. Load: NVENC utilisation median
64 %, max 100 %; GPU 3D max 20 %; host CPU max 5.6 %; VRAM used max 2717 MB (whole GPU).

**Run 1 (FAIL, outside cause, kept for the record)** `out/host/o2/2026-10-29T22-17-19`: 49/50.

- "NVENC sessions = rungs" failed (2 -> 7). The steady samples showed 5 = 2 outside sessions + 3 rungs. The check
  read the first sample after start, which caught start-up sessions. Fixed in the tool: it now compares the
  steady-state median (D99).
- The run also showed what the packet checks cannot: libobs reported `skipped frames due to encoding lag: 3533/4064
  (86.9%)`, 1833/4003 and 1580/3938, plus 6.4 % render lag per output. NVENC was at 99 %. The files still measured
  60 fps because a skipped frame is sent again in the next slot. The 2 outside sessions were H.264 1920x1080 and
  1080x1920 from another process (`nvidia-smi encodersessions`; it had exited when checked). So another H+V encode
  ran on the same NVENC at the same time. New checks fail on > 1 % encode or render lag (D99). Run 2 on an idle GPU
  (0 sessions before) passed them at 0.2 %.

## R3 retry hint (for Agent B)

R3 (day 2, `docs/evidence/2026-10-30-v1-host-devices-project.md`): under heavy machine load, `project.load`
right after `record.stop` can be refused with **-32009** because the outputs are not idle within the host's 3 s
wait (`Outputs::release_for_reload`). Callers should retry `project.load` on -32009 after the stop, with a short
delay and a small retry limit, then show the error. The host does not set the delay or the limit; the UI picks
them. A -32009 while a sink is still live is a real refusal (load while active), so check `outputs.status` first.

## Contract changes (additive)

- New RPC: `overlay.status {}`; `effect.fire {name, meta?}` (name `[a-z0-9][a-z0-9_-]{0,31}`, meta at most 8 keys
  with string (200 max), number, bool or null values). It returns the guards verdict `{ok}` or `{ok:false, reason}`.
  -32001 without `--allow-browser`, -32004 when the overlay server is off or restarting.
- `project.load` / `project.plan` take `browserUrls {layerId: url}` and `relayScope` (`effects` | `display`);
  `lib/project.mjs` fills them. The overlay ports always come from the host, never from the caller.
- `project.load` `built` adds `overlayLayers` and `relay`; `project.get` adds `relay`; plan `sources[]` adds `url`
  and `overlay` for browser layers; `host.info` adds `overlay`; `outputs.status` / configure `rungs[]` add `scaled`,
  `gpuScaled`, `encodeW`, `encodeH`.
- Launch: `launchHost({overlay: true})`, `tools/launch.mjs --overlay`, config `overlayRoot`
  (`UJWALAM_OVERLAY_ROOT`, default `<repo>/legacy`).

## Not checked / UNVERIFIED

- UNVERIFIED: the CSP header (`connect-src`) in CEF is not tested on its own. The pages and the relay loaded and
  connected with it on, which suggests it is accepted.
- UNVERIFIED: the event-core feed into the child (`--overlay-events-url`, token by environment). It is wired but not
  run here (no event core in this test, by the brief).
- UNVERIFIED: display-scope pages (chat-list, alert-box) in CEF; only gg-burst was run.
- UNVERIFIED: 2160p60 preset (not run); 1080p60 was covered by O1 (no GPU scaling there, since H = 1080p).
- UNVERIFIED: O2 under contention. 1440p60 kept up on an idle GPU only; with another H+V NVENC encode at the same time
  it did not (run 1). No NVENC preset was changed (p5, hq, qres multipass, lookahead 8 stay as configured).
- Not checked: browser hardware acceleration (left off), audio from browser layers (reroute off), V-canvas browser
  layers.
- R2 (libobs GPU-rescale leak on encoder create failure, D36): not reproduced in either O2 run. Upstream filing is on
  the user's end-list.

## Files

Created: `app/host/src/overlay.h`, `app/host/src/overlay.cpp`, `app/host/overlay/child.mjs`,
`app/host/tests/host-browser.test.mjs`, `app/host/outputs/o2-loopback.json`, `data/overlays/feed-scopes.json`,
`docs/evidence/2026-10-30-v1-host-browser-o2.md`.
Changed: `app/host/src/{main.cpp,app.h,methods.cpp,model.h,model.cpp,studio.h,studio.cpp,outputs.cpp}`,
`app/host/CMakeLists.txt`, `app/host/lib/{config.mjs,launch.mjs,project.mjs}`,
`app/host/tools/{launch.mjs,o1-loopback.mjs}`, `app/host/tests/{host-project.test.mjs,outputs-plan.test.mjs}`,
`docs/plan/2026-10-29-v1-decisions.md`.
