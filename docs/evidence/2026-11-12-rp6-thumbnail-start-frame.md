# RP6 thumbnail start frame — evidence (2026-11-12)

Plan: `docs/plan/2026-11-12-reel-polish-music-learning.md` (RP6), decision D366. User request 2026-11-12: every reel
opens on one frame that acts as its thumbnail, edited to show what the reel is about, made locally.

Status: **built; flag `reel-thumbnail` ON by default (user, 2026-11-12, D368); not yet used on a real stream.** The look, sizes and
title wording are proposed (`data/clip/thumbnail.json`, status proposed).

## What was built

- `data/clip/thumbnail.json`: font (bundled Exo 2 Bold, OFL), picture lift (ffmpeg `hue`, `unsharp`, `vignette`; all in
  the LGPL ffmpeg build, which has no `eq`), three lines (title, sub line, brand) as fractions of the frame height,
  title templates per reel type.
- `services/clip/reel_thumbnail.py`:
  - picture = the reel's strongest moment: 0.4 s after its heaviest medal (the medal card is on screen), else 0.3 s
    after the densest run of kills (3 s window, as the hook), else the anchor, else the middle of the first piece;
    always inside the piece that holds it; teaser pieces are skipped.
  - title from the reel's own facts only: medal name and result as read by the detectors, kill count ("1 KILL",
    "3 KILLS"), mode; the brand from `data/profile.local.json` (`streamer.brand`; a `<placeholder>` is never drawn).
    Text is cleaned to letters, digits and a little punctuation, cut to a maximum length, and passed to ffmpeg through
    text files with expansion off (never parsed as filter options). No chat text.
  - lines centred in the targets' safe area from its top; each line's size shrinks to fit the safe width.
  - any failure (no ffmpeg, a file error) returns a record and the reel renders without the frame.
- `services/clip/clip_montage.py` `render_argv(thumbnail=)`: the PNG becomes frame 0 (1/60 s); captions are burned on
  the reel before it, so none lands on the start frame; the sound is delayed by 800 samples (one frame at 48 kHz).
- `services/clip/clipper.py`: montages, match reels, impact-play reels and live clips (the V canvas) get the frame;
  the result row has `thumbnail {file, at, lines}` (local app data only); the file row has `thumbnail: true`;
  render.json has `reelThumbnail {flag, on, version}`; `recaption` keeps the frame. `thumbnail.png` stays in the
  reel's run folder (the clips folder holds finished videos only).
- `services/clip/clip_publish.py` → `uploads.json` rows carry `thumbnail: true`; `services/posting/index.mjs`
  `uploadCoverAt()` then takes the cover from frame 0.
- `data/flags.json`: `reel-thumbnail`, default true (D368).

## Tests

| Command | Result |
|---|---|
| `python -I -m unittest discover -s tests/py -t tests/py` | Ran 620 tests, OK (skipped=51) |
| `tests/py/test_reel_thumbnail.py` (in the suite) | 17 tests: flag on by default; moment rules (heaviest medal, kept inside its piece, densest kills, teaser skipped, fallbacks); titles per type, placeholder brand dropped, a sub equal to the main dropped, cleaning and cut; brand from the profile; a failure is a record; filter graph (text only via files, centred in the safe width, from the safe top); render_argv order (captions before the start frame, sound delayed per track, picture-only); real renders: frame 0 of the reel = the PNG (luma within 6), frame 1 = the reel's own start, the reel is 1/60 s longer, every lit pixel of the title inside the safe area |
| `tests/py/test_clip_output_layout.py` | publish marks the file and the uploads row `thumbnail: true` only when the reel has the frame |
| `node --test tests/posting-uploads.test.mjs` | 11 pass, incl. `uploadCoverAt`: frame 0 for a reel with its start frame |
| `npm run lint` | 0 findings |

## Real footage check (local, not committed)

One story montage of the 2026-11-11 session (7 pieces, 40.2 s of pieces), rendered from the V recording with the
cross fade (RP1, 250 ms) and the start frame: output 38.717 s = 40.2 − 6 × 0.25 + 1/60. The frame shows the moment
0.4 s after the "On a 5 killstreak" medal with the title "ON A 5 KILLSTREAK", "7 KILLS · <mode>" and the brand,
readable over the game picture. The picture holds the face and channel names, so it stays in the agent's scratch
folder (never committed). Seen: the title band sits across the lower edge of the facecam and the top of the game HUD;
readable, but the user may prefer another position (data value `topOfHeight`).

## Review

Codex (medium) on the diff: 2 findings, both fixed — the recorded length could exceed the type's maximum by the start
frame (now capped like the render); file or tool errors while making the frame could stop the run (now a record, the
reel renders without it, temporary files removed).

## Open

- The user watches reels with the flag on and approves or changes the look (position, sizes, wording).
- A background blur and a subject cut-out (possible later with the existing ONNX runtime) are not built.
