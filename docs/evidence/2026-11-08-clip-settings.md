# 2026-11-08 Clip settings in plain words (D283, D284)

User request: ask whether to make clips; offer automatic clipping and editing while recording or after it stops, the
same for live; a setting in the app and in the updater; choose where recordings and finished clips are saved.

## What was built

| Part | File |
|---|---|
| Settings file, checks, folder rules | `services/studio-ui/user-settings.mjs` |
| Clip runs per choice (ask/after/while/off), questions, answers, live pause, requeue | `services/studio-ui/record-clips.mjs` |
| Recordings folder from Settings at start | `services/studio-ui/launch.mjs` |
| `GET/POST /ui/api/settings`, `/ui/api/clips/answer`, `/ui/api/clips/open`, Clips status | `services/studio-ui/server.mjs` |
| Settings dialog, first-run welcome, "Make clips from it?", My clips, Clips label | `app/studio/src/main_window.cpp/.h` |
| Python: settings read, clipper allowed unless all off, live clipper on request, saves by time | `services/clip/clip_common.py`, `clipper.py`, `live_worker.py` |
| Updater settings | `tools/package/Install-Ujwalam.ps1` |

## Test evidence

```
node --test tests/record-clips.test.mjs                 -> pass 8, fail 0
node --test tests/studio-qt-shell.test.mjs              -> pass 9, fail 0 (probe: clip-modes:after:while, answer:yes)
node --test tests/studio-ui-server.test.mjs             -> pass 30, fail 0 (settings, answer, refused while live)
node --test --test-name-pattern=SettingsOnly tests/package-alpha.test.mjs -> pass 1, fail 0
.venv/Scripts/python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_clip_*.py" -> Ran 91, OK
```

Covered: defaults ask/ask; bad modes, relative folders, folders inside the app refused; "after" spawns a hidden
`clipper.py run --detect` into the chosen clips folder; "ask" lists a question, "yes" + remember saves "after", "no"
makes nothing; "while" turns the live clipper on only while recording or live and runs `live-review --since --until`
when it stops; a recording during a stream follows the live choice; a stream that starts stops the run and it runs
again after; closing Ujwalam keeps the run for the next start; no clip maker gives a plain reason; the updater merges
only the given settings and installs nothing with `-SettingsOnly`.

Updater smoke run (scratch install root): `-SettingsOnly -ClipsWhenRecording after -ClipsWhenLive while -ClipsFolder D:\Clips -ClipMaker <checkout>`
printed `settings: clips when recording after, when live while; recordings default; clips D:\Clips` and
`clip maker: <checkout>`, exit 0.

Earlier the same day a manual run on the user's alpha.5 recording made 1 clip (224 detector hits, validate PASS).

## Not yet verified

- UNVERIFIED: the dialogs on a shown window (Settings, first-run welcome, the question) were checked only through
  the headless probe actions; a look on the real screen is pending.
- UNVERIFIED: "while" mode on a real recording (live clipper on the GPU during a recording) and a real stream.
- The installed app makes clips only after `-ClipMaker` (or `clipRoot` in `ujwalam.json`) names a checkout with the
  Python venv; the zip ships no Python.
