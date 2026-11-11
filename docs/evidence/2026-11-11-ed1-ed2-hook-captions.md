# ED1 payoff-first hook and ED2 burned-in reel captions: test evidence (2026-11-11)

Result: **PASS** for the headless tests and synthetic renders. **Awaiting live test**: no real recording or real stream
has been rendered with either flag on. Decisions: D352 (ED1), D353 (ED2). Both behind flags `reel-hook` and
`reel-captions`, off by default.

## What was built

- ED1: `services/clip/reel_hook.py`, `data/clip/reel-hook.json`, function `registry/functions/reel-hook.json`, presets
  `reel-hook-payoff-first`, `reel-hook-quick-tease`; wired into montages, match reels, impact-play reels (`cmd_montage`)
  and live clips (`cmd_live_review`) in `services/clip/clipper.py`. Hook score in every reel row.
- ED2: `services/clip/reel_captions.py`, `data/clip/reel-captions.json`, function `registry/functions/reel-captions.json`,
  presets `reel-captions-bold`, `reel-captions-barlow`; confidence per segment in `services/clip/clip_captions.py`;
  `clipper.py recaption --id <reel>` re-renders from the edited `transcript.json`.
- Settings > Clips > REEL OPENING in the Qt studio (`app/studio/src/main_window.cpp`), `clips.reelHooks` in
  `services/studio-ui/user-settings.mjs`, sent by `GET /ui/api/settings` (`services/studio-ui/server.mjs`).

## Commands and output

Python, one file at a time:

```
UJWALAM_HEADLESS=1 python -m unittest tests.py.test_reel_hook
Ran 18 tests in 2.585s
OK

UJWALAM_HEADLESS=1 python -m unittest tests.py.test_reel_captions
recaption M01: 1 caption card(s) burned, 0 published copy(ies) replaced
Ran 11 tests in 4.476s
OK
```

Regression, one file at a time (all OK): `test_reel_length` 24, `test_clip_montage` 20, `test_clip_live_montage` 6,
`test_clip_live_review_gate` 6, `test_clip_pipeline` 37, `test_clip_e2e` 7, `test_caption_seam` 2 (1 skipped, as before).

Node:

```
UJWALAM_HEADLESS=1 node --test tests/user-settings-reel-hook.test.mjs     # pass 4, fail 0
UJWALAM_HEADLESS=1 node --test tests/user-settings-reel-length.test.mjs   # pass 6, fail 0
UJWALAM_HEADLESS=1 node --test tests/flags.test.mjs                       # pass 7, fail 0
UJWALAM_HEADLESS=1 node --test tests/posting-uploads.test.mjs             # pass 10, fail 0
node tools/registry-validate.mjs registry                                 # OK
```

Qt studio (one build, then the headless probe):

```
npm run build:studio
built ...\out\studio\build\ujwalam-studio.exe

UJWALAM_HEADLESS=1 node --test --test-name-pattern="Settings > Clips" tests/studio-qt-shell.test.mjs
  ✔ Settings > Clips (CL1, D350): reel length rows show the defaults, Save sends the changed type, ...
  ✔ Settings > Clips (ED1, D352): reel opening rows show on and 2 s per type, Save sends only the changed type
  ✔ Settings > Clips (LC2, D334 proposed): Record while live is a switch row ...
```

Commit hook quick checks: `ci: 9/9 passed` on each commit (build, lint, build-host, build-studio, validate-registry,
validate-outputs, validate-games, private-scan, legacy-verify).

## What the tests check

ED1 (`tests/py/test_reel_hook.py`):
- data and both flags off by default; settings checks match the server's; flag and per-type switch both needed;
- teaser plan (peak in the first 3 s of the output), `already` when the peak is already early, reorder, reorder plus
  teaser, teaser dropped when there is no room;
- a teaser never overlaps a death span; with only death-overlapping candidates the reel opens unchanged;
- a long reel split into parts: every part has its own hook and every part is at most 60 s with the teaser;
- hook off: pieces unchanged; parts keep their own peaks and medals;
- hook score parts; the impact-play medal is not a kill; live clip hook from the save anchor; `merge_saves` anchor;
- ffmpeg render (synthetic `life` source, 16 s cap): the teaser is rendered, length within the cap, motion YDIF about
  24 on the moving source and 0 on a still colour.

ED2 (`tests/py/test_reel_captions.py`):
- no Microsoft font in the preset or `data/fonts`; the stdlib cmap reader matches fontTools on all 9 bundled fonts;
- no bundled font covers Malayalam (reported, see below); the longest card line fits the safe width at the preset size;
- threshold and script marks (low confidence and Malayalam hidden, kept in the transcript);
- ASS holds only the shown lines, margins inside the V safe zone (left 65, right 140, bottom 670 on 1080x1920);
- an edited transcript is used on re-render; both confidence formulas;
- ffmpeg render: transcript on the reel timeline (teaser included), burned pixels inside the safe zone, a low-confidence
  line not burned; `recaption` end to end through `clipper.main`, refused while the flag is off.

## Not checked (UNVERIFIED)

- A real recording rendered with a hook or captions (all renders are synthetic lavfi sources); the look of the captions
  on real gameplay.
- The motion threshold (YDIF 3.0) and the score weights (.35/.25/.2/.2) on real footage; proposed only.
- `minConfidence` 0.55 on real stream audio; Malayalam and mixed Malayalam-English speech to text quality.
- whisper.cpp `-ojf` token probabilities with a real `whisper-cli` binary (parser tested on a sample only).
- `recaption` of a live clip after `--drop-used-saves` removed its replay save (the source is gone; it is refused).
- The REEL OPENING group's picture at real DPI (probe only).

## Findings for the user

- **Malayalam font.** None of the bundled OFL fonts (Inter, Barlow, Exo 2) has Malayalam glyphs. Malayalam captions stay
  in the transcript and are not burned. Burning them needs a Malayalam OFL font in `data/fonts` (an install for the user
  to approve). `legacy/` has Baloo Chettan 2 (OFL believed, UNVERIFIED, woff2), which is a candidate.
- **Short-clip captions** (`clip_captions.to_ass`, the existing path, not ED2) still name "Arial", a Microsoft font that
  libass resolves from the system. Not changed in this task.
