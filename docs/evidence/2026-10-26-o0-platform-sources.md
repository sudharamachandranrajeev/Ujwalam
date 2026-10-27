# 2026-10-26 — O0 platform capability sources

Data lives in `data/platforms/*.json`; this table mirrors it (revision 3, 2026-10-27).

Source kinds:
- UR = `user-reference-2026-10-27`: reference table supplied by the user on 2026-10-27. Where an official page agrees, its URL is in the value's `note`.
- Official URLs, checked 2026-10-26 by read-only fetch. Twitch help-centre articles are JS-rendered and returned only a loading shell, so Twitch official values rest on an official Twitch blog post and dev docs.
- UNVERIFIED = no official or user source; always severity `warning`; produces an UNVERIFIED_LIMIT warning when a check consults it.

Severity: every value has `severity`. `error` only where the platform (or the user table) states a HARD limit; recommended, listed, "standard" and "best" values are `warning`. A finding takes the severity of the rule that produced it. Exit code 1 only on errors.

Official URLs:
- YT = https://support.google.com/youtube/answer/2853702 (fetched text had parts elided)
- TWB = https://blog.twitch.tv/en/2026/06/17/introducing-dual-format-and-2k-streaming-on-twitch/
- TWD = https://dev.twitch.tv/docs/video-broadcast/
- KK = https://help.kick.com/en/articles/7066931-how-to-stream-on-kick-com

## Error-severity rules and the wording that justifies each

| Rule | Value | Justifying wording |
|---|---|---|
| youtube keyframeIntervalSec.max | 4 s | YT: "Do not exceed 4 seconds" |
| kick maxWidth, maxHeight | 1920 x 1080 | KK: "KICK currently supports a maximum resolution of 1920x1080."; user table: 1080p60 hard max |
| kick maxFps | 60 | KK lists max 60 fps; user table: 1080p60 hard max |
| kick videoCodecs | h264 | KK: "KICK currently only supports X264 / H.264 encoding." |
| kick videoBitrateKbps.min | 1000 | KK: settings range "1,000 kbps to 8,000 kbps" |
| kick videoBitrateKbps.max | 8000 | KK: "KICK supports a bitrate of up to 8,000 kbps."; user table: 8000 max |
| kick rateControl | cbr | KK: "You must set your streaming software to CBR."; user table: VBR not supported |

(`local.json` rules are all `error` but impose no limits.)

## Warning-severity and UNVERIFIED values

| Platform | Field | Value | Source / why warning |
|---|---|---|---|
| youtube | maxWidth x maxHeight, maxFps | 3840 x 2160, 60 | UR; YT lists 4K as highest row and "up to 60 fps" but does not state a hard limit |
| youtube | videoCodecs | h264, hevc, av1 | UR; listed |
| youtube | videoBitrateKbps.max | 50000 | UR; highest recommendation |
| youtube | videoBitrateKbps.recommendedByResolution | 1080p60 17000, 1440p60 34000, 2160p60 50000 | UR; recommendations |
| youtube | rateControl | cbr | UR; message "YouTube lists CBR; VBR may cause buffering" |
| youtube | keyframeIntervalSec.recommended | 2 | UR/YT; warning when gop_sec is not 2 |
| youtube | audioBitrateKbps.recommended / audioSampleRateHz.recommended | 128 / 44100 | UR; recommended, not a max |
| youtube | audioCodecs, protocols | aac+mp3, rtmp+rtmps | YT; listed |
| youtube | videoBitrateKbps.min, audioBitrateKbps.max, audioTracksMax | none | UNVERIFIED |
| youtube | portrait, multitrackVideo | true, false | UNVERIFIED |
| twitch | maxWidth x maxHeight, maxFps | 1920 x 1080, 60 | UR; "standard" |
| twitch | videoCodecs | h264 | UR; standard RTMP (HEVC only via Enhanced Broadcasting) |
| twitch | videoBitrateKbps.max | 6000 | UR; described as "standard" |
| twitch | enhancedBroadcasting | 7500 (1080p) / 9000 (1440p) kbps, up to 2560x1440, h264+hevc | UR (TWB agrees); informational, never applied, unused until O5 |
| twitch | rateControl, keyframeIntervalSec max/recommended | cbr, 2 / 2 | UR; no official page seen stating a hard limit |
| twitch | audioCodecs, audioBitrateKbps.recommended | aac, 160 | UR |
| twitch | protocols, multitrackVideo | rtmp, true | TWD, TWB (RTMPS availability UNVERIFIED) |
| twitch | videoBitrateKbps.min, audioBitrateKbps.max, audioTracksMax | none | UNVERIFIED |
| twitch | portrait | true | UNVERIFIED |
| kick | keyframeIntervalSec max/recommended | 2 / 2 | UR; KK presets show 2 s, no stated hard limit |
| kick | audioCodecs, audioBitrateKbps.recommended, audioSampleRateHz.recommended | aac, 160, 48000 | UR; recommended |
| kick | protocols | rtmps | KK; example only |
| kick | audioBitrateKbps.max, audioTracksMax | none | UNVERIFIED |
| kick | portrait, multitrackVideo | true, false | UNVERIFIED |
