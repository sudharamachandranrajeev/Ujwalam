# Live soak short (3 min): FAIL

Run 2026-11-10-live-soak-short-1251, started 2026-11-10T12:51:58.382Z, ran 185 s. Gate: `npm run soak` (tools/soak/live-soak.mjs, LU8, D324).
Host: libobs 32.1.2, adapter NVIDIA GeForce RTX 4050 Laptop GPU. Loopback outputs only (127.0.0.1 RTMP listeners); recording on.

| Check | Result | Detail |
|---|---|---|
| obs-nvenc.dll patched (build-obs-nvenc --check) | PASS |  |
| host: devices off, real targets off | PASS |  |
| every stream sink is a loopback target | PASS | `["youtube-h:stream:loopback","youtube-v:stream:loopback","twitch:stream:loopback","kick:stream:loopback","record:record:mkv"]` |
| UI server up and one-time login works | PASS |  |
| event core subscribed to the mock Streamer.bot | PASS |  |
| a colour scene to switch to on every canvas | PASS | `{"canvases":["H","V"]}` |
| all loopback streams live within 20 s | PASS |  |
| a quiet machine: no Meld Studio, installed Ujwalam or detector job started during the run | PASS | `[]` |
| no process exited during the run (host, event core, UI server) | PASS | `{"host":null,"core":null,"ui":null}` |
| host stopped cleanly on shutdown (exit 0) | PASS | `{"exit":0}` |
| 0 dropped frames (host) | FAIL | `{"max":128}` |
| 0 render-lagged frames | FAIL | `{"max":256}` |
| 0 encode-skipped frames | FAIL | `{"max":798}` |
| 0 dropped frames on every sink | FAIL | `{"youtube-h":{"dropped":0,"total":11026},"youtube-v":{"dropped":0,"total":11021},"twitch":{"dropped":0,"total":11078},"kick":{"dropped":128,"total":11078},"record":{"dropped":0,"total":11026}}` |
| every stream live in every sample | PASS | `{"samplesNotLive":0,"samplesWithError":0}` |
| overlay server: no restart, no failure | PASS |  |
| chat reached the event core | PASS | `{"sent":130,"noClient":0}` |
| scene switches all applied | PASS | `{"ok":16,"failed":0}` |
| effects fired and some played | PASS | `{"fired":34,"delivered":4}` |
| clip saves all ok | PASS | `[true,true]` |
| one hot-reload of every data kind ran | PASS | `{"missing":[]}` |
| reload flags-local: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":15,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload flags-definitions: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":308,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload posting-rules: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":6,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload studio-tasks: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":306,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload guide-tour: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":311,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload guide-hints: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":330,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload effect-guards: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":319,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload flash-measurements: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":314,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| every loopback listener received the whole run | PASS | `{"youtube-h":184,"youtube-v":184,"twitch":185,"kick":185}` |
| 0 video timestamp gaps in what the listeners received (ffprobe) | FAIL | `{"kick":{"gaps":65,"missingFrames":128,"endGaps":0},"twitch":{"gaps":0,"missingFrames":0,"endGaps":0},"youtube-h":{"gaps":0,"missingFrames":0,"endGaps":0},"youtube-v":{"gaps":0,"missingFrames":0,"endGaps":0}}` |
| no crash report | PASS | `[]` |
| no error-level log line (host, overlay child, event core, UI server) | PASS | `{"count":0}` |
| no process left after the run | PASS | `{"host":0,"node":0}` |

## Session

- Chat messages sent: 130 (placeholder names and texts; none lost: true).
- Scene switches: 16 ok, 0 failed.
- Effects: 34 fired, 4 played, refused by the guards: `{"busy":13,"region-busy":1,"budget":16}`.
- Clip saves: 2 (2 ok).

| Data kind | Owner | Applied (ms) | Broken file kept | Notice | Fixed |
|---|---|---|---|---|---|
| flags-local | ui, overlay | yes (15) | yes | yes | yes |
| flags-definitions | ui, overlay | yes (308) | yes | yes | yes |
| posting-rules | ui | yes (6) | yes | yes | yes |
| studio-tasks | ui | yes (306) | yes | yes | yes |
| guide-tour | ui | yes (311) | yes | yes | yes |
| guide-hints | ui | yes (330) | yes | yes | yes |
| effect-guards | overlay | yes (319) | yes | yes | yes |
| flash-measurements | overlay | yes (314) | yes | yes | yes |

## Received (ffprobe, video packet timestamps)

| Sink | Segments | Seconds | Gaps | Missing frames | Gaps at stream stop (not counted) |
|---|---|---|---|---|---|
| kick | 4 | 185 | 65 | 128 | 0 |
| twitch | 4 | 185 | 0 | 0 | 0 |
| youtube-h | 4 | 184 | 0 | 0 | 0 |
| youtube-v | 4 | 184 | 0 | 0 | 0 |

## Load

Max over the samples: system CPU 100% (the stack 16.2%, everything else 29.2%), GPU 20%, NVENC 98%, VRAM 1467 MB, NVENC sessions 3.

Frame losses (host counters read every second; load from the nearest sample; CPU % of all cores):

| t (s) | Render lagged | Encode skipped | Dropped | Script action in the 3 s before | System CPU % | Stack CPU % | Other CPU % (top) | GPU % | NVENC % |
|---|---|---|---|---|---|---|---|---|---|
| 40.1 | 6 | 1 | 0 | reload guide-tour: valid; reload guide-tour: broken; reload guide-tour: fixed; effect burst; scene home H; scene home V | 48.5 | 6.5 | 18.8 (Browser Shell.exe 4.9, MsMpEng.exe 3.5, caveman-proxy.exe 2.9) | 16 | 53 |
| 41.1 | 2 | 7 | 0 | reload guide-tour: valid; reload guide-tour: broken; reload guide-tour: fixed; effect burst; scene home H; scene home V | 48.5 | 6.5 | 18.8 (Browser Shell.exe 4.9, MsMpEng.exe 3.5, caveman-proxy.exe 2.9) | 16 | 53 |
| 42.1 | 3 | 3 | 0 | reload guide-tour: fixed; effect burst; scene home H; scene home V; reload guide-hints: valid | 48.5 | 6.5 | 18.8 (Browser Shell.exe 4.9, MsMpEng.exe 3.5, caveman-proxy.exe 2.9) | 16 | 53 |
| 44.1 | 4 | 4 | 0 | reload guide-hints: valid; reload guide-hints: broken; reload guide-hints: fixed | 48.5 | 6.5 | 18.8 (Browser Shell.exe 4.9, MsMpEng.exe 3.5, caveman-proxy.exe 2.9) | 16 | 53 |
| 70.2 | 6 | 6 | 0 | clip save | 38.2 | 8 | 18.2 (Browser Shell.exe 5.7, caveman-proxy.exe 4.4, System 2.5) | 8 | 65 |
| 71.3 | 20 | 20 | 0 | clip save | 78.5 | 5.3 | 25.1 (Browser Shell.exe 5.2, caveman-proxy.exe 4.8, claude.exe 4.2) | 8 | 54 |
| 72.4 | 6 | 6 | 0 | clip save | 78.5 | 5.3 | 25.1 (Browser Shell.exe 5.2, caveman-proxy.exe 4.8, claude.exe 4.2) | 8 | 54 |
| 73.4 | 13 | 13 | 0 | - | 78.5 | 5.3 | 25.1 (Browser Shell.exe 5.2, caveman-proxy.exe 4.8, claude.exe 4.2) | 8 | 54 |
| 74.4 | 5 | 5 | 0 | - | 78.5 | 5.3 | 25.1 (Browser Shell.exe 5.2, caveman-proxy.exe 4.8, claude.exe 4.2) | 8 | 54 |
| 76.5 | 4 | 4 | 0 | - | 78.5 | 5.3 | 25.1 (Browser Shell.exe 5.2, caveman-proxy.exe 4.8, claude.exe 4.2) | 8 | 54 |
| 97.6 | 4 | 4 | 0 | - | 75.6 | 16.2 | 29.2 (MsMpEng.exe 9.1, System 5, Browser Shell.exe 5) | 16 | 62 |
| 110.7 | 2 | 0 | 0 | - | 53.8 | 5.2 | 25.9 (MsMpEng.exe 6.5, caveman-proxy.exe 5.8, Browser Shell.exe 5) | 8 | 64 |
| 111.8 | 8 | 10 | 0 | - | 53.8 | 5.2 | 25.9 (MsMpEng.exe 6.5, caveman-proxy.exe 5.8, Browser Shell.exe 5) | 8 | 64 |
| 118.3 | 120 | 135 | 128 | - | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |
| 119.5 | 14 | 52 | 0 | - | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |
| 120.5 | 0 | 95 | 0 | effect burst; scene home H; scene home V | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |
| 121.5 | 0 | 91 | 0 | effect burst; scene home H; scene home V | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |
| 122.8 | 23 | 86 | 0 | effect burst; scene home H; scene home V | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |
| 123.8 | 8 | 85 | 0 | - | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |
| 124.8 | 0 | 84 | 0 | - | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |
| 125.9 | 8 | 77 | 0 | - | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |
| 126.9 | 0 | 10 | 0 | - | 96.6 | 7.2 | 19.3 (Browser Shell.exe 4.2, caveman-proxy.exe 3.8, MsMpEng.exe 3.1) | 15 | 98 |

Host warnings after the stream start (t in s):

- 40: `Source ujw:lyr-8e9aa1f9 audio is lagging (over by 30.07 ms) at max audio buffering. Restarting source audio.`
- 111: `Source ujw:lyr-8e9aa1f9 audio is lagging (over by 151.07 ms) at max audio buffering. Restarting source audio.`
- 118: `Source ujw:lyr-0dc25908 audio is lagging (over by 2822.07 ms) at max audio buffering. Restarting source audio.`
- 118: `Source ujw:lyr-0dc25908 audio is lagging (over by 302.57 ms) at max audio buffering. Restarting source audio.`
- 118: `Source ujw:lyr-8e9aa1f9 audio is lagging (over by 5817.53 ms) at max audio buffering. Restarting source audio.`
- 119: `Source ujw:lyr-0dc25908 audio is lagging (over by 74.12 ms) at max audio buffering. Restarting source audio.`
- 119: `Source ujw:lyr-8e9aa1f9 audio is lagging (over by 452.69 ms) at max audio buffering. Restarting source audio.`
- 123: `Source ujw:lyr-8e9aa1f9 audio is lagging (over by 181.07 ms) at max audio buffering. Restarting source audio.`

## Logs

- host: 697 lines, 0 error-level; known benign: 1x libobs plugin probe (no OBS frontend in the host); logged at load, no effect.
- core: 6 lines, 0 error-level.
- ui: 19 lines, 0 error-level.

