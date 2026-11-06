# Stream test checklist: the first real test stream (2026-11-06)

This is the step-by-step list for the first real test stream. It builds on `docs/tests/2026-11-05-A0-first-real-stream.md` (the detailed plan) and the mock run of 6 Nov (`docs/evidence/2026-11-06-stream-day-mock-run.md`).

Two gates, both yours, in this order:

1. You type **start stream test** in the agent chat.
2. You type **yes, on air** in the confirm box on the control page.

The agent never goes live by itself. It never types either phrase for you, and it never reads or writes a stream key.

Never paste a stream key, an ingest URL, a screenshot with your face, or a viewer's name into the chat or any file.

---

## 1. The day before (about 30 minutes, nothing goes live)

### 1.1 Things only you can do

| # | What | How | Done when |
|---|---|---|---|
| 1 | **Twitch server: change rtmp to rtmps** | Run `node services/event-core/cli.mjs credential set --target Ujwalam/stream/twitch-server`. When it asks, paste your Twitch ingest address with `rtmp://` changed to `rtmps://`. Keep the same server name and `/app`, and add no port. The plan sends Twitch over rtmps, so the old `rtmp://` value will fail. | `credential status --target Ujwalam/stream/twitch-server` prints `credential: set` |
| 2 | **All six keys present** | For each of `youtube-h`, `youtube-v`, `twitch`, `twitch-server`, `kick`, `kick-server`: `node services/event-core/cli.mjs credential status --target Ujwalam/stream/<name>` | six lines `credential: set`, and no `WARNING` (a Twitch key that ends in `?bandwidthtest=true` must be set again without that ending) |
| 3 | **Mic check (FIFINE)** | Start the dry run (step 1.2). Watch the mic meter in the control page mixer. Speak normally, then loudly. | The meter moves with your voice and is not stuck at the top or the bottom. Tell the agent the normal and loud levels. They are needed to confirm the cam-pop `spikeLevel` (0.12) and the audio live-marker threshold. Both are still `proposed`. |
| 4 | **Facecam check** | In the dry run, look at the H and V previews. | Your face is fully inside the facecam frame on H and on V, and nothing important is cut off on V. |
| 5 | **Facecam rectangle (for clips, not needed to stream)** | Optional before the stream. After the stream, mark where the facecam sits in a recorded frame. | Can wait until after the stream. Only the post-stream "game + facecam" clip layout needs it. |
| 6 | **Platform settings** | On each platform: title, category, and visibility (YouTube H and V: public, unlisted or private). Ujwalam does not set these. | You picked them |
| 7 | **Upload speed** | Run a speed test with nothing else uploading. | At least about 45 Mbps upload. The four outputs need about 37 Mbps (17 + 7.5 + 6 + 6). |
| 8 | **Disk** | Free space on the recordings drive | At least 25 GB (an hour of recording is about 7.5 GB) |
| 9 | **Close other video apps** | Close Meld Studio and OBS, which hold the capture devices and the encoder. | `Get-Process MeldStudio*` shows nothing |

### 1.2 Dry run (no platform contact)

```
npm run alpha -- --allow-devices --mock --rebuild-alpha
```

`--rebuild-alpha` is needed only once, so the project picks up the latest layers (the old one moves to `projects/_old/`).

Check:

- H and V previews show game, facecam and overlays.
- Turn the `test-broadcast` flag on in the control page: within 5 seconds the "test of new streaming software" note appears on H and V, and nothing is cut off on V. Turn it off again.
- A chat message shows in the chat overlay. This means Streamer.bot (port 8093) reaches Ujwalam.
- With Streamer.bot and Speaker.bot running: `node tools/bot-clash-check.mjs` prints `CLASHES: none`.

Stop with Ctrl-C. The terminal ends without errors.

### 1.3 Flags for the test

| Flag | For the test | Why |
|---|---|---|
| `test-broadcast` | ON at go-live | Shows viewers the test message at the start and every 15 minutes |
| `live-markers` | your choice (recommended ON) | Writes clip markers on "clip it" chat and chat spikes. Thresholds are `proposed`, and a marker can never affect the stream. The mock run produced chat markers as expected. |
| `chat-effects` | ON (user's choice, 2026-11-06) | Chat-fired effects. The guards (budget, cooldown, flash limit of 3 per second) held in the mock run. If an effect misbehaves, switch the flag off on the control page; it takes effect live. |
| `posting`, `auto-post` | OFF | Post-stream only. Nothing uploads during a stream. Since 6 Nov, `auto --run` also refuses while the studio's host is running. |
| `clip-pipeline` | OFF | Post-stream only |

---

## 2. Start (about 10 minutes before going live)

```
npm run alpha -- --allow-devices --live
```

Read the terminal. You should see:

- `outputs: real targets ALLOWED (--live); 5 sink(s)`
- `sink youtube-h`, `sink youtube-v`, `sink twitch`, `sink kick`: each says `keyPresent yes` and `idle` (Twitch and Kick also say `urlPresent yes`)
- `sink record: record mkv, idle`
- `hotkeys: on` with panic Ctrl+Alt+P, feedback Ctrl+Alt+F and marker Ctrl+Alt+Shift+M registered
- `replay buffer: on, 30 s; H running; V running`

If any of these is missing, stop and send the agent the line (never a key or URL).

## 3. The two gates

1. In the agent chat, type: **start stream test**
2. YouTube Studio: both streams show "waiting for data".
3. On the control page, click **Record** first and confirm. Then click **Start the stream**, and in the confirm box type **yes, on air**.
4. Turn on the `test-broadcast` flag.
5. In Streamer.bot, turn on the timed feedback action and run it once by hand. Speaker.bot reads the announcement.

## 4. First 2 minutes: check every destination

| Destination | Check |
|---|---|
| YouTube H | receiving video, health "Good" |
| YouTube V | receiving video (9:16), health "Good", nothing important cut off |
| Twitch | live, no "bandwidth test" banner |
| Kick | live |
| Control page | Record pill says recording, dropped frames 0 |

Open each public page in a private browser window. Check picture, sound and delay.

## 5. During the hour

- The test message shows at the start and every 15 minutes (`test-broadcast` flag). Speaker.bot reads the announcement.
- The Streamer.bot action asks chat about video, audio, scenes, lag and anything broken. Ujwalam only reads the replies. It never posts to chat.
- Watch the control page: output health and dropped frames. If any destination shows `retrying` for more than about 30 seconds, tell the agent. Do not restart Ujwalam while the other destinations are live.
- **Ctrl+Alt+F**: something looks or sounds wrong. This saves a replay clip and a note for later.
- **Ctrl+Alt+Shift+M**: a good moment for a clip.
- **Ctrl+Alt+P** (panic): an overlay shows something it should not. This removes the overlays and stops effects. The stream and audio keep going.
- Do not paste chat text into any message or file for the agent.

## 6. Stop (after about one hour, or when you say "stop")

1. In Streamer.bot, turn off the timed feedback action.
2. On the control page, click **Stop the stream** and confirm. Then click **Stop recording** and confirm.
3. Check that YouTube H, YouTube V, Twitch and Kick all show the stream ended.
4. Turn off `test-broadcast`.
5. In the terminal, press Ctrl-C. The host log ends with `exit 0`.
6. Check that the recording (.mkv in the recordings folder) plays and has sound. Note its length.
7. Check that nothing is left running: `Get-Process ujwalam-host, ffmpeg -ErrorAction SilentlyContinue` shows nothing.

## 7. After the stream: feedback and summary

1. Collect viewer replies (local file only, gitignored):
   `node tools/collect-stream-feedback.mjs --date YYYY-MM-DD --question-prefix "Test stream feedback:"`
   This writes `feedback/YYYY-MM-DD-stream-feedback.md`.
2. Tell the agent the stream is over. The agent:
   - triages `feedback/` into `docs/feedback/YYYY-MM-DD-triage.md`, with placeholder names only;
   - writes the per-destination report from the host log (sent, lost frames, retries) as evidence;
   - writes a plain-language summary: what worked, what failed, what to fix.
3. Send the agent the small table below.

| Step | Your answer |
|---|---|
| 1.1 #2 | six `credential: set` lines (yes/no) |
| 1.1 #3 | mic levels: normal and loud |
| 2 | the `outputs`, `sink`, `hotkeys` and `replay buffer` lines |
| 4 | YouTube H / YouTube V / Twitch / Kick receiving: yes/no each, and how long it took |
| 5 | any stutter, audio problem, overlay problem or dropped-frame warning, with the time |
| 6 | recording plays: yes/no, and its length |

## If something goes wrong

| Problem | What to do |
|---|---|
| One destination fails at start | The others keep going. The terminal names the target and the `credential set` command to run. Twitch failing at once usually means step 1.1 #1 (rtmps) was not done. |
| One destination drops while live | The host retries it by itself, and the others keep going. |
| Upload cannot keep up | Stop YouTube V first from the control page. |
| Ujwalam hangs | Ctrl-C in the terminal stops every output. If that does not work, tell the agent before you force-close anything. |
| An overlay misbehaves | Ctrl+Alt+P (panic) |
