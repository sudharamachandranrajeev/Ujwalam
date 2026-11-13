# Live soak short (3 min): FAIL

Run 2026-11-13-live-soak-short-2000, started 2026-11-13T20:00:21.034Z, ran 184 s. Gate: `npm run soak` (tools/soak/live-soak.mjs, LU8, D324).
Host: libobs 32.1.2, adapter NVIDIA GeForce RTX 4050 Laptop GPU. Loopback outputs only (127.0.0.1 RTMP listeners); recording on.

| Check | Result | Detail |
|---|---|---|
| obs-nvenc.dll patched (build-obs-nvenc --check) | PASS |  |
| host: devices off, real targets off | PASS |  |
| every stream sink is a loopback target | PASS | `["youtube-h:stream:loopback","youtube-v:stream:loopback","twitch:stream:loopback","kick:stream:loopback","record:record:mkv","record-v:record:mkv"]` |
| UI server up and one-time login works | PASS |  |
| event core subscribed to the mock Streamer.bot | PASS |  |
| a colour scene to switch to on every canvas | PASS | `{"canvases":["H","V"]}` |
| the plan has every required stream (youtube-h, youtube-v, twitch, kick) | PASS | `{"missing":[]}` |
| stream start accepted | PASS | `"ok"` |
| recording start accepted | PASS | `{"start":"ok","sinks":["record","record-v"]}` |
| every required stream and the recording live within 20 s | PASS | `["youtube-h","youtube-v","twitch","kick","record","record-v"]` |
| a quiet machine: no Meld Studio, installed Ujwalam or detector job started during the run | PASS | `[]` |
| no process exited during the run (host, event core, UI server) | PASS | `{"host":null,"core":null,"ui":null}` |
| host stopped cleanly on shutdown (exit 0) | PASS | `{"exit":0}` |
| 0 dropped frames (host) | PASS | `{"max":0}` |
| 0 render-lagged frames | FAIL | `{"max":1}` |
| 0 encode-skipped frames | PASS | `{"max":0}` |
| 0 dropped frames on every sink | PASS | `{"youtube-h":{"dropped":0,"total":10911},"youtube-v":{"dropped":0,"total":8228},"twitch":{"dropped":0,"total":11066},"kick":{"dropped":0,"total":11066},"record":{"dropped":0,"total":10911},"record-v":{"dropped":0,"total":8228}}` |
| every required stream and the recording live in every sample | PASS | `{"samplesNotLive":{"youtube-h":0,"youtube-v":0,"twitch":0,"kick":0,"record":0,"record-v":0},"otherStreamsNotLive":0,"samplesWithError":0}` |
| overlay server: no restart, no failure | PASS |  |
| chat reached the event core | PASS | `{"sent":133,"noClient":0}` |
| scene switches all applied | PASS | `{"ok":16,"failed":0}` |
| effects fired and some played | PASS | `{"fired":34,"delivered":3}` |
| clip saves all ok | PASS | `[true,true]` |
| one hot-reload of every data kind ran | PASS | `{"missing":[]}` |
| reload flags-local: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":317,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload flags-definitions: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":310,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload posting-rules: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":7,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload studio-tasks: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":305,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload guide-tour: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":308,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload guide-hints: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":307,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload effect-guards: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":311,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| reload flash-measurements: valid change applied while live, broken file kept the last good version with a notice, fix cleared it | PASS | `{"applyMs":306,"applied":true,"brokenKept":true,"notice":true,"fixed":true,"noticeCleared":true}` |
| every required loopback listener received the whole run | FAIL | `{"youtube-h":183,"youtube-v":167,"twitch":185,"kick":185}` |
| 0 video timestamp gaps in what the listeners received (ffprobe, planned fps) | PASS | `{"youtube-h":{"gaps":0,"missingFrames":0,"endGaps":0},"youtube-v":{"gaps":0,"missingFrames":0,"endGaps":0},"twitch":{"gaps":0,"missingFrames":0,"endGaps":0},"kick":{"gaps":0,"missingFrames":0,"endGaps":0}}` |
| the recording record: started, live throughout, covers the whole run with 0 video timestamp gaps (ffprobe, planned fps) | PASS | `{"spanSec":184,"packets":11013,"endGaps":0}` |
| the recording record-v: started, live throughout, covers the whole run with 0 video timestamp gaps (ffprobe, planned fps) | PASS | `{"spanSec":172,"packets":10329,"endGaps":0}` |
| no crash report | PASS | `[]` |
| no error-level log line (host, overlay child, event core, UI server) | PASS | `{"count":0}` |
| no process left after the run | PASS | `{"host":0,"node":0}` |

## Session

- Chat messages sent: 133 (placeholder names and texts; none lost: true).
- Scene switches: 16 ok, 0 failed.
- Effects: 34 fired, 3 played, refused by the guards: `{"busy":11,"cooldown":1,"region-busy":2,"budget":17}`.
- Clip saves: 2 (2 ok).

| Data kind | Owner | Applied (ms) | Broken file kept | Notice | Fixed |
|---|---|---|---|---|---|
| flags-local | ui, overlay | yes (317) | yes | yes | yes |
| flags-definitions | ui, overlay | yes (310) | yes | yes | yes |
| posting-rules | ui | yes (7) | yes | yes | yes |
| studio-tasks | ui | yes (305) | yes | yes | yes |
| guide-tour | ui | yes (308) | yes | yes | yes |
| guide-hints | ui | yes (307) | yes | yes | yes |
| effect-guards | overlay | yes (311) | yes | yes | yes |
| flash-measurements | overlay | yes (306) | yes | yes | yes |

## Received (ffprobe, video packet timestamps)

| Sink | Segments | Seconds | Gaps | Missing frames | Gaps at stream stop (not counted) |
|---|---|---|---|---|---|
| kick | 4 | 185 | 0 | 0 | 0 |
| twitch | 4 | 185 | 0 | 0 | 0 |
| youtube-h | 4 | 183 | 0 | 0 | 0 |
| youtube-v | 3 | 167 | 0 | 0 | 0 |

## Load

Max over the samples: system CPU 100% (the stack 10.8%, everything else 10.8%), GPU 30%, NVENC 100%, VRAM 2377 MB, NVENC sessions 3.

Frame losses (host counters read every second; load from the nearest sample; CPU % of all cores):

| t (s) | Render lagged | Encode skipped | Dropped | Script action in the 3 s before | System CPU % | Stack CPU % | Other CPU % (top) | GPU % | NVENC % |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 0 | 0 | - | 100 | - | - | 25 | 100 |

Host warnings after the stream start (t in s):

- 220: `[host] sink record-v did not stop in 5000 ms; forcing`

## Logs

- host: 601 lines, 0 error-level; known benign: 1x libobs plugin probe (no OBS frontend in the host); logged at load, no effect.
- core: 6 lines, 0 error-level.
- ui: 19 lines, 0 error-level.

