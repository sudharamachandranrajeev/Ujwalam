# F6 live marker producers (chat + audio), 2026-11-05

Result: **PASS** for tests and offline parity, **awaiting live test**. It has not been used on a real stream, so the feature is not done (AGENTS.md: a live feature is done only after one real stream with no high-severity feedback). Flag `live-markers`, off by default.

## What was built

Before this, live markers came only from the hotkey (`app/host/src/moments.cpp` `marker_add`, source `hotkey`) and from the launcher's restart marker (source `api`). The host already accepted the sources `chat` and `audio` but nothing called it with them.

- `services/event-core/live-markers.mjs` (new). It runs inside the event-core service process and subscribes to `chat.message` on the core bus (Streamer.bot chat arrives there through `streamerbot/connector.mjs` and `core.ingest`). It calls host `marker.add`:
  - source `chat`, when a message matches the "clip it" pattern (chat intent). It writes at most one marker per `peaks.minGapSec` (30 s). Later matches inside that window are counted, not written.
  - source `chat`, on a chat-speed spike. A spike is a rolling count over `chat.windowSec` that reaches `max(chat.minMessages, median * chat.ratio)`, with at most one marker per gap.
  - source `audio`, on an audio peak. The producer takes the highest host meter peak (dBFS, from `mixer.list` `peakDb`) over the active, unmuted sources, sampled every 250 ms, and keeps the maximum for each second. A peak is a second whose z-score against the running median/MAD of the voiced seconds is at least `audio.zThreshold`, at most one per gap.
- Marker notes are made from counts only, for example `chat: clip request`, `chat: speed spike, 24 messages in 20 s (baseline 3, need 9)` or `audio: peak -5 dBFS, z 16.9 (median -30)`. Chat text is only tested against the pattern in memory. No chat text, name or id is stored, logged or sent to the host.
- The feature flag `live-markers` (`data/flags.json`, default off) is read once a second through `services/flags` (it re-reads `flags.local.json` when the file's mtime changes). A flip on the control page takes effect within about 1 s. While the flag is off, the producer makes no host call (no `mixer.list`, no `marker.add`) and ignores chat. Each time the flag goes from off to on, the baselines start again.

### Decision: audio peaks are detected in Node, not in the host

The audio producer reads the existing host meter peaks over `mixer.list`. No C++ was changed and the host was not rebuilt. Reasons:
- The live flag, the shared thresholds (`data/clip/ranking.json`) and the running statistics already live in Node. A host-side detector would need a C++ JSON flag reader and a copy of the rules.
- A failure in Node is isolated from the libobs process. The host only answers one cheap call (`mixer.list`) that it already serves to the control page. That call is on the host's "polled, not logged" list.
- The cost: 4 calls per second while the flag is on, at most one in flight. Peaks between samples are missed (see UNVERIFIED).

### Shared thresholds, no new rules

- The matching rules and thresholds come from `data/clip/ranking.json`, the same file the post-stream ranking (`services/clip/clip_rank.py`) reads: `chat.intentPattern`, `chat.windowSec` (20), `chat.minMessages` (3), `chat.ratio` (3.0), `audio.floorLufs` (-70), `audio.zThreshold` (2.5), `audio.minSpread` (1.0) and `peaks.minGapSec` (30). The file is still status `proposed`.
- One constant was inline in Python: the minimum of 10 voiced seconds in `loudness_events`. It moved to `ranking.json` as `audio.minVoicedSec: 10`, and `clip_rank.py` now reads it (default 10, so post-stream behaviour is unchanged). Python clip tests: 32 OK.
- Values that exist only live are in the new file `data/clip/live-markers.json`, status **`proposed`**, `approvedBy: null`. **They need the user's approval:**
  - `chat.baselineSec` 3600: how many past seconds form the running chat median
  - `audio.sampleMs` 250: how often the meter is read
  - `audio.sources` null: null means all active, unmuted sources
  - `audio.baselineSec` 3600
  - `audio.hostTimeoutMs` 2000
  - Using `peaks.minGapSec` as the live dedupe window for each marker kind.

### Live path and failure isolation

- Host calls are fire-and-forget with a 2 s timeout. At most 4 `marker.add` calls run at once (more are dropped and counted), and one `mixer.list` read at a time. Every rejection or throw is counted. It is never re-thrown. The log gets at most one line per 60 s, with codes only.
- The bus gives the producer its own bounded queue (bus.mjs, 1000), and its handler is synchronous and O(1). A stalled producer cannot slow ingest or other subscribers.
- If the config is bad, the token is missing or the host link fails, the event core logs one line and runs without live markers (`startLiveMarkers` in `api/service.mjs`).
- Host link (`createHostLink`): exposes only `addMarker` and `mixerList`, and the token stays in a closure. After a failure it re-reads `<dataDir>/host.json`, at most once per 2 s. This is how it follows a host restart, which brings a new port with the same token.
- Wiring: `services/studio-ui/launch.mjs` passes `UJWALAM_HOST_TOKEN` to the event-core child by environment (one line; this was unavoidable because the token is generated there). `services/event-core/cli.mjs serve` reads it, removes it from `process.env`, and hands it to the service.
- `tools/package/manifest.mjs`: added `data/clip/ranking.json` and `data/clip/live-markers.json` to the packaged files. Without them the packaged event core would start without live markers (it would log a warning, not fail).

### Security note (for review)

The event core handles untrusted chat, and it now holds the host **api** token. The host has only two roles, api and system, and both can call every method (`rpc_server.h`), so this token could also start or stop outputs. In JS the use is narrowed: only the frozen two-method link is built, and the token is not reachable through it. A least-privilege host role that can call only `marker.add` and `mixer.list` would need C++ changes (`rpc_server`, `main.cpp`, `methods.cpp`). **Recommended follow-up before this flag is turned on during a real stream:** a review by the strongest model (live path, security), and a decision on adding that role.

## Commands and output

```
node --test tests/live-markers.test.mjs
```
```
ℹ tests 21
ℹ suites 8
ℹ pass 21
ℹ fail 0
```
The tests cover:
- Config: the values equal `ranking.json`, both files are `proposed`, the flag is off by default, bad values are refused.
- The rolling median/MAD.
- Intent: hits and misses, one marker per gap, no chat text in the note.
- Speed: no chat means no marker; steady chat does not fire; a burst fires and respects the gap; `minMessages` is a floor.
- Audio: a peak over the baseline fires and respects the gap; `minVoicedSec` is respected; silence is not baseline; `levelOf` filters sources.
- Runner: with the flag off there are no host calls at all; the flag is read live (on, then off); host reject, throw and hang never throw, are counted, and the in-flight cap holds; a throwing flag reader means off.
- Host link: only two methods, the bearer token is sent, the discovery file is re-read after a failure.
- Service: with no token it logs "off" and the service runs; a real `core.ingest` of a chat message produces exactly one `marker.add {source:'chat', note:'chat: clip request'}`.

Related existing suites (event-core api/audit/failclosed/priority/SSE, stall tracer, flags, studio-ui alpha, core-url, crash-recovery, live-test, live-guard, package-alpha, stray-procs):
```
node --test tests/event-core-api-files.test.mjs tests/event-core-audit-privacy.test.mjs tests/event-core-audit.test.mjs tests/event-core-failclosed.test.mjs tests/event-core-priority.test.mjs tests/live-guard.test.mjs tests/package-alpha.test.mjs tests/stall-tracer-service.test.mjs tests/stray-procs.test.mjs tests/studio-ui-alpha.test.mjs tests/studio-ui-core-url.test.mjs tests/studio-ui-crash-recovery.test.mjs tests/studio-ui-live-test.test.mjs tests/flags.test.mjs tests/studio-ui-flags-feedback.test.mjs tests/event-core-api.test.mjs tests/event-core-api-sse.test.mjs
```
```
ℹ tests 194
ℹ pass 193
ℹ fail 0
ℹ skipped 1
```
```
python -I -m unittest discover -s tests/py -p "test_clip*.py"
```
```
Ran 32 tests in 10.048s
OK
```
```
node tools/lint.mjs
```
```
lint: 0 finding(s), 31 allow marker(s), in 5.3s
```
(The new files were also linted explicitly: 0 findings.) The full `npm run ci` was not run: a full CI run was already in progress.

### Offline parity with the post-stream rules (one-off script, invented data)

The script ran the JS detectors and Python `clip_rank.chat_events` / `loudness_events` on the same synthetic series, using the same `ranking.json`:
```
intent samples 19 js==py 19 differ: []
chat speed: live fires at s [607,637] | post-stream events at s [619,649]
audio: live fires at s [300] | post-stream events at s [301.5]
```
- The chat series was 10 minutes of quiet chat, then a 40 s burst starting at s 600.
- The audio series was steady speech, then a loud spike at s 300–302.
- Live fires at the first crossing. Post-stream picks the strongest second inside each 30 s gap because it sees the whole recording. Both mark the same moment within the 30 s backdated window (`windows.marker.preSec` 30).

## Not checked / UNVERIFIED

- **Real-stream use: UNVERIFIED** (awaiting live test). It is not known whether real Streamer.bot chat on YouTube, Twitch or Kick produces sensible marker rates.
- **Audio equivalence: UNVERIFIED.**
  - Post-stream uses ebur128 short-term loudness (LUFS, 3 s window) of the recorded mix. Live uses per-source meter peaks in dBFS (max over sources, sampled at 4 Hz). The same z/MAD rule is applied to a different measure, and the floor of -70 is used for dBFS as well. Peaks shorter than the sample gap can be missed.
  - The meter is post-fader and post-filter.
- **Chat count differences: UNVERIFIED impact.** The post-stream count reads `chat_raw`, which also holds moderation-dropped messages and alert texts. Live counts only published `chat.message` events, after moderation. The live baseline starts when the flag turns on and covers at most 3600 s; the post-stream median covers the whole recording. Early in a stream, with a near-zero baseline, `minMessages` (3 in 20 s) is the only floor. Post-stream behaves the same on a quiet recording.
- **Regex: UNVERIFIED for non-ASCII.** JS `\W`/`\b` are ASCII-only, while Python's are Unicode. The two agree on all 19 samples, including one accented sample. Text with non-Latin letters right before "clip" could still differ.
- Markers are written even when nothing is streaming or recording (`streamMs` and `recordMs` are null). The post-stream reader matches markers by `recordMs`, so these markers are ignored there.
- No host build or host test was run (no C++ change). The real host `mixer.list` → producer path was not exercised against a running host. Only a fake JSON-RPC server was used.
- Values in `data/clip/live-markers.json` and `ranking.json` remain **proposed**, pending the user's approval.

## Files created or changed

Created:
- `services/event-core/live-markers.mjs`
- `data/clip/live-markers.json`
- `tests/live-markers.test.mjs`
- `docs/evidence/2026-11-05-f6-live-markers.md`

Changed:
- `data/flags.json`: flag `live-markers`, default off
- `data/clip/ranking.json`: `audio.minVoicedSec: 10`, moved from inline Python
- `services/clip/clip_rank.py`: reads `minVoicedSec`
- `services/event-core/api/service.mjs`: `startLiveMarkers`, stop on shutdown
- `services/event-core/cli.mjs`: `serve` takes `UJWALAM_HOST_TOKEN` / `UJWALAM_HOST_DISCOVERY` from env and removes the token from env
- `services/studio-ui/launch.mjs`: one env entry on the event-core spawn
- `tools/package/manifest.mjs`: ships the two `data/clip` files
