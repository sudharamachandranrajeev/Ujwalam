# Stream outputs, transitions, integrations and platform sign-in in the studio (2026-11-10)

Status: requested by the user 2026-11-10 ("continue building, don't stop"). Decision D327. Reference: four screenshots of
another studio's settings in the user's local UI reference folder (third-party, never copied into the repo; one shows a
channel handle). Layout and behaviour only; our own styling from the theme tokens.

User: "instead of using windows credential manager, the app should be able to connect to streaming platforms directly
from the app as well."

## A. Stream settings and outputs (OS)

| Id | What | Done when |
|---|---|---|
| OS1 | Settings > Stream: canvas mode cards (Main canvas only / Multi canvas H + V), main canvas resolution, frame rate, output resolution, hardware encoder switch, video bitrate per canvas (H and portrait), quality preset, audio bitrate. Values come from and write to the existing output graph (compositor → encoder pool → delivery pool); limits from `data/platforms/*.json`, never hardcoded. | Settings round-trip test; invalid values refused with the platform limit shown. |
| OS2 | Streaming outputs list: one row per output (platform icon, canvas H/V, "1080p @ 60fps 7,500 kbps · Main canvas"), Add output, Edit, Delete (delete asks first). Outputs bind to existing encoder rungs (sinks never own encoders). | Add/edit/delete tests; rung dedup kept. |
| OS3 | Main window Outputs panel: each output with an on/off switch, + to add, Virtual Camera row. Switching an output while live needs "yes, on air" (live-lock) and only starts/stops that sink. | Toggle test against loopback outputs; other outputs unbroken (ffprobe). |

## B. Transitions (TR)

| Id | What | Done when |
|---|---|---|
| TR1 | Transition settings: type, easing curve, duration (ms) for the main canvas; portrait canvas has its own settings or "mirror main canvas transitions"; "Force complete transition" button. | Settings round-trip; host applies type/easing/duration per canvas; force-complete test. |

## C. Integrations (IN)

| Id | What | Done when |
|---|---|---|
| IN1 | Settings > Integrations: Streamer.bot and Speaker.bot connection (address, port, test button, status), and "Allow remote connections" for the local API, off by default, LAN only (never reachable from outside the LAN), with a plain warning. Streamer.bot stays read-only for Ujwalam. | Default-off test; LAN-only bind test; connection test with mocks. |

## D. Platform sign-in in the app (PC)

| Id | What | Done when |
|---|---|---|
| PC1 | Connect a platform from the studio: YouTube (Google sign-in, fetches the stream key/ingest for the H and V outputs), Twitch (Twitch sign-in, stream key), or paste a stream key / server URL for any platform (Kick, custom RTMP(S)). | Mock OAuth and mock API tests; real sign-in UNVERIFIED until the user does it. |
| PC2 | Storage: the app writes keys and tokens to Windows Credential Manager itself (the user no longer opens the Windows tool). Never in files, logs, settings JSON, crash reports, chat or email; masked in the UI; redact rules cover them. | Private/secret scan test; log redaction test. |
| PC3 | Disconnect removes the stored key/token; status per platform (connected, expired, missing) on Settings and readiness check. | Tests. |

Security review (strongest model + Codex second review) before PC is marked done. New features behind flags, off by
default.
