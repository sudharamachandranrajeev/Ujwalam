# Ujwalam how-to

Plain steps for the alpha build on Windows 11. Brand, channel and account names appear here as placeholders only.
Anything marked UNVERIFIED was read from the code but not run end to end on a real PC.

## 1. Install from the zip

1. Unzip the folder anywhere.
2. In that folder run:
   `powershell -ExecutionPolicy Bypass -File .\Install-Ujwalam.ps1`
   It needs no admin rights. It checks that Node.js (the version in `release.json`, 22.13 or newer) is on PATH and that
   the Microsoft Visual C++ 2015-2022 x64 runtime is installed. If one is missing it says so and stops. It installs
   nothing itself.
3. It checks every file against `SHA256SUMS.txt`, copies the build to `%LOCALAPPDATA%\Ujwalam\<version>`, keeps the
   previous version, and adds Start-menu and desktop shortcuts.
4. Roll back to the previous version:
   `powershell -ExecutionPolicy Bypass -File .\Install-Ujwalam.ps1 -Rollback`
   Run it again to switch forward. Nothing is deleted.

## 2. First launch

1. Copy `data\profile.example.json` (inside the installed version folder) to
   `%LOCALAPPDATA%\Ujwalam\data\profile.local.json` and fill in your own values. Without this file nothing starts.
   The file stays on your PC.
2. Start the "Ujwalam (alpha)" shortcut, or run `%LOCALAPPDATA%\Ujwalam\Ujwalam.cmd`.
3. Useful flags (add them after `Ujwalam.cmd`):
   - `--allow-devices` opens the capture devices (game capture, facecam, microphone).
   - `--live` configures the real stream targets. Streaming still only starts after the "yes, on air" step below.
   - `--mock --no-open --stop-on-stdin` is a smoke test with no Streamer.bot and no browser.
4. Your data lives in `%LOCALAPPDATA%\Ujwalam\data` (projects, logs, feedback, markers, recordings).

## 3. The control page

The launcher opens the control page in your browser on 127.0.0.1 (this PC only). It has scenes, layers (H and V tabs),
two preview windows, the audio mixer, the Bots card, feature flags, a Feedback button, a Posts button (when the posting
flag is on), Record and Start stream. Preview windows open without taking focus; "Bring to front" raises one.

## 4. Starting a test stream

Ujwalam never goes live on its own.

1. Start with `Ujwalam.cmd --allow-devices --live`. Stream keys come from Windows Credential Manager only; they are
   never written to a file, log or message.
2. Check the control page and the previews. Ask for the test: the project rule is that a test begins only when you say
   "start stream test".
3. On the control page press **Start stream**. A confirmation box asks you to type **yes, on air**. Only then does
   streaming start.
4. A test runs about one hour. Optional guards (need `--live`): `--sinks youtube-h,youtube-v,twitch,kick` picks
   destinations; `--test-stream-minutes N` stops all outputs after N minutes or at once if a destination fails.
5. To end it, stop the stream from the control page (or close the launcher). Check every destination has stopped.

## 5. Hotkeys

Global hotkeys are switched on by the launcher in alpha mode:

| Keys | What it does |
| --- | --- |
| Ctrl+Alt+P | Panic (runs the event core panic action) |
| Ctrl+Alt+F | Feedback capture (saves a moment for the Feedback form) |
| Ctrl+Alt+Shift+M | Marker (a timestamp for finding clips later) |

If another program holds a combo, replace it: `--hotkey-panic COMBO`, `--hotkey-feedback COMBO`,
`--hotkey-marker COMBO` (or `off`). Real key presses on a live PC are UNVERIFIED.

## 6. Feature flags

New features are off by default. The control page has a "Feature flags" card; switch a flag there, also while live.
The flags in this build: `clip-pipeline`, `chat-effects`, `posting`, `bot-manager`, `test-broadcast`, `report-button`.
The state is kept per PC in the event-core data folder (`flags.local.json`).

## 7. Recording and replay

- **Record** on the control page writes an `.mkv` file (it survives a crash). Files go to the host data folder
  under `recordings`.
- The replay buffer (H and V, 30 seconds) starts with the launcher. Feedback captures save the last seconds.
- If the host crashes, the launcher restarts it (at most 3 times in 5 minutes), reloads the project and starts a new
  recording file if one was running. A running stream is not restarted; start it again yourself.

## 8. Clips and the posting review

The clip pipeline and posting are off by default. Turn on `clip-pipeline` and `posting` on the control page first.
The clipper is Python and lives in the source checkout, not in the zip (the zip has no `.py` files, so this part is
for the checkout; UNVERIFIED for an unzipped build).

1. Make clips after a stream, from the source checkout:
   `python -I services/clip/clipper.py run --recording <file.mkv> --out <folder outside the repo>`
   (subcommands: `candidates`, `render`, `validate`, `run`).
2. Package them for review:
   `node services/posting/cli.mjs package --run <clip run folder>`
3. Open **Posts** on the control page. Read each package, edit the text, then Approve or Reject.
4. Optional private YouTube upload (nothing is public):
   `node services/posting/cli.mjs youtube signin` (opens your browser once; needs your own OAuth client set up),
   `node services/posting/cli.mjs youtube status`,
   `node services/posting/cli.mjs youtube upload --id <post id>`,
   `node services/posting/cli.mjs youtube signout`.
   Upload is refused while a stream is live.

## 9. Backup and restore

Backup and restore run from the source checkout (the zip does not carry them; UNVERIFIED for an unzipped build).
They need 7-Zip installed and `paths.backup_dir` set in `data/profile.local.json`.

- Set the backup password once (Windows Credential Manager target `Ujwalam/backup`; you keep it, it is never written
  to a file): `node services/event-core/cli.mjs credential set --target Ujwalam/backup --stdin`
- Make a backup: `node tools/backup-local.mjs` (add `--dry-run` to preview, `--keep N` to move older archives to
  `_to_delete`). A nightly scheduled task can run it.
- Restore, in safe steps (`npm run restore -- <command>` also works):
  1. `node tools/restore-local.mjs list` shows archives, newest first.
  2. `node tools/restore-local.mjs verify <archive>` tests the archive.
  3. `node tools/restore-local.mjs restore <archive>` unpacks into a fresh folder under
     `%LOCALAPPDATA%\Ujwalam\restore\<timestamp>`. Nothing live changes. Look at the files.
  4. `node tools/restore-local.mjs apply --from "<that folder>" --confirm "yes, restore"` copies them into place.
     Every file it replaces is first moved to `_to_delete\<timestamp>\` next to it. Nothing is deleted.

## 10. Diagnostics bundle

When something breaks, make a redacted bundle (no keys, tokens, chat text or your home folder name):

- Installed build: `Ujwalam.cmd diag` (writes to `%LOCALAPPDATA%\Ujwalam\data\diag\`).
- Source checkout: `npm run diag` (needs `--data-dir <event-core data dir>`).

Look it over before you send it to anyone.

## 11. Fix the Twitch server address (rtmps)

If the stored Twitch server address starts with `rtmp://`, a test stream will fail. Set it again with the same host
and `rtmps://` in front (no port needed), for example `rtmps://<region>.contribute.live-video.net/app`:

`node services/event-core/cli.mjs credential set --target Ujwalam/stream/twitch-server`

`credential status --target Ujwalam/stream/twitch-server` only warns about a `?` suffix; it does not check the scheme.
