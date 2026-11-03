# Ujwalam alpha changelog

One section per alpha build (`0.1.0-alpha.N`, D133). The packager copies the section for the build into the zip as `CHANGELOG-alpha.md`.

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
