# A0-S1: bot clash check list (BM7)

Run before the first real stream test, with Streamer.bot and Speaker.bot running (start them from the Bots card or by hand).
Nothing here goes live. Tick each line and write the result in the evidence file for the stream.

## 1. Run the checker (read-only, 10 seconds)

    node tools/bot-clash-check.mjs

Add `--json` for a machine-readable copy. Exit 0 = no clash, 1 = a clash, 2 = a check could not run.

- [ ] Exit is 0 (or every clash is explained and fixed).
- [ ] Both bots show "ok" on their own ports (8083 Speaker.bot, 8093 Streamer.bot). A "free" port with the bot running means
      the bot's WebSocket server is off: switch it on in the bot's settings.
- [ ] No port shows "clash". If one does: close the other program, or move that bot port in the bot's own settings, then re-run.
- [ ] "Ujwalam code scan" shows 0 hits.

## 2. Hotkeys

The checker reads Streamer.bot's hotkeys only if it finds the file (needs `paths.streamerbot_exe` in your local profile;
where Streamer.bot keeps the file is UNVERIFIED). If it says "manual check":

- [ ] Open Streamer.bot, **Settings** and the hotkeys list (the Hotkeys tab or the Hotkeys section of an action trigger).
- [ ] None of these is used there: `Ctrl+Alt+P` (panic), `Ctrl+Alt+F` (feedback), `Ctrl+Alt+Shift+M` (marker).
- [ ] Also check Speaker.bot and your keyboard or stream deck software for the same three combos.
- [ ] Press each Ujwalam hotkey once while the studio runs: the control page shows the press, and no bot reacts.

## 3. Audio (cannot be checked by machine)

Speaker.bot speaks through a Windows output device. If Ujwalam also captures that device, viewers hear the voice twice
(or an echo).

- [ ] In Speaker.bot, note its output device (Settings, audio device).
- [ ] On the control page, open the mixer and look at every audio input: the microphone, the game or capture-card audio,
      and any "desktop" or system-audio input.
- [ ] The Speaker.bot output device is captured by exactly one of them, or by none if the announcement is meant for the
      room only.
- [ ] Make Speaker.bot speak the test announcement once: its level shows on one mixer meter, not two.
- [ ] Your microphone does not pick up the speakers (use headphones, or mute the mic during the announcement).

## 4. Duplicate alerts (cannot be checked by machine)

- [ ] Trigger one test event (a Twitch follow test from the platform, or the Streamer.bot test button for one alert).
- [ ] Exactly one alert shows on screen. If two appear (one from Streamer.bot, one from Ujwalam), turn one source off and
      note which.
- [ ] Exactly one sound plays for it.

## 5. Windows and focus (D191)

- [ ] Start both bots from the Bots card: no console window opens, and neither bot steals focus from the game or the
      browser you are typing in.
- [ ] With one display, no bot window pops up over the stream. (If one does, write down which, and when.)

## 6. Announcement text

- [ ] The Streamer.bot action "Ujwalam test stream" makes Speaker.bot say exactly: "Test broadcast: we are trying new
      streaming software. Tell us in chat how the video, sound and scenes look."
- [ ] The on-screen "Test broadcast" banner shows on H and V at the same time.

Result: write PASS / FAIL / BLOCKED per section, with the date, in the stream's evidence file.
