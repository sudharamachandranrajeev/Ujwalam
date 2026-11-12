# RP4 title card — evidence (2026-11-12)

Plan: `docs/plan/2026-11-12-reel-polish-music-learning.md` (RP4), decisions D362, D369. User request 2026-11-11: a
streamer title that fades over a blurred background after the fast-cut part of a montage.

Status: **built behind flag `reel-title` (off by default); not yet used on a real stream.** Durations, blur, darkness,
size and position are proposed (`data/clip/title.json`, status proposed). No music yet (RP3).

## What was built

- `data/clip/title.json`: font (bundled Exo 2 Bold, OFL), 1.6 s (range 1.2–1.8 s), fade in 450 ms, fade out 350 ms
  (overlay rule: under 600/400 ms, checked when the file loads), Gaussian blur sigma 18, darkness 55 %, size 7 % of the
  frame height, shrunk to fit the safe width; a reel under 4 s gets no title.
- `services/clip/reel_title.py`: `timeline` (the title starts where the leading teaser pieces end, after the cross-fade
  overlaps; no teaser: at 0), `plan` (no brand or a `<placeholder>`: no title; no room after the teaser: it opens the
  reel; control characters removed, cut to 24 characters), `prepare`/`cleanup` (the text goes to ffmpeg through a text
  file with expansion off; the font is copied next to the run; both removed after the render).
- `services/clip/clip_montage.py` `render_argv(title=)`: the joined picture is split; for the title window a copy is
  trimmed, blurred (`gblur`: `boxblur` is not in the LGPL ffmpeg build), darkened (`lutyuv`), the title drawn
  (`drawtext`, centred in the safe width and in the middle of the frame), faded in and out on its alpha and overlaid
  for that window only. The sound is not touched; the length does not change; captions are burned on top; the RP6
  start frame is still frame 0.
- `services/clip/clipper.py`: montages, match reels, impact-play reels and live clips (V canvas); the row has `title`
  (times, size; local app data only, it holds the brand); render.json has `reelTitle {flag, on, version}`; Captions
  again keeps the title (moved by the overlaps when the captioned reel becomes a hard cut, never when it opens the reel).
- `data/flags.json`: `reel-title`, default false.

## Tests

| Command | Result |
|---|---|
| `python -I -m unittest discover -s tests/py -t tests/py` | Ran 637 tests, OK (skipped=51) |
| `tests/py/test_reel_title.py` (in the suite) | 17 tests: flag off by default; overlay limits; bad config refused (fades too long, duration out of range, missing font); title start after the teaser, with cross-fade overlaps, at 0 without a teaser, at 0 when there is no room; no brand / placeholder / short reel: no title; text cleaned and cut, long text shrinks; filter graph labels alone, with captions and with the start frame; clipper helper (flag off, no brand, files written and removed); real renders: same picture before and after the window (luma within 3), clearly darker inside it (more than 25 lower), the fade-in only darkens step by step, the length is unchanged (within 0.05 s) |

## Real footage check (local, not committed)

The same story montage of the 2026-11-11 session as the RP6 check (7 pieces, 3 teaser pieces, cross fade 250 ms, start
frame on): rendered in one ffmpeg run, 38.717 s, the same length as without the title. Title at 3.45–5.05 s (where the
teaser ends after its overlaps), size 134 px on 1080×1920. Frames at 3.0 / 3.7 / 4.3 / 5.3 s: plain teaser, title half
faded in over the start of the blur, title fully shown over the blurred, darker reel, plain story part again. The
pictures hold the face and channel names, so they stay in the agent's scratch folder (never committed). Seen: the blur
reads clearly; the darkening is gentle (bright game scenes stay fairly bright), a value the user may want stronger.

## Review

Codex (medium) on the diff: 1 finding, fixed — Captions again moved a title that opens the reel by the cross-fade
overlaps; it now stays at 0.

## Open

- The user watches reels with the flag on and approves or changes the look (length, blur, darkness, size).
- The music bed under the title and at the end comes with RP3.
