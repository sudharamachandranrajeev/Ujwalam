# A0 real outputs: keychain stream keys, --allow-live gate, crash-safe recording (2026-11-03)

Result: PASS (loopback, automated) for everything that can be proven without a real platform.
Real-platform streaming is **awaiting live test** (private test stream with the user). Nothing in this file
contacted a real platform, and no real key was used.

## What was built

- **Real targets in the plan.** A real target is `{transport: rtmps|rtmp, server | serverRef, keyRef}` in a plan
  file (`app/host/lib/outputs-plan.mjs`). The host receives `{transport, url | urlRef, keyRef}`. It never receives
  a key.
  - **Ingest URLs come from `data/platforms/<id>.json` → `ingest`**, with `source` and `checked` set.
    - YouTube: `serverFrom: "data"` with `primary-rtmps` and `primary-rtmp`. **UNVERIFIED** (see below).
    - Twitch: `serverFrom: "keychain"`. The user chooses the server. The format is from dev.twitch.tv.
    - Kick: `serverFrom: "keychain"`. The ingest URL is per account (help.kick.com: "Paste the Server URL from your
      KICK Settings Page"). It is stored in Credential Manager exactly like the key (`serverRef`), so it never
      appears in git, evidence or RPC.
  - `data/outputs/alpha-live.json` holds Credential Manager target names only. It is validated by
    `npm run validate:outputs`.
- **The host reads keys itself** (`app/host/src/stream_keys.{h,cpp}`).
  - It calls `CredReadW` (GENERIC) in-process.
  - The target name must match `^Ujwalam/stream/[a-z0-9-]{1,32}$`.
  - The value must be printable ASCII after trimming whitespace, at most 1023 bytes.
  - The value goes into a fixed `char[1024]` that belongs to the private service `ujwalam_live`. There is no
    `std::string` and no `obs_data`.
  - The `CREDENTIAL` blob is zeroed (`SecureZeroMemory`) before `CredFree`. The service buffer is zeroed on the
    output's `start` and `stop` signals, on a synchronous start failure, and when the service is destroyed.
- **Gate.**
  - Real targets are configured only when the host runs with the new `--allow-live` flag. Otherwise
    `outputs.configure` returns `-32001` with the message "real (non-loopback) targets are refused; the host must
    be started with --allow-live (after the user's "yes, on air")".
  - The planner refuses real targets unless it is called with `allowLive`.
  - `host.info.flags.allowLive` and `outputs.status.allowLive` report the flag.
  - The UI's typed "yes, on air" (D119) stays the start gate. CI never passes `--allow-live`.
- **The key path is tested without a real key or platform.**
  - A loopback rtmp target may carry `keyRef` in place of `stream`. The host then reads the key and sends it as the
    RTMP stream name to a local ffmpeg listener.
  - That listener expects a different name. It logs `Unexpected stream <received>`, which proves that the key
    reached the stream path. The key is never on ffmpeg's argv.
- **Recording.**
  - `.mkv` is the default. Any other container is refused unless the target says `"unsafeContainer": true`. The
    error explains that the file is not crash-safe.
  - In a plan that streams, a recording must bind to a rung that also feeds a stream sink, so it adds no encoder.
    The exception is `ownRung: true`, a plan-only field.
  - A host that is killed mid-recording leaves a playable mkv (tested).

## Commands and output

All commands were run from the worktree root on 2026-11-03.

```
npm run lint
```
```
lint: 0 finding(s), 27 allow marker(s), in 2.4s
```

```
npm run validate:outputs
```
```
== plan alpha-live.json
  youtube-h -> rung yt-h (youtube rtmps) url rtmps://a.rtmps.youtube.com:443/live2 keyRef Ujwalam/stream/youtube-h
  youtube-v -> rung vert (youtube rtmps) url rtmps://a.rtmps.youtube.com:443/live2 keyRef Ujwalam/stream/youtube-v
  twitch -> rung reencode-tk (twitch rtmp) urlRef Ujwalam/stream/twitch-server keyRef Ujwalam/stream/twitch
  kick -> rung reencode-tk (kick rtmps) urlRef Ujwalam/stream/kick-server keyRef Ujwalam/stream/kick
  record -> rung yt-h (local file) file alpha.mkv
  real targets (need --allow-live): youtube-h, youtube-v, twitch, kick
```
(exit 0; the three O0 presets also pass, total egress 70140 kbps for the 1440p60 preset.)

```
node --test --test-timeout=300000 tests/outputs/schema.test.mjs tests/outputs/validate.test.mjs tests/event-core-moderation.test.mjs tests/event-core-streamerbot-cli.test.mjs tests/event-core-streamerbot-credential.test.mjs tests/lint.test.mjs tests/studio-ui-server.test.mjs
```
```
ℹ tests 180
ℹ pass 180
ℹ fail 0
```

```
node --test app/host/tests/outputs-plan.test.mjs
```
```
ℹ tests 12
ℹ pass 12
ℹ fail 0
```
The 7 A0 tests cover: the alpha plan (rungs, sinks to rungs, keyRefs only); refusal without allowLive; the
real-target rules (keyRef name, unknown fields such as `key`, server or serverRef, transport = proto = platform
protocol, duplicate keyRef, serverRef ≠ keyRef); that every ingest URL is valid and has a source and date, plus
bad URLs (loopback, credentials, query, plain rtmp for rtmps, port 0, spaces); the mkv rule; that the recording
binds to a stream rung; and the loopback keyRef.

Before each host or encode run, I checked that the machine was idle (D100): `Get-Process ujwalam-host` returned
nothing and `nvidia-smi` showed 0 encoder sessions. The script also waited until no host, compiler or test run had
been active for 30 s.

```
node app/host/tools/build.mjs
```
```
built …\out\host\build\ujwalam-host.exe
```

```
node --test --test-concurrency=1 "app/host/tests/*.test.mjs"
```
```
✔ host.info and outputs.status report allowLive false (no --allow-live)
✔ real targets are refused without --allow-live; malformed real targets are invalid; there is no key field
✔ recordings: .mkv by default, other containers only with unsafeContainer (error says why)
✔ loopback keyRef: the stored key reaches the RTMP stream path, ffprobe passes, the key is in no RPC response or log
✔ crash safety: a recording .mkv still probes after the host is killed mid-recording
ℹ tests 41
ℹ pass 35
ℹ fail 1
ℹ skipped 5
```

- **The 1 failure** is `discovery: … owner-only DACL` (host-api). It failed only because that run was started from
  PowerShell 7. The test spawns Windows PowerShell 5.1, which inherited pwsh 7's `PSModulePath`, so `Get-Acl`
  could not load ("The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security', but the module
  could not be loaded"). Re-run from Git Bash:
  `node --test --test-concurrency=1 app/host/tests/host-api.test.mjs` → `tests 11, pass 11, fail 0`.
  This is pre-existing and not related to A0.
- **The 5 skipped tests** are the overlay and browser tests. They skip because the worktree has no overlay root.
  Earlier in this task they passed 5/5 with `UJWALAM_OVERLAY_ROOT` pointing at the main checkout's `legacy/`.

`host-live-keys.test.mjs` does the following:

1. Creates a temporary credential `Ujwalam/stream/test-<random hex>` with the random value `ujwtest-<32 hex>`. It
   uses `services/event-core/credential.mjs` and deletes the credential in `after`.
2. Starts a loopback ffmpeg RTMP listener that expects a different stream name.
3. Configures the sinks `keyed` (keyRef), `nokey` (keyRef to an absent target) and `rec` (file).
4. Asserts `keyPresent` is true for `keyed` and false for `nokey`, and that a configure warning names the missing
   target.
5. Starts `keyed` and `rec` for 4 s. Starting `nokey` fails, with a message that names the target and the
   `credential set --target` hint.
6. Asserts that ffmpeg's log contains `Unexpected stream <key>,`, which means the key reached the stream path.
7. ffprobe: h264 640x360 with more than 60 packets plus AAC, and the mkv recording has video.
8. Asserts the key appears in no RPC response, no host log line (the log does contain "Connecting to RTMP URL")
   and neither host stdout nor stderr.
9. Deletes the ffmpeg log after the test.

O2 loopback regression (per `docs/evidence/2026-10-30-v1-host-browser-o2.md`):

```
node app/host/tools/o1-loopback.mjs --plan app/host/outputs/o2-loopback.json --seconds 60
```
```
PASS rung reencode-tk: GPU-scaled 2560x1440 -> 1920x1080 from canvas H scaled true, gpuScaled true, encoder size 1920x1080, canvas 2560x1440
PASS one AAC encoder for all sinks audio encoders: 1, sinks: 4
PASS NVENC sessions probed at runtime before configure probe started 3 of 3, nvml before 0
PASS all sinks live 511 ms
PASS NVENC sessions = rungs, not sinks nvml 0 before -> steady median 3 (max 3); rungs 3, sinks 4
PASS kick: reconnects after the listener returns 2016 ms after restart
PASS encoding keeps up: skipped frames due to encoding lag <= 1% on every video mix 0 (libobs logs no line when nothing was skipped)
PASS rendering keeps up: lagged frames <= 1% on every output 0 on every output (libobs logs no line when nothing lagged)
PASS rung reencode-tk: twitch + kick carry identical video packets (one encoder) 1247 common of 1247
PASS rung reencode-tk: twitch + kick carry identical audio packets (audio encoded once) 972 common of 972
52/52 checks passed
```

Three earlier O2 runs that day failed only the two "keeps up" checks:

| Run | What else was running | Result |
|---|---|---|
| 01:58 | Another session started the full `npm test` and a soak run mid-run | 50/52, encoding lag 29.6–53.7 % |
| 02:04 | Another session ran `app/host/tests` (its own host and NVENC) | 50/52 |
| 02:08 | Another session ran a C++ link and git hooks | 50/52 |

These were caused by CPU and GPU contention from other sessions, not by A0. The 02:01 run was clean (0 lag), but the
old harness reported it as a FAIL because the lag lines were missing. See "Check rules changed" below.

## Key setup for the user (tomorrow, before the private test)

Store each value in Windows Credential Manager. The prompt hides what you type, and nothing goes on argv:

```
node services/event-core/cli.mjs credential set --target Ujwalam/stream/youtube-h
node services/event-core/cli.mjs credential set --target Ujwalam/stream/youtube-v
node services/event-core/cli.mjs credential set --target Ujwalam/stream/twitch
node services/event-core/cli.mjs credential set --target Ujwalam/stream/twitch-server
node services/event-core/cli.mjs credential set --target Ujwalam/stream/kick
node services/event-core/cli.mjs credential set --target Ujwalam/stream/kick-server
```

- `twitch-server`: the full ingest URL without the key, for example `rtmp://<ingest-server>/app`.
- `kick-server`: the "Stream URL" from the Kick dashboard, `rtmps://…:443/app`.

Alternative from the clipboard (PowerShell). The value is piped to stdin, never put on argv:

```
Get-Clipboard | node services/event-core/cli.mjs credential set --target Ujwalam/stream/youtube-h --stdin
```

Check presence without revealing the value. It prints only `credential: set` or `credential: not set`:

```
node services/event-core/cli.mjs credential status --target Ujwalam/stream/youtube-h
```

With the host running, `outputs.status` shows `keyPresent` (and `urlPresent` for serverRef targets) per sink, and
`outputs.configure` warns which target is missing. To remove a value:
`node services/event-core/cli.mjs credential delete --target Ujwalam/stream/<x>`.

The host must be started with `--allow-live` for the real plan. A sink whose key or URL is missing fails at start
with a message that names the target and the `credential set` command. That sink is not retried, and the other
sinks keep going.

## Security review of key handling

| Where | What happens | Residual risk |
|---|---|---|
| Disk / git | The plan and `data/platforms` hold target names only. The tests assert there are no key fields and that rtmp URLs appear only under `ingest`. | None found. |
| argv / env | Keys are never on argv or in the environment. The CLI reads them from a hidden prompt or stdin. The host reads them from Credential Manager. Only `--allow-live` is a flag. | None. |
| RPC | `outputs.*` returns `keyRef`, `keyPresent`, `urlRef` and `urlPresent`, never the value. `url` is `null` for `urlRef` targets. If an output error text contains the key, it is replaced with "output error text withheld (it contained the stream key)". The test asserts the key is in no RPC response. | None found. |
| Host log | Ujwalam code never logs the key. libobs logs `Connecting to RTMP URL <server>`, which is the server URL without the key. The test asserts the key is in no host log line and in neither stdout nor stderr. | The **server URL** is logged by libobs. For Twitch and Kick that URL comes from the keychain, so the per-account Kick ingest host ends up in the local, gitignored host log. librtmp may log error text sent by the server verbatim. |
| Host memory | Ujwalam's copy is a fixed buffer, zeroed on start, stop, failure and destroy. The `CREDENTIAL` blob is zeroed before `CredFree`. Presence checks use scratch buffers that are wiped. | libobs `rtmp-stream` (`stream->key` dstr) and librtmp (the `RTMP` struct) keep their **own copies for the lifetime of the output and do not zero them on free**. They cannot be fixed without patching obs-outputs. |
| Crash dumps | The host writes no minidump of its own. | A WER or debugger dump of a live host would contain the libobs copies above. Do not share host crash dumps. |
| Credential Manager | GENERIC credentials, per Windows user. | Any process that runs as the same user can read them. This is a property of Credential Manager. |
| Network | RTMPS (mbedtls in obs-outputs) for YouTube and Kick. Twitch is plain RTMP per its published URL format, so the Twitch key travels unencrypted. | Twitch also offers RTMPS ingest, UNVERIFIED. The plan could move to rtmps once the user confirms a Twitch RTMPS URL. |

## UNVERIFIED and not checked

- **YouTube ingest URL** `rtmps://a.rtmps.youtube.com:443/live2` is taken from OBS 32.1.2 `services.json` (v285). The
  official page (developers.google.com rtmps-ingestion) says the URL comes from the API and prints no literal
  URL. Compare it with YouTube Studio > Go live > Stream settings before the first private test.
- RTMPS against real ingests (TLS handshake, certificate validation in mbedtls) has not been tested. Only loopback
  plain RTMP was used.
- Twitch RTMPS was not modelled (see the table above).
- The 1440p60 recording at 34 Mbps is about 15 GB per hour (arithmetic only).
- Real platform behaviour (bitrate acceptance, reconnects and stream health) is **awaiting live test**.

## Check rules changed (fixed openly, not worked around)

1. `tests/outputs/schema.test.mjs` — "presets and platform files contain no stream keys or ingest URLs" now allows
   rtmp(s) URLs only at `platforms/*.json` → `ingest.value.servers[].url` and `ingest.value.urlFormat`, with no
   query and no `@`. Presets and every other part of a platform file stay URL-free. The stream-key check is
   unchanged. Reason: the task requires ingest URLs to come from `data/platforms`.
2. `tests/outputs/schema.test.mjs` — "sources are official https URLs" now allows another source only on a value
   marked `unverified: true`. The YouTube ingest source is OBS `services.json`, because the official page prints
   no URL.
3. `app/host/tools/o1-loopback.mjs` — the "encoding/rendering keeps up" checks failed when the lag was zero.
   libobs prints those lines only when the count is non-zero (obs 32.1.2 `media-io/video-io.c` `if (skipped)` and
   `obs-output.c` `if (drawn && lagged)`). A missing line now counts as 0, but only if every sink logged its
   unconditional stop counters (`Total frames output`).

## Files

Created:
- `app/host/src/stream_keys.h`
- `app/host/src/stream_keys.cpp`
- `app/host/tests/host-live-keys.test.mjs`
- `data/outputs/alpha-live.json`
- `docs/evidence/2026-11-03-a0-real-outputs.md`

Changed:
- `app/host/CMakeLists.txt`
- `app/host/src/outputs.{h,cpp}`
- `app/host/src/app.h`
- `app/host/src/main.cpp`, with these changes:
  - `--allow-live` in the usage text
  - one argument-parse line
  - `allow_live` passed to `Outputs`, plus one info log line
- `app/host/src/methods.cpp`, with one line: `flags.set("allowLive", …)` in `host.info`
- `app/host/lib/outputs-plan.mjs`
- `app/host/tests/outputs-plan.test.mjs`
- `app/host/tools/o1-loopback.mjs`
- `data/platforms/{platform.schema,youtube,twitch,kick}.json`
- `tests/outputs/schema.test.mjs`
- `tools/outputs-validate-presets.mjs`
