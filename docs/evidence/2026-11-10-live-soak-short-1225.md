# Live soak short (3 min): FAIL

Run 2026-11-10-live-soak-short-1225, started 2026-11-10T12:25:35.875Z, ran 186 s. Gate: `npm run soak` (tools/soak/live-soak.mjs, LU8, D324).
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
| a quiet machine: no Meld Studio, installed Ujwalam or detector job started during the run | FAIL | `[{"t":122,"what":["clip detector job"]}]` |
| no process exited during the run (host, event core, UI server) | PASS | `{"host":null,"core":null,"ui":null}` |
| host stopped cleanly on shutdown (exit 0) | PASS | `{"exit":0}` |
| 0 dropped frames (host) | PASS | `{"max":0}` |
| 0 render-lagged frames | FAIL | `{"max":632}` |
| 0 encode-skipped frames | FAIL | `{"max":2021}` |
| 0 dropped frames on every sink | PASS | `{"youtube-h":{"dropped":0,"total":11094},"youtube-v":{"dropped":0,"total":11089},"twitch":{"dropped":0,"total":11136},"kick":{"dropped":0,"total":11136},"record":{"dropped":0,"total":11094}}` |
| every stream live in every sample | PASS | `{"samplesNotLive":0,"samplesWithError":0}` |
| overlay server: no restart, no failure | PASS |  |
| chat reached the event core | PASS | `{"sent":133,"noClient":0}` |
| scene switches all applied | PASS | `{"ok":16,"failed":0}` |
| effects fired and some played | PASS | `{"fired":34,"delivered":5}` |
| clip saves all ok | PASS | `[true,true]` |
| one hot-reload of every data kind ran | PASS | `{"missing":[]}` |
| reload flags-local: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":318,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload flags-definitions: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":310,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload posting-rules: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":6,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload studio-tasks: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":309,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload guide-tour: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":308,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload guide-hints: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":311,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload effect-guards: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":313,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload flash-measurements: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":311,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| every loopback listener received the whole run | PASS | `{"youtube-h":185,"youtube-v":185,"twitch":186,"kick":186}` |
| 0 video timestamp gaps in what the listeners received (ffprobe) | PASS | `{"kick":{"gaps":0,"missingFrames":0,"endGaps":1},"twitch":{"gaps":0,"missingFrames":0,"endGaps":1},"youtube-h":{"gaps":0,"missingFrames":0,"endGaps":0},"youtube-v":{"gaps":0,"missingFrames":0,"endGaps":1}}` |
| no crash report | PASS | `[]` |
| no error-level log line (host, overlay child, event core, UI server) | PASS | `{"count":0}` |
| no process left after the run | PASS | `{"host":0,"node":0}` |

## Session

- Chat messages sent: 133 (placeholder names and texts; none lost: true).
- Scene switches: 16 ok, 0 failed.
- Effects: 34 fired, 5 played, refused by the guards: `{"busy":19,"cooldown":1,"region-busy":2,"budget":7}`.
- Clip saves: 2 (2 ok).

| Data kind | Owner | Applied (ms) | Broken file kept | Notice | Fixed |
|---|---|---|---|---|---|
| flags-local | ui, overlay | yes (318) | yes | yes | yes |
| flags-definitions | ui, overlay | yes (310) | yes | yes | yes |
| posting-rules | ui | yes (6) | yes | yes | yes |
| studio-tasks | ui | yes (309) | yes | yes | yes |
| guide-tour | ui | yes (308) | yes | yes | yes |
| guide-hints | ui | yes (311) | yes | yes | yes |
| effect-guards | overlay | yes (313) | yes | yes | yes |
| flash-measurements | overlay | yes (311) | yes | yes | yes |

## Received (ffprobe, video packet timestamps)

| Sink | Segments | Seconds | Gaps | Missing frames | Gaps at stream stop (not counted) |
|---|---|---|---|---|---|
| kick | 4 | 186 | 0 | 0 | 1 |
| twitch | 4 | 186 | 0 | 0 | 1 |
| youtube-h | 4 | 185 | 0 | 0 | 0 |
| youtube-v | 4 | 185 | 0 | 0 | 1 |

## Load

Max over the samples: system CPU 50% (the stack 15.1%, everything else 27.7%), GPU 21%, NVENC 98%, VRAM 1521 MB, NVENC sessions 3.

Frame losses (host counters read every second; load from the nearest sample; CPU % of all cores):

| t (s) | Render lagged | Encode skipped | Dropped | Script action in the 3 s before | System CPU % | Stack CPU % | Other CPU % (top) | GPU % | NVENC % |
|---|---|---|---|---|---|---|---|---|---|
| 92.4 | 14 | 0 | 0 | - | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 93.4 | 17 | 32 | 0 | - | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 94.4 | 3 | 66 | 0 | - | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 95.5 | 28 | 17 | 0 | - | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 96.8 | 68 | 1 | 0 | - | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 97.8 | 16 | 53 | 0 | - | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 98.8 | 8 | 58 | 0 | - | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 99.8 | 1 | 95 | 0 | - | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 100.8 | 0 | 116 | 0 | scene colour H; scene colour V | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 101.8 | 0 | 22 | 0 | scene colour H; scene colour V | 48.3 | 13 | 26.2 (Browser Shell.exe 5.5, ffmpeg.exe 5, System 3.7) | 17 | 43 |
| 106.9 | 1 | 1 | 0 | - | 31.9 | 6.5 | 17.7 (Browser Shell.exe 5.4, ffmpeg.exe 5.4, System 1.5) | 9 | 55 |
| 121.4 | 54 | 16 | 0 | effect burst; scene home H; scene home V | 32.1 | 4.7 | 19.1 (Browser Shell.exe 5, ffmpeg.exe 5, MsMpEng.exe 2.7) | 8 | 51 |
| 122.4 | 73 | 3 | 0 | effect burst; scene home H; scene home V | 32.1 | 4.7 | 19.1 (Browser Shell.exe 5, ffmpeg.exe 5, MsMpEng.exe 2.7) | 8 | 51 |
| 123.6 | 37 | 11 | 0 | scene home V | 32.1 | 4.7 | 19.1 (Browser Shell.exe 5, ffmpeg.exe 5, MsMpEng.exe 2.7) | 8 | 51 |
| 124.6 | 13 | 39 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 125.7 | 18 | 44 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 127 | 58 | 6 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 128.1 | 22 | 28 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 129.2 | 46 | 8 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 130.2 | 8 | 42 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 131.2 | 2 | 74 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 132.3 | 27 | 19 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 133.3 | 1 | 76 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 134.3 | 1 | 92 | 0 | - | 42.5 | 8.9 | 20.6 (Browser Shell.exe 4.6, System 4, MsMpEng.exe 3.8) | 17 | 98 |
| 135.3 | 0 | 98 | 0 | - | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 136.3 | 0 | 122 | 0 | - | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 137.4 | 11 | 73 | 0 | - | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 138.4 | 9 | 45 | 0 | - | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 139.5 | 4 | 92 | 0 | - | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 140.5 | 9 | 79 | 0 | - | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 141.5 | 1 | 120 | 0 | - | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 142.5 | 0 | 130 | 0 | scene colour H; scene colour V | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 143.5 | 0 | 126 | 0 | scene colour H; scene colour V | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 144.5 | 0 | 65 | 0 | scene colour H; scene colour V | 35.9 | 13.4 | 15.4 (Browser Shell.exe 4.8, ffmpeg.exe 2, MsMpEng.exe 1.8) | 21 | 97 |
| 147.5 | 4 | 4 | 0 | - | 32.8 | 6.2 | 15.2 (Browser Shell.exe 5.3, MsMpEng.exe 2.4, System 1.7) | 9 | 60 |
| 151.5 | 5 | 0 | 0 | clip save | 32.8 | 6.2 | 15.2 (Browser Shell.exe 5.3, MsMpEng.exe 2.4, System 1.7) | 9 | 60 |
| 152.5 | 0 | 8 | 0 | clip save | 32.8 | 6.2 | 15.2 (Browser Shell.exe 5.3, MsMpEng.exe 2.4, System 1.7) | 9 | 60 |
| 155.6 | 8 | 8 | 0 | - | 32.8 | 6.2 | 15.2 (Browser Shell.exe 5.3, MsMpEng.exe 2.4, System 1.7) | 9 | 60 |
| 162.6 | 12 | 15 | 0 | scene home H; scene home V | 28.6 | 5 | 16.5 (Browser Shell.exe 5.5, ffmpeg.exe 4.6, System 1.1) | 10 | 78 |
| 163.6 | 2 | 2 | 0 | scene home H; scene home V | 28.6 | 5 | 16.5 (Browser Shell.exe 5.5, ffmpeg.exe 4.6, System 1.1) | 10 | 78 |
| 170.7 | 6 | 9 | 0 | - | 28.8 | 12.1 | 13.9 (Browser Shell.exe 5.1, ffmpeg.exe 3.9, System 0.9) | 16 | 54 |
| 173.7 | 2 | 2 | 0 | - | 28.8 | 12.1 | 13.9 (Browser Shell.exe 5.1, ffmpeg.exe 3.9, System 0.9) | 16 | 54 |
| 174.9 | 34 | 13 | 0 | - | 28.8 | 12.1 | 13.9 (Browser Shell.exe 5.1, ffmpeg.exe 3.9, System 0.9) | 16 | 54 |
| 175.9 | 9 | 51 | 0 | - | 28.8 | 12.1 | 13.9 (Browser Shell.exe 5.1, ffmpeg.exe 3.9, System 0.9) | 16 | 54 |
| 176.9 | 0 | 40 | 0 | - | 28.8 | 12.1 | 13.9 (Browser Shell.exe 5.1, ffmpeg.exe 3.9, System 0.9) | 16 | 54 |

Host warnings after the stream start (t in s):

- 96: `Source ujw:lyr-82b8dfdc audio is lagging (over by 39.92 ms) at max audio buffering. Restarting source audio.`
- 97: `Source ujw:lyr-c119278c audio is lagging (over by 13.26 ms) at max audio buffering. Restarting source audio.`
- 97: `Source ujw:lyr-82b8dfdc audio is lagging (over by 832.59 ms) at max audio buffering. Restarting source audio.`
- 121: `Source ujw:lyr-82b8dfdc audio is lagging (over by 575.59 ms) at max audio buffering. Restarting source audio.`
- 121: `Source ujw:lyr-c119278c audio is lagging (over by 388.92 ms) at max audio buffering. Restarting source audio.`
- 123: `Source ujw:lyr-c119278c audio is lagging (over by 466.66 ms) at max audio buffering. Restarting source audio.`
- 124: `Source ujw:lyr-82b8dfdc audio is lagging (over by 619.59 ms) at max audio buffering. Restarting source audio.`
- 124: `Source ujw:lyr-c119278c audio is lagging (over by 379.26 ms) at max audio buffering. Restarting source audio.`
- 128: `Source ujw:lyr-82b8dfdc audio is lagging (over by 238.26 ms) at max audio buffering. Restarting source audio.`
- 130: `Source ujw:lyr-82b8dfdc audio is lagging (over by 278.26 ms) at max audio buffering. Restarting source audio.`

## Logs

- host: 700 lines, 0 error-level; known benign: 1x libobs plugin probe (no OBS frontend in the host); logged at load, no effect.
- core: 6 lines, 0 error-level.
- ui: 19 lines, 0 error-level.

