# Ujwalam alpha changelog

One section per alpha build (`0.1.0-alpha.N`, D133). The packager copies the section for the build into the zip as `CHANGELOG-alpha.md`.

## 0.1.0-alpha.9 — 2026-11-08

- Game audio no longer drops out at start (the capture card's sound could stop for a whole session). If game or mic sound stops anyway, Ujwalam says "Game audio missing" and restarts it.
- The studio window no longer closes when a clip job finishes. If it ever crashes, it writes a short report and reopens itself.
- The desktop shortcut starts Ujwalam with no black console window.
- "Ready to go live?" check before streaming (switch "readiness" in the control page): keys, disk, other streaming apps, bots, audio, GPU. "End all streams" stops every stream and keeps the recording.
- Kill montages use all your kills, streaks first; more kills make more montages.
- The clips folder holds only finished videos, one folder per day, with clear names (for example codm_montage_20261108-185824_kills-5_01_v.mp4). Working files stay in the app's own folder. Used live-clip saves are deleted after editing.
- Clips keep every sound track of the recording.
- Auto posting (switches "posting" and "auto-post", plus a rule): clips, montages and match reels upload privately to YouTube after a recording, never while live, with retries. The queue shows in the control page and Posts. Needs the YouTube sign-in set up first.
- Several layer looks, themes and the welcome tour from the last builds; face background removal and tracking stay switched off (switch "face-ai").
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
