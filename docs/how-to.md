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
2. Start the "Ujwalam (alpha)" shortcut (opens the capture devices; Record, Save clip and Mark moment work), or the
   "Ujwalam (alpha, LIVE)" shortcut (also sets up the stream targets). Or run `%LOCALAPPDATA%\Ujwalam\Ujwalam.cmd`.
   The studio window (Qt) opens by default, with the H and V previews inside it. Closing it stops all of Ujwalam.
   `Ujwalam.cmd --shell browser` opens the web control page instead.
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

## 6a. Scenes and layers: add, copy, rename (right-click)

In the studio window, right-click a layer in the Layers list (or a scene in the Scenes list) for a short menu. The small **+**
above each list adds a layer or a scene. None of this needs a feature flag. It all stops while you are live (the items are
grey and say "Not while live"); the project file is saved at once.

| Where | What it does | Keys (list has focus) |
| --- | --- | --- |
| Layer menu: Add layer... | Pick what to add: a copy of a layer, a colour, text, a camera, an overlay, a picture or a video. A kind the project cannot supply is grey. | |
| Layer menu: Duplicate | A copy right above the layer, named "<name> copy", with the same position, size and look. Pictures, text, colours and overlays are copied. A camera or capture card cannot be opened twice, so its copy shows the same camera. | Ctrl+D |
| Layer menu: Rename... | Change the name (1 to 80 letters). | F2 |
| Layer menu: Show / Hide, Move up, Move down, Move to top, Move to bottom | The same as the buttons under the list. | |
| Layer menu: Copy look, Paste look | Copy a layer's look (rounded corners, blur and so on) and put it on another layer. | Ctrl+Shift+C, Ctrl+Shift+V |
| Layer menu: Look... | Jumps to the Look panel. | |
| Layer menu: Delete... | Asks first. Needs "scene editing" switched on in Settings > Advanced (it removes things for good). | Del |
| Scene menu: Add scene... | Asks for a name. The scene is made for both pictures (H and V). | |
| Scene menu: Add layer..., Rename..., Duplicate scene | Duplicate scene copies the scene with all its layers. | F2 on a scene to rename |
| Scene menu: Delete... | Asks first. Needs scene editing on. The scene the project starts with cannot be deleted. | Del |

Show / Hide, Move and Paste look still work while live; they ask for "yes, on air" as before.

## 6b. Help, tips and the welcome tour

- The round **?** button at the top of the window opens the help panel. It has two sections, "How clips are made" and "Posting your clips". Each has a **Show me** button that points at the real controls. The panel also says what posting does today: nothing is sent unless you type your yes.
- **Replay the welcome tour** is at the bottom of the help panel and in Settings > Help & tips.
- The first time you open the studio, a short tour walks through the window. Skip it any time. Tick "Don't show this again" to keep it away.
- Small tips appear the first time something happens (a recording stops, a clip run starts, you go live). A tip hides itself after about 8 seconds; hover it to keep it. Use "Don't show this again" on a tip to silence that one.
- Settings > Help & tips: switch tips off, reset every "Don't show this again", or replay the tour. These choices are saved in settings.json and can be changed while live.

## 7. Recording and replay

- **Record** on the control page writes an `.mkv` file (it survives a crash). Files go to the host data folder
  under `recordings`.
- The replay buffer (H and V, 30 seconds) starts with the launcher. Feedback captures save the last seconds.
- If the host crashes, the launcher restarts it (at most 3 times in 5 minutes), reloads the project and starts a new
  recording file if one was running. A running stream is not restarted; start it again yourself.

## 8. Clips and the posting review

### Clips from your recordings and streams

Open **Settings** in the studio window. Two choices, one for recording and one for streaming live:

- **Ask me each time**: after you stop, Ujwalam asks "Make clips from it?". Tick "do this every time" to stop asking.
- **Make clips automatically when I stop**: the whole recording is searched for its best moments and edited into
  clips after it stops.
- **Find the best moments while I record (or stream), then edit them into clips**: moments are picked while it runs;
  the clips are made after it stops.
- **Don't make clips.**

A recording made during a stream follows the live choice. Clips are never made while you are live (the graphics card
is busy); a run waits until the stream ends. **My clips** opens the folder with the finished clips.

Settings also has two folders: **Recordings** (used from the next start) and **Finished clips**. Leave them on Default
to keep them in the Ujwalam data folder. Folders inside the app folder are refused.

The clip maker is Python and is not in the zip. Point an install at a source checkout that has it:
`Install-Ujwalam.ps1 -SettingsOnly -ClipMaker C:\path\to\checkout`. The same updater sets the choices and folders
without installing anything: `-ClipsWhenRecording ask|after|while|off`, `-ClipsWhenLive ask|after|while|off`,
`-RecordingsFolder <folder>`, `-ClipsFolder <folder>` (`''` = default).

### Which matches become clips

The clip maker splits a recording into matches at the end screens (VICTORY or DEFEAT, the top-3 screen, MVP, Impact
Play, the final killcam). For each match it then checks two rules:

- **Top 3** (on by default): you are on one of the three cards of the top-3 screen. Ujwalam finds your card by the
  in-game names in your profile.
- **Kills** (off by default): you took at least this many kills in the match. Kills come from the final scoreboard
  when it is shown, otherwise from your lines in the kill feed.

A match passes when any rule that is on holds. Its clips are made; the clips of the other matches are skipped. When
Ujwalam is not sure, it keeps the clips. That happens when no end screen was seen (a match cut off by the end of the
recording), when the top-3 screen or the kills could not be read, or when no profile names are set.

There is no switch for this in the studio window yet. Set it in `settings.json` in the Ujwalam data folder:

```json
{ "clips": { "matchGate": { "top3": true, "minKills": null } } }
```

`minKills` is `null` (kills rule off) or a whole number from 1 to 200. With both rules off (`"top3": false,
"minKills": null`) every match keeps its clips.

Each run writes `matches.json` next to the clips. It lists every match with its time, result, your top-3 place and
score, your kill count and where that count came from, and why it passed or was skipped. Skipped clips stay in
`candidates.json` under `gatedOut`; run `clipper.py gate --recording <file.mkv> --out <run folder>` again after
changing the setting, then `render`. Moments saved while live are sorted the same way when the review gets
`--matches <run folder>/matches.json`.

The top-3 screen is checked on one practice match (UNVERIFIED for DEFEAT and other modes). The scoreboard kill count
is UNVERIFIED: no final scoreboard has been captured yet.

### By hand and the posting review

Posting is off by default. Turn on `posting` on the control page first.
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
