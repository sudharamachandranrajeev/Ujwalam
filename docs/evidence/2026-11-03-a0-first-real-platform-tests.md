# Alpha 0: first real-platform test streams (2026-11-03)

Status: PASS for YouTube H, YouTube V, Twitch (bandwidth test) and Kick (2 minutes). Run under the live-test guard (D180, D181) after the user's "yes, on air". Loopback ffprobe assertions passed before this (`host-live-keys`, `host-twitch-bandwidth-test`, 7/7).

## Setup

- Repo build, `node services/studio-ui/launch.mjs --alpha --allow-devices --live --sinks ... --twitch-bandwidth-test --test-stream-minutes 15 [--test-sink-minutes kick=2]`. The user started the streams from the control page with the typed confirmation.
- Plan `data/outputs/alpha-live.json`, 1080p60 preset (D182):
  - YouTube H: 1920x1080@60, 17000 kbps CBR, direct.
  - YouTube V: 1080x1920@60, 7500 kbps.
  - Twitch and Kick: one shared 1920x1080@60 6000 kbps rung.
  - Local .mkv recording on the YouTube H rung.
- Real devices: capture card, facecam, mic. Keys and per-account servers come from Credential Manager only.
- YouTube: private broadcasts created by the user (H and V). Twitch: `?bandwidthtest=true` appended at connect time (not broadcast). Kick: public, titled as a test by the user.

## Run 1 (10:36 UTC, 15 min, no Kick)

| Sink | s | kbps avg | kbps min | lost frames (net + enc-skip + render-lag) | retries |
|---|---|---|---|---|---|
| youtube-h | 901.4 | 17174 | 15428 | 0 of 53937 | 0 |
| youtube-v | 901.4 | 7676 | 7146 | 0 of 53823 | 1 |
| twitch (bw test) | 901.4 | 6176 | 5369 | 0 of 53949 | 0 |

The youtube-v retry was the first connect attempt: `Connection to rtmps://a.rtmps.youtube.com:443/live2 failed: -2`. It retried after 1.8 s and connected. There was no drop during the stream.

## Run 2 (11:36 UTC, 15 min, Kick limited to 2 min)

| Sink | s | kbps avg | kbps min | lost frames | retries |
|---|---|---|---|---|---|
| youtube-h | 901.3 | 17172 | 14950 | 0 of 53932 | 0 |
| youtube-v | 901.3 | 7676 | 7084 | 0 of 53944 | 0 |
| twitch (bw test) | 901.3 | 6176 | 5987 | 0 of 53947 | 0 |
| kick | 122.1 | 6102 | 1834 | 0 of 7017 | 0 |

Both runs ended on the guard time limit (exit 0). Kick was stopped by its own 2-minute limit. The worst 10 s window was 0 % for every sink.

## Platform-side checks (by the user)

- Twitch Inspector lists both sessions (10:36, 15 min; 11:35) with 0 unstable events. As expected, bandwidth-test mode was not visible on the channel page or dashboard.
- YouTube Studio: the user reported "YouTube looked fine" and "1080p60", and confirmed V showed as vertical.
- Kick: the user confirmed the stream showed ("did stream").

## Notes

- Network path: the host log shows a WireGuard tunnel interface. Results are for this network path.
- Kick's 1834 kbps minimum is probably the ramp after connecting (not checked).
- Reports (local, not committed): `<dataDir>/logs/live-test-2026-11-03T10-51-01-060Z.*`, `live-test-2026-11-03T11-50-59-510Z.*`.
- Host logs contain per-account ingest hosts (from Credential Manager). They are local only. The diag bundle redacts them: `tools/diag/redact.mjs` turns `rtmps://<host>/...` into `rtmps://<redacted>` (checked 2026-11-03).
