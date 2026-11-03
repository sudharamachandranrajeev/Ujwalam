# Alpha 0: live-test guard and Twitch bandwidth-test mode (2026-11-03)

Status: built and tested on loopback. Not yet run against real platforms (that needs the user's "yes, on air").

## What it does

- `--twitch-bandwidth-test` (host flag, D179): keyed Twitch sinks connect with `?bandwidthtest=true` appended to the stored key at connect time. The credential is never changed. Status reports a boolean only.
- `--sinks a,b,c`: only the selected sinks and their rungs are configured.
- `--test-stream-minutes N`, `--test-sink-minutes kick=2`: the guard (D180) stops outputs at the limit, on any sink failure, a sink not live for more than 10 s, or the loss budget (D181, `data/outputs/guard/live-test-budget.json`).
- Report: `<dataDir>/logs/live-test-<stamp>.json` and `.txt`, with per-sink network, encoder and render losses, the worst 10 s window, and retries. No keys, URLs or error text.

## Tests

- `node --test --test-concurrency=1 app/host/tests/host-twitch-bandwidth-test.test.mjs app/host/tests/host-live-keys.test.mjs` → 7/7 pass (65 s). These cover:
  - Loopback with a temporary credential: the twitch sink's ffmpeg listener receives the key plus `?bandwidthtest=true`, the youtube sink's receives the key alone, and the key is in no RPC response or log.
  - `host.info` and `outputs.status` report `twitchBandwidthTest: true`.
- `tests/live-guard.test.mjs` and `tests/studio-ui-live-test.test.mjs`: 22/22 pass, including fake-host runs for a clean exit 0 and a dropped-window abort with exit 4.
- The full CI runs in the commit hook.

## UNVERIFIED

- Real Twitch accepts the bandwidth-test key and does not broadcast (check in Twitch Inspector during the test).
- How the encoder-skipped and render-lagged counters behave under real load. Encoder skips are counted on the root video, so scaled rungs share them.
- The budget values are the user's decision, not platform documentation.
