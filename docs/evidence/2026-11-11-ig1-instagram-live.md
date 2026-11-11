# IG1 Instagram Live output (D351) — evidence, 2026-11-11

Result: **PASS** (headless, loopback only). Flag `instagram-live` stays off by default. A real Instagram broadcast is
UNVERIFIED (not attempted; needs the user's "start stream test").

Decision: D351 in `docs/plan/2026-10-29-v1-decisions.md`. Branch `out/instagram-live`.

## Sources

`data/platforms/instagram.json` cites https://about.instagram.com/blog/tips-and-tricks/instagram-live-producer/
(fetched 2026-11-11): 720x1280 (9:16 recommended), 30 fps (60 supported, preview 30), 2,250-6,000 Kbps video,
44.1 kHz stereo up to 256 Kbps audio, "The stream key is not static, and will refresh each time you use Live Producer".

## Loopback ffprobe (real host, no --allow-live)

Command: `UJWALAM_HEADLESS=1 node --test app/host/tests/host-instagram-loopback.test.mjs`

Plan: preset `youtube-1080p60` + instagram add-on, cut to the instagram sink, loopback target
`rtmp://127.0.0.1:<port>/live/instagram`; test card project (V canvas 1080x1920@60); 10 s stream.

```
# instagram loopback ffprobe: {"w":720,"h":1280,"fps":29.9,"kbps":4061,"gopSec":2,"keyframes":6,"vcodec":"h264","acodec":"aac","sampleRate":48000,"channels":2,"akbps":160} (rung 720x1280@30 4000 kbps gop 2s, audio 160 kbps 48000 Hz)
✔ instagram sink over loopback RTMP: ffprobe matches data/platforms/instagram.json (14584.9931ms)
ℹ tests 1  pass 1  fail 0
```

| Check | Limit (platform file) | Measured | |
|---|---|---|---|
| Size | ≤ 1280 x 720 (long x short), portrait | 720x1280 | PASS |
| Frame rate | ≤ 30 | 29.9 | PASS |
| Video bitrate | 2,250-6,000 kbps | 4,061 (rung 4,000 CBR) | PASS |
| Keyframe interval | ≤ 2 s (UNVERIFIED) | 2 s median, 6 keyframes | PASS |
| Video codec | h264 (UNVERIFIED) | h264 | PASS |
| Audio | 1 track, AAC, stereo, ≤ 256 kbps | 1 AAC, 2 ch, 160 kbps | PASS |
| Sample rate | 44,100 recommended | 48,000 (shared track) | warning, by design |

## Unit and integration tests (one file at a time, `UJWALAM_HEADLESS=1 node --test <file>`)

| File | Result |
|---|---|
| tests/instagram-live.test.mjs | 18/18 |
| tests/outputs/schema.test.mjs | 29/29 |
| tests/outputs/validate.test.mjs | 49/49 |
| tests/platform-connect.test.mjs | 37/37 |
| tests/studio-ui-readiness.test.mjs | 39/39 |
| tests/studio-launch-d327.test.mjs | 4/4 |
| tests/flags.test.mjs | 7/7 |
| tests/studio-ui-connect.test.mjs | 14/14 |
| tests/studio-ui-connect-setup.test.mjs | 4/4 |
| tests/studio-ui-alpha.test.mjs | 37/37 |
| tests/event-core-moderation.test.mjs | 31/31 |
| app/host/tests/outputs-plan.test.mjs | 18/18 |
| app/host/tests/host-instagram-loopback.test.mjs | 1/1 |

`node tools/outputs-validate-presets.mjs`: exit 0. Pre-commit quick CI: 9/9 (build, lint, build-host, build-studio,
validate-registry, validate-outputs, validate-games, private-scan, legacy-verify).

`tests/instagram-live.test.mjs` covers: the platform values; the preset V rung is not reused and `ig-v` 720x1280@30 is
added; a fitting V rung is reused; 25 fps on a 50 fps canvas; deduplication; refusals; the plan file through
`planFile` (allowLive; `auto` unresolved without schemes, rtmps with them; `--sinks` drops `ig-v`); flag off by
default; key state fresh, live, used (also after a crash and when never live); connect row, paste needs both URL and
key, only the last 4 shown, no secret on disk; readiness fails with the fix text and passes with a fresh key; no limit
number hardcoded in the module. Test values are throwaway strings in memory stores; no Credential Manager write.

## UNVERIFIED

- RTMP vs RTMPS for Live Producer URLs (transport `auto` follows the pasted URL).
- H.264, AAC, 2 s keyframe interval, CBR, one audio track: not stated by Instagram.
- 48 kHz audio accepted by Instagram (recommended 44.1 kHz).
- 1080x1920 ingest (vendor claims only; Ujwalam stays at 720x1280).
- 4 h maximum duration (2020 news report).
- Live Producer access on the user's account; the exact key format.
- Qt Settings > Connections shows the Instagram row through the generic rows (not built or checked in this task).
