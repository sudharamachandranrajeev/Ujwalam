# Ujwalam alpha changelog

One section per alpha build (`0.1.0-alpha.N`, D133). The packager copies the section for the build into the zip as `CHANGELOG-alpha.md`.

## 0.1.0-alpha.24 — 2026-11-11

- Nine full studio themes (four reference designs and five reworked ones) using bundled open-licence fonts (Inter, Exo 2, Barlow). Switch "theme-components" (off) turns on their buttons, tabs, cards and edges; Settings > Appearance > Preview all components shows them. Every theme passes the contrast check.
- Live updates (switch "service-swap", off; read at start): the event core, the control page server and the studio window can be replaced with a new version while you stream, after one Apply now click on the control page. A video engine (host) update waits until every stream and recording has stopped, gets a trial start, and falls back to the previous version if it fails. Every update is checked against its release fingerprints and runs from a checked, read-only copy.
- Installing a new build while Ujwalam runs no longer touches the running files: the new version goes beside the old one and, with "service-swap" on, is handed to the running app's update queue. Otherwise it runs from the next start.
- Learning from your own streams (switches "learning-review" and "learning-train", off): after a stream, unsure reads can be confirmed with one click, and a game pack tune is proposed only when it reads held-out streams better; it never applies itself.
- Scene builder (switch "scene-builder", off, command line for now): build H and V scenes from a reference picture, make a theme from it, save a studio scene as a package, edit it, and make similar variants. Importing never changes existing scenes, layers or devices.
## 0.1.0-alpha.23 — 2026-11-10

- Live streams now record both the main (H) and vertical (V) picture, so kill montages and match reels are made in the background after a stream. The V recording uses the vertical stream's encoder; if YouTube V is off, only H is recorded.
- Record while live (Settings > Clips, on): Start stream also starts recording, and the recording stops when every stream has stopped. A recording you start or stop yourself is never taken over or stopped by this.
- Live clipping that cannot run (missing Python, ffmpeg, the clip worker, or a clipper that keeps crashing) now stops the readiness check with the reason and the fix. The task panel shows a "Live clips" row while live, and says why reels were not made.
- The layer selected in the layer list is the one that moves and resizes on the preview, even under other layers; a click on the preview selects that layer in the list. Dragging is smoother, and handles keep their size at 125 and 150 % display scaling.
- Settings > Preview: "Snap to preview edges and other layers", off by default. Hold Alt to turn snapping off for one drag.
- The app package now includes the posting rules, posting schedule, clip targets and stream options files (alpha.22 missed them, which caused the "auto-post-rules.json: file missing" notice). A build missing any data file the services read now fails.
- Task panel: a "Clear finished" button removes all done and failed tasks.
## 0.1.0-alpha.22 — 2026-11-10

- The background of the main and vertical scenes is now a blurred copy of your game capture, filling the whole screen behind every other layer. Your existing scenes are updated once when Ujwalam starts (a backup of the project is kept); your own layer moves and added layers stay as they are. If the capture card is not set up yet, the scene waits and is updated on a later start.

## 0.1.0-alpha.21 — 2026-11-10

- Correction: alpha.20 did not contain the round/match-end and match-type changes its notes listed (a merge mistake). They are in this build.
- Match reels show only your own kills: no loadout screen, no round intro and no teammate you watch after dying. A Search and Destroy reel that counts because of one strong round shows that round.
- Ujwalam also reads the match type from the post-match header, and counts your kills more accurately (one kill line is no longer counted twice in most cases).
- Match reel files say victory or defeat and your kill count.
- Impact-play reels (switch "impact-play-reels", off): a separate reel from the MVP animation through the impact-play camera to the results page, when the impact play is yours.
- Capture cards and cameras plugged in after Ujwalam starts: a layer for a device that is not connected is added and waits; it connects by itself when you plug the device in, and goes back to waiting when you unplug it. The stream and recording keep running.
- Layers: a delete button (asks first), move and resize on the preview with edge handles, crop with Alt+drag or the crop boxes, drag to reorder in the layer list. Every slider takes a click, a typed value and the arrow keys.
- Settings > Stream (switch "stream-settings", off): canvas, frame rate, encoder, bitrates and your stream outputs with add, edit and delete, checked against each platform's limits.
- Outputs panel in the main window (switch "outputs-panel", off): one switch per output; while live, "yes, on air" switches just that output on or off.
- Transitions per canvas with easing curves, "mirror main canvas" for the vertical canvas, and Force complete.
- Settings > Integrations (switch "integrations", off): Streamer.bot and Speaker.bot address, port and a test button; "Allow remote connections" stays off unless you turn it on, and then only on your home network with a pairing code.
- Settings > Connections (switch "platform-connect", off): sign in to YouTube or Twitch, or paste a stream key and server, from the app. Keys stay in Windows Credential Manager; only the last 4 characters are shown.
- Themes: four new themes, a theme picker in Settings, and a High performance mode for lighter memory use. Settings > Advanced no longer opens shifted.
- Data files (switches, posting rules, effect limits, themes) reload while Ujwalam runs; a broken file keeps the last good one.
## 0.1.0-alpha.20 — 2026-11-10

- Search and Destroy and other round modes are no longer split into one "match" per round: only the large end-of-match banner ends a match. Rounds are listed inside the match with your kills per round, so a multi-kill in one round can get a reel.
- Ujwalam reads the match type from the screen (Search and Destroy, Domination, Team Deathmatch, Control and more). When the screen does not show it clearly, the match type stays unknown instead of being guessed.
- Clips made right after a recorded stream now also include kill montages and match reels, after the short clips. A montage problem never stops the short clips.

## 0.1.0-alpha.19 — 2026-11-10

- Background work shows in a panel at the top right. Open it from the button next to My clips: each task shows its step in words, how far it is (for example frame 412 of 3148), time so far and time left, and a Stop button.
- Notices for started, finished and failed work appear at the top right.
- If a task makes no progress for 3 minutes, it says it may be stuck.

## 0.1.0-alpha.18 — 2026-11-10

- Clip making no longer freezes at the start. Since alpha.16 a clip job could stop before reading a single frame and stay at 0 % with no end.
- Finding matches in a recording now reads only the game area of your layout, so the top-3 and mode reading land in the right place.
- Your auto-post rules live in your own data folder and survive updates. `node services/posting/cli.mjs auto --init-rules` makes your copy. The Posts window shows where the file is and has a "Preview auto-post rules" button.
- A privacy policy for the YouTube sign-in (PRIVACY.md).
## 0.1.0-alpha.17 — 2026-11-10

- Windows behave normally: the studio opens on your main screen and comes to the front; preview windows also work with one screen and always fit fully on it.
- Match reels follow your rules: a win in the top 3, a loss in the top 2, more than 20 kills in Hardpoint, Domination or Control, more than 7 in TDM, a Search and Destroy win. A rule only counts when Ujwalam could read what it needs; each run's report says why a match did or did not get a reel.
- Captions start when the words start (they used to start up to several seconds early after a silence).
- Scheduled posting (switch "post-schedule"): a clip whose public time comes within 1 hour gets a new time about 1 h 15 min ahead, at least 1 hour from any other post; clips after it move to stay 6 hours apart. Nothing is scheduled more than 2 years ahead.
## 0.1.0-alpha.16 — 2026-11-09

- Nothing keeps running hidden after you close Ujwalam. Work still going (clip making, uploads) shows in the studio's task bar with time so far and time left, and a short notice when it starts.
- Closing the studio while work is still going asks: keep it running in the tray, stop it, or don't close. The tray icon lists each task with its progress and closes itself when everything is done.
- Closing never ends a stream or a recording. While live, "Stop all" in the tray stops only the background work.
- A clip job that is stopped ends completely, with every program it started.
- Scheduled YouTube posting (switch "post-schedule", off): each new clip is uploaded as private with a public time 6 hours after the last post already scheduled on your channel. If the channel can't be read in full, nothing uploads and the clip waits. An upload is cut off before its public time rather than going public early.
## 0.1.0-alpha.15 — 2026-11-09

- Ujwalam has its own icon: shortcuts, task bar, windows and the control page tab.
- Twitch works with a saved server address that starts with rtmp:// or rtmps:// (Kick stays rtmps://).
- YouTube sign-in opens the full Google page (it was cut short and Google refused it); the link is also printed to paste by hand.
- Commands run from the project folder use the installed app's settings and say which folder they used.
## 0.1.0-alpha.14 — 2026-11-09

- If clips can't be made on this PC (the clip maker's Python is missing; the download does not include Python), Ujwalam says so at start, in the control page and in the studio window, with how to fix it.
- "Ready to go live?" now fails when the sound state can't be read at all, instead of only warning.
## 0.1.0-alpha.13 — 2026-11-09

- Clips found while you play are at least 20 s long (they start a little earlier when needed).
- Auto-post preview (Posts > Preview auto-post rules, with the "posting" switch on; or `node services/posting/cli.mjs auto --preview`): shows what your rules would upload, where, with which title, and why anything is skipped. Nothing is uploaded.
## 0.1.0-alpha.12 — 2026-11-09

- Auto posting: if YouTube received a whole video but its answer got lost, the video is now recorded as posted instead of being retried and marked failed, and it is never uploaded twice.
- New end-to-end checks for auto posting and for clip making.
## 0.1.0-alpha.11 — 2026-11-09

- Live test kit (switch "live-test-kit", off): a strip under the top bar of the studio window says in plain words when game or mic sound is missing, when streams were restarted after a crash, and what happened to chat feedback.
- For the first 10 minutes live it reminds you to start your own Streamer.bot action "Ujwalam test stream" (it posts the feedback question and Speaker.bot reads the test announcement). Ujwalam itself never posts or speaks.
- When a stream ends, viewers' feedback replies are collected into your local feedback file, in the background.
- Fix: the readiness check and stream restart settings were missing from the install package.
## 0.1.0-alpha.10 — 2026-11-09

- Streams can restart by themselves after a host crash (switch "stream-recovery", off): only streams you started with "yes, on air", at most 2 times in 10 minutes, and never if you pressed Stop or End all.
- Stop and End all always win over a Start that is still on its way; if streams cannot be stopped, the control page says so.
- Clips made while you play use the same match filter as clips made after the recording.
## 0.1.0-alpha.9 — 2026-11-08

- Game audio no longer drops out at start (the capture card's sound could stop for a whole session). If game or mic sound stops anyway, Ujwalam says "Game audio missing" and restarts it.
- The studio window no longer closes when a clip job finishes. If it ever crashes, it writes a short report and reopens itself.
- The desktop shortcut starts Ujwalam with no black console window.
- "Ready to go live?" check before streaming (switch "readiness" in the control page): keys, disk, other streaming apps, bots, audio, GPU. "End all streams" stops every stream and keeps the recording.
- Kill montages use all your kills, streaks first; more kills make more montages.
- The clips folder holds only finished videos, one folder per day, with clear names (for example codm_montage_20261108-185824_kills-5_01_v.mp4). Working files stay in the app's own folder. Used live-clip saves are deleted after editing.
- Clips keep every sound track of the recording.
- Auto posting (switches "posting" and "auto-post", plus a rule): clips, montages and match reels upload privately to YouTube after a recording, never while live, with retries. The queue shows in the control page and Posts. Needs the YouTube sign-in set up first.
- Right-click a layer or scene to duplicate, rename or add; add new layers and scenes.
- Themes: Violet Night, Neon Arcade, Studio Light, Tactical, Retro Wave (Settings), with depth, shadow and glow.
- Welcome tour and hints, each with "don't show again"; bring them back in Settings > Help & tips.
- Face background removal and face tracking are built but stay switched off (switch "face-ai") until tested with your camera.
## 0.1.0-alpha.8 — 2026-11-08

- Look panel: select a layer to change its look: rounded corners, filters (sharpen, vignette, film grain, pixelate, posterize, black and white, sepia), camera (mirror, flip, circle or rounded shape with a ring), blend (opacity, add, multiply, screen and more, gradient fade) and shadow and glow. No hidden switch needed; while live, changes wait for Apply and "yes, on air".
- Settings has pages: Clips, Folders, Layer effects ("Show layer effects from the scene") and Advanced (animations: follow Windows, always or off; developer switches).
- Round Start stream, Record, Save clip and Mark moment buttons; slimmer toolbar with icons; scene cards.
- Task bar: long jobs (clip making, imports, uploads) show progress at the bottom without getting in the way, with a short note when they finish.
- Stats cards for the session, GPU, CPU and frame rate.
- Match filter: only matches where you are in the top 3 (or, once you set it, with enough kills) become clips. Matches it cannot read keep their clips.
- First stream scene follows your horizontal and vertical layouts (start once with a rebuild to pick it up).
## 0.1.0-alpha.7 — 2026-11-08

- New look: dark violet panels with rounded corners and a purple accent, after the reference video.
- The top bar fits the screen again (text was cut off at 125 % scaling). Rarely used tools are in the new More menu: Import Meld session, Feedback notes, Posts, Report a problem.
- The audio mixer sits under the previews as cards side by side. Frame stats and service status are in the bar at the bottom.
- The updater's `-ClipMaker` no longer saves clip choices you did not give.

## 0.1.0-alpha.6 — 2026-11-08

- New Settings in the studio window: what to do after you record and after you stream live: ask me each time, make clips when it stops, find the best moments while it runs and edit them into clips when it stops, or no clips.
- Choose where recordings are saved (used from the next start) and where finished clips are saved.
- The first start asks once how you want clips made. "Ask me each time" shows a "Make clips from it?" question after each recording, with "do this every time".
- New My clips button opens the clips folder. The Clips label says what is happening in plain words.
- The updater (`Install-Ujwalam.ps1`) can set the same choices and folders: `-ClipsWhenRecording`, `-ClipsWhenLive`, `-RecordingsFolder`, `-ClipsFolder`, `-ClipMaker`, and `-SettingsOnly` to change settings without installing.
- Clips are never made while you are live; a clip run that is going when a stream starts waits until it ends.

## 0.1.0-alpha.5 — 2026-11-08

- Fix: the H and V previews show inside the studio window; no separate preview windows open.
- One close: closing the studio window stops all of Ujwalam (previews, host, services). While live it first asks for the typed "yes, on air".
- Record works on a normal start: H and V are recorded to `.mkv` files (no stream target needed).
- New Save clip button (the last 60 s of H and V from the replay buffer) and Mark moment button (same as the marker hotkey, `Ctrl+Alt+Shift+M`).
- Shortcuts: "Ujwalam (alpha)" opens the capture devices (game capture, facecam, mic); the new "Ujwalam (alpha, LIVE)" also sets up the stream targets. Going live still needs Start stream and the typed "yes, on air".
- A start with devices rebuilds a scene project that was built without devices; the old one is kept in `projects/_old/`.

## 0.1.0-alpha.4 — 2026-11-08

- Fix: overlays and browser layers were off in alpha.3 when `ujwalam.json` named the `overlays` folder itself (as the 3 Nov install wrote it); that folder is now read as its parent.

## 0.1.0-alpha.3 — 2026-11-08

- The native studio window (Qt) opens by default instead of the browser; `Ujwalam.cmd --shell browser` opens the web control page. Closing the window does not stop a stream.
- Studio window: scenes and layers, an add-layer window, inspector, mixer with mute, CUE, volume and track routing, preview editing with snapping to other layers, undo/redo, feature flags. Panels behind flags stay off until switched on in the flags panel.
- Mixer track routing per sound (flag `mixer-routing`, off), saved to the project.

## 0.1.0-alpha.2 — 2026-11-03

- Live plan: YouTube H 1080p60 at 17 Mbps; YouTube V direct; one shared 1080p60 6000 kbps rung for Twitch and Kick.
- Live-test mode: `--sinks` picks destinations; `--twitch-bandwidth-test` sends Twitch a bandwidth test (received, not broadcast); `--test-stream-minutes N` and `--test-sink-minutes kick=2` arm a guard that stops every output on a failure, a destination not live for more than 10 s, or lost frames above 1 % (after 30 s) or 3 % in any 10 s window. A report is written to `logs/live-test-*.txt`.
- Scene presets: a brand file that is a video plays as a looping layer; a brand file missing from the profile becomes a transparent placeholder instead of failing the scene.
- Post-stream clip pipeline (flag `clip-pipeline`, off): not part of the live path.
## 0.1.0-alpha.1 — 2026-11-05

First Alpha 0 build: a portable zip with `Install-Ujwalam.ps1` (no admin).

- Control page on 127.0.0.1 plus native H and V preview windows (D132); one "Default" scene from the Default H and V presets.
- Real outputs with keys from Windows Credential Manager, only with `--live`; streaming starts only after the typed "yes, on air" on the control page.
- Recording to `.mkv` (crash-safe container).
- Replay buffer H and V (30 s), hotkeys: panic `Ctrl+Alt+P`, feedback `Ctrl+Alt+F`, marker `Ctrl+Alt+Shift+M`.
- Feedback captures and the post-stream feedback form; feature flags (all off).
- New in this build: crash recovery (the launcher restarts the host after an unexpected exit, at most 3 times in 5 minutes, reloads the project, starts a new recording file if one was running, and writes a marker); diagnostics bundle (`Ujwalam.cmd diag`, redacted); install, rollback and version folders under `%LOCALAPPDATA%\Ujwalam`.
- Needs: Windows 11 x64, Node.js 22.13 or newer on PATH, Microsoft Visual C++ 2015-2022 x64 runtime. The installer checks both and stops if one is missing; it installs nothing.
- Known limits: streams are not restarted automatically after a host crash (start them again from the control page); voice notes are not done; real hotkey key presses are UNVERIFIED.
