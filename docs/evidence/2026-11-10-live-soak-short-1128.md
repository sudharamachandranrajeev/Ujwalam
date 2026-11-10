# Live soak short (3 min): FAIL

Run 2026-11-10-live-soak-short-1128, started 2026-11-10T11:28:04.393Z, ran 185 s. Gate: `npm run soak` (tools/soak/live-soak.mjs, LU8, D324).
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
| no process exited during the run (host, event core, UI server) | PASS | `{"host":null,"core":null,"ui":null}` |
| host stopped cleanly on shutdown (exit 0) | PASS | `{"exit":0}` |
| 0 dropped frames (host) | PASS | `{"max":0}` |
| 0 render-lagged frames | FAIL | `{"max":333}` |
| 0 encode-skipped frames | FAIL | `{"max":367}` |
| 0 dropped frames on every sink | PASS | `{"youtube-h":{"dropped":0,"total":10752},"youtube-v":{"dropped":0,"total":10851},"twitch":{"dropped":0,"total":10779},"kick":{"dropped":0,"total":10779},"record":{"dropped":0,"total":10752}}` |
| every stream live in every sample | PASS | `{"samplesNotLive":0,"samplesWithError":0}` |
| overlay server: no restart, no failure | PASS |  |
| chat reached the event core | PASS | `{"sent":133,"noClient":0}` |
| scene switches all applied | PASS | `{"ok":16,"failed":0}` |
| effects fired and some played | PASS | `{"fired":34,"delivered":4}` |
| clip saves all ok | PASS | `[true,true]` |
| one hot-reload of every data kind ran | PASS | `{"missing":[]}` |
| reload flags-local: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":23,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload flags-definitions: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":317,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload posting-rules: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":12,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload studio-tasks: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":312,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload guide-tour: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":316,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload guide-hints: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":319,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload effect-guards: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":320,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload flash-measurements: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":316,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| every loopback listener received the whole run | PASS | `{"youtube-h":185,"youtube-v":185,"twitch":186,"kick":186}` |
| 0 video timestamp gaps in what the listeners received (ffprobe) | PASS | `{"kick":{"gaps":0,"missingFrames":0,"endGaps":1},"twitch":{"gaps":0,"missingFrames":0,"endGaps":1},"youtube-h":{"gaps":0,"missingFrames":0,"endGaps":1},"youtube-v":{"gaps":0,"missingFrames":0,"endGaps":0}}` |
| no crash report | PASS | `[]` |
| no error-level log line (host, overlay child, event core, UI server) | PASS | `{"count":0}` |
| no process left after the run | PASS | `{"host":0,"node":0}` |

## Session

- Chat messages sent: 133 (placeholder names and texts; none lost: true).
- Scene switches: 16 ok, 0 failed.
- Effects: 34 fired, 4 played, refused by the guards: `{"busy":11,"cooldown":1,"region-busy":2,"budget":16}`.
- Clip saves: 2 (2 ok).

| Data kind | Owner | Applied (ms) | Broken file kept | Notice | Fixed |
|---|---|---|---|---|---|
| flags-local | ui, overlay | yes (23) | yes | yes | yes |
| flags-definitions | ui, overlay | yes (317) | yes | yes | yes |
| posting-rules | ui | yes (12) | yes | yes | yes |
| studio-tasks | ui | yes (312) | yes | yes | yes |
| guide-tour | ui | yes (316) | yes | yes | yes |
| guide-hints | ui | yes (319) | yes | yes | yes |
| effect-guards | overlay | yes (320) | yes | yes | yes |
| flash-measurements | overlay | yes (316) | yes | yes | yes |

## Received (ffprobe, video packet timestamps)

| Sink | Segments | Seconds | Gaps | Missing frames | Gaps at stream stop (not counted) |
|---|---|---|---|---|---|
| kick | 4 | 186 | 0 | 0 | 1 |
| twitch | 4 | 186 | 0 | 0 | 1 |
| youtube-h | 4 | 185 | 0 | 0 | 1 |
| youtube-v | 4 | 185 | 0 | 0 | 0 |

## Load

Max over the samples: system CPU 100% (the stack 17%, everything else 68.5%), GPU 20%, NVENC 68%, VRAM 1402 MB, NVENC sessions 3.

Frame losses (host counters read every second; load from the nearest sample; CPU % of all cores):

| t (s) | Render lagged | Encode skipped | Dropped | Script action in the 3 s before | System CPU % | Stack CPU % | Other CPU % (top) | GPU % | NVENC % |
|---|---|---|---|---|---|---|---|---|---|
| 80.2 | 1 | 1 | 0 | scene home H; scene home V | 67.5 | 5.1 | 51.5 (python.exe 35.1, Browser Shell.exe 5.7, ffmpeg.exe 3) | 10 | 64 |
| 166.6 | 5 | 0 | 0 | - | 83.5 | 10.5 | 68.5 (python.exe 47.8, Browser Shell.exe 5.4, ffmpeg.exe 4.1) | 18 | 61 |
| 167.7 | 56 | 2 | 0 | - | 83.5 | 10.5 | 68.5 (python.exe 47.8, Browser Shell.exe 5.4, ffmpeg.exe 4.1) | 18 | 61 |
| 168.7 | 30 | 19 | 0 | - | 83.5 | 10.5 | 68.5 (python.exe 47.8, Browser Shell.exe 5.4, ffmpeg.exe 4.1) | 18 | 61 |
| 169.7 | 0 | 81 | 0 | - | 83.5 | 10.5 | 68.5 (python.exe 47.8, Browser Shell.exe 5.4, ffmpeg.exe 4.1) | 18 | 61 |
| 170.7 | 4 | 108 | 0 | - | 86.3 | 13.4 | 64.2 (python.exe 36.2, Browser Shell.exe 5.4, ffmpeg.exe 4.8) | 18 | 63 |
| 171.7 | 0 | 10 | 0 | - | 86.3 | 13.4 | 64.2 (python.exe 36.2, Browser Shell.exe 5.4, ffmpeg.exe 4.8) | 18 | 63 |
| 177.7 | 20 | 0 | 0 | - | 86.3 | 13.4 | 64.2 (python.exe 36.2, Browser Shell.exe 5.4, ffmpeg.exe 4.8) | 18 | 63 |
| 178.8 | 52 | 1 | 0 | - | 86.3 | 13.4 | 64.2 (python.exe 36.2, Browser Shell.exe 5.4, ffmpeg.exe 4.8) | 18 | 63 |
| 179.9 | 20 | 36 | 0 | - | 86.3 | 13.4 | 64.2 (python.exe 36.2, Browser Shell.exe 5.4, ffmpeg.exe 4.8) | 18 | 63 |
| 180.9 | 39 | 6 | 0 | - | 72.5 | 9.3 | 54.2 (python.exe 31.8, Browser Shell.exe 5.5, System 3.8) | 3 | 0 |

Host warnings after the stream start (t in s):

- 167: `Source ujw:lyr-2bbe8580 audio is lagging (over by 212.49 ms) at max audio buffering. Restarting source audio.`
- 168: `Source ujw:lyr-e24af893 audio is lagging (over by 532.49 ms) at max audio buffering. Restarting source audio.`
- 168: `Source ujw:lyr-2bbe8580 audio is lagging (over by 437.16 ms) at max audio buffering. Restarting source audio.`
- 182: `Source ujw:lyr-e24af893 audio is lagging (over by 213.83 ms) at max audio buffering. Restarting source audio.`
- 186: `Source ujw:lyr-e24af893 audio is lagging (over by 30.16 ms) at max audio buffering. Restarting source audio.`

## Logs

- host: 691 lines, 0 error-level; known benign: 1x libobs plugin probe (no OBS frontend in the host); logged at load, no effect.
- core: 6 lines, 0 error-level.
- ui: 19 lines, 0 error-level.

