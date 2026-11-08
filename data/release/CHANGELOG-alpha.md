# Ujwalam alpha changelog

One section per alpha build (`0.1.0-alpha.N`, D133). The packager copies the section for the build into the zip as `CHANGELOG-alpha.md`.

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
