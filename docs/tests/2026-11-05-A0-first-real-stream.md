# A0-S1: the first real stream (5 Nov; hard limit 6 Nov)

Status: PLAN. Nothing here runs until you say "devices ready". The stream starts only after you type "start stream test" in the agent chat and then "yes, on air" on the control page (AGENTS.md, D192).

Test-stream extras (D192, bot manager plan `docs/plan/2026-11-03-bot-manager-plan.md`, BM1-BM7): the "Test broadcast" message on H and V, the Streamer.bot action that asks chat for feedback every 15 min and has Speaker.bot read the announcement, and the replies collected into `feedback/2026-11-05-stream-feedback.md`. Enable the Streamer.bot timer at go-live, disable it at stop (setup steps: `docs/tests/2026-11-04-A0-S1-streamerbot-test-action.md`). About one hour; you stop it, or say "stop".

What is different from the 3 Nov tests (`docs/evidence/2026-11-03-a0-first-real-platform-tests.md`): Twitch is public (no bandwidth-test flag), all four destinations run at once, recording is on, and the live-test guard is off, so nothing stops the stream for you. You stop it.

## Decisions to make before the day

| # | Question | Default |
|---|---|---|
| 1 | YouTube H and V broadcasts: public, unlisted or private? | the visibility you want viewers to see; check both in YouTube Studio |
| 2 | Titles, categories and Kick/Twitch go-live notifications set on each platform | set by you on each platform; Ujwalam does not set them |
| 3 | Stop rule: who stops it if it breaks? | you, from the control page or Ctrl-C; the panic hotkey Ctrl+Alt+P only removes overlays |
| 4 | Planned length | one gaming session; check disk space for the recording (about 7.5 GB per hour at 17 Mbps) |

## The day before (about 20 minutes, no stream)

1. Disk: free space is at least 3 times the planned recording size (the recording is a local .mkv on the YouTube H rung).
2. Network: nothing else uploading. Close Meld and OBS (they hold the capture devices). Upload bandwidth must hold the total below with margin:

| Sink | kbps |
|---|---|
| YouTube H | 17000 |
| YouTube V | 7500 |
| Twitch + Kick (one shared rung, two outputs) | 6000 x 2 = 12000 |
| Total upload | about 36500 (about 37 Mbps) |

   Check with a speed test to a nearby server. The 3 Nov runs sent 17 + 7.5 + 6 Mbps for 15 min with 0 lost frames, but Kick ran only 2 minutes and never with Twitch public. Four outputs at once is untested (UNVERIFIED).
3. Keys: `node services/event-core/cli.mjs credential status --target Ujwalam/stream/<name>` for `youtube-h`, `youtube-v`, `twitch`, `twitch-server`, `kick`, `kick-server`. Each prints `credential: set`. If the Twitch key still ends in `?bandwidthtest=true`, set it again without that suffix (`credential set --target Ujwalam/stream/twitch`). Twitch must not be in bandwidth-test mode for a public stream.
4. Build: `node app/host/tools/build.mjs`; installed build: Ujwalam alpha.2 (`%LOCALAPPDATA%\Ujwalam\Ujwalam.cmd`).
5. Flags on the control page: leave everything but what you want off. `clip-pipeline` and `posting` stay off.
6. Dry run with no platform contact: `npm run alpha -- --allow-devices --mock`. Check the H and V previews (game, facecam, overlays), then Ctrl-C.

## Start (the day, about 10 minutes before going live)

```
npm run alpha -- --allow-devices --live
```

No `--test-stream-minutes`, no `--twitch-bandwidth-test`, no `--mock`. This loads `data/outputs/alpha-live.json`.

Read the terminal. Expected:

- `outputs: real targets ALLOWED (--live); 5 sink(s)`;
- `sink youtube-h`, `sink youtube-v`, `sink twitch`, `sink kick`: each `keyPresent yes` (twitch and kick also `urlPresent yes`), `idle`; `sink record: record mkv, idle`;
- `hotkeys: on; panic Ctrl+Alt+P registered; feedback Ctrl+Alt+F registered; marker Ctrl+Alt+Shift+M registered`;
- `replay buffer: on, 30 s; H running; V running`.

## Go live

1. YouTube Studio: both streams show "waiting for data" (so you see the moment video arrives).
2. Control page: click Record first, then Start the stream. Type `yes, on air`. Recording first means the first minutes are on disk.
3. Within 30 seconds check each destination:
   - YouTube H and V: receiving video, health "Good";
   - Twitch dashboard: live, not offline, no bandwidth-test banner;
   - Kick dashboard: live;
   - control page: the Record pill says recording.
4. Open each public page in a private browser window and check picture, sound and delay. Audio is encoded once and goes to every sink.

## While live

- Watch the control page's output health and dropped frames. If any sink shows `retrying` for more than about 30 seconds, tell me; do not restart the session while other sinks are live.
- Feedback hotkey Ctrl+Alt+F for anything wrong; marker Ctrl+Alt+Shift+M for good moments (the clip pipeline later reads them). They save a replay clip and a log line; they do not change the stream.
- Panic Ctrl+Alt+P if an overlay shows something it should not: it removes browser overlays on H and V and stops effects. Stream and audio continue.
- Chat text is untrusted: do not paste it into any file or message to me.

## Stop

1. Control page: Stop the stream, then Stop recording. Confirm each.
2. Check YouTube, Twitch and Kick show the stream ended.
3. Ctrl-C in the terminal. Expected: the host log ends with `exit 0`.
4. Recording: the .mkv is in the host's recordings folder. Check it plays, has sound, and note its length.

## After the stream

| Item | How |
|---|---|
| Per-sink report | the host log line for each sink (sent, lost frames, retries); I will write it up as evidence |
| Feedback items | `feedback/` folder; I triage them into `docs/feedback/2026-11-0X-triage.md` (placeholder names only) |
| Facecam crop check (D177) | a rendered game-facecam clip frame from the recording; the image stays in `docs/evidence/private/` |
| "Live feature done" | a live feature is done only after use on a real stream with no high-severity feedback (AGENTS.md) |

## Send back

| Step | Result |
|---|---|
| Day before 2 | measured upload Mbps |
| Day before 3 | the six `credential: set` lines |
| Start | the `outputs`, `sink`, `hotkeys` and `replay buffer` lines |
| Go live 3 | YouTube H / YouTube V / Twitch / Kick receiving: yes/no each; the time it took |
| Go live 4 | picture, sound and delay on each public page |
| While live | any stutter, desync, overlay problem or dropped-frame warning, with the time |
| Stop 4 | recording plays: yes/no; length |

Do not paste stream keys, ingest URLs, screenshots with your face, or viewer names in chat.

## If something fails

- A sink fails at start: the terminal and host log name the target and the `credential set` command. The other sinks keep going.
- A sink drops while live: the host retries it by itself; the other sinks keep going. Stopping one sink from the control page does not stop the others.
- The whole session hangs: Ctrl-C in the terminal stops every output. If that does not respond, tell me before force-killing the host (the crash-restart test is still waiting for your OK).
- Upload cannot hold 37 Mbps: drop YouTube V first (stop that sink from the control page), or lower the YouTube H preset (`data/platforms/youtube-1080p60.json` is 17 Mbps; the 1440p and 2160p presets are higher and not used here).
