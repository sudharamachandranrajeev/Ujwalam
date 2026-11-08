# Wordmark fit: black bars and green border cut, true shape (D251, D252)

Date: 2026-11-08. Status: tests pass; real asset measured; not yet seen in a running host or on a stream.

## Choice

User, 2026-11-08: "Crop bars, keep shape", then "Trim green border". The wordmark (the channel-name text animation, top
left of the H layout) was stretched into the 3.8:1 H box, as in Meld.

## What was built

- `services/project/media-info.mjs`: `probeMedia(file, { keyColor })`. It reads the size with ffprobe. It measures black
  bars, and with a key colour the always-keyed border, from rgb24 frames: 2 per second of the first 8 s, scaled to at
  most 1280 px wide. Children are hidden (D191). `createMediaInfo({ bases })` resolves a pathRef, stays inside its base
  and caches per file and key colour.
- `services/project/scene-preset.mjs`: layer fields `fit: "contain"`, `cropBars`, `trimKey` (videos only); option
  `mediaInfo`. No info means no change.
- `services/studio-ui/alpha.mjs`, `launch.mjs`: the alpha build passes a `mediaInfo` over the alpha bases.
- `registry/presets/scene-default-h.json` 0.4.1: the wordmark uses `fit: "contain"`, `cropBars: true`, `trimKey: "#00ff00"`.

## Measurements (local copy in `data/stream assets/`, gitignored)

ffmpeg in use: BtbN LGPL shared build 8.1. It has no `cropdetect` filter ("No such filter: 'cropdetect'"), so the
bars are measured in Node.

| File | Size | Bars (left, top, right, bottom) |
|---|---|---|
| wordmark video | 1280x720 | 102, 0, 103, 0 |
| pop the confetti | 1280x720 | 0, 0, 0, 0 |
| sub and support | 1280x720 | 0, 0, 0, 0 |
| subscribe button (webm) | 1920x1080 | 0, 0, 0, 0 |
| starting soon | — | 0, 0, 0, 0 |

The picture spans x 102..1177. A small watermark (x about 1200..1262, y 688..701) sits inside the right bar. The first
version of the check took the brightest pixel per column and stopped there (right bar 17). The fix is the 5 % share
rule.

H result: box 391.68x103.68 at (11.52, 114.48). The picture is 1075x720 after the crop and is shown at 154.8x103.68,
x 129.96, with crop 102/0/103/0.

That left the text at about 130x60 px: the green around it was large. With `trimKey` (D252) the crop is
172/104/170/182, keeping 938x434 (2.16:1, text box 900x417 plus 2 % pad). The wordmark shows at 224.08x103.68,
x 95.32. Check over all 187 frames at 24 fps: 24,534,678 text pixels inside the crop, 4 outside (in 2 frames,
compression noise).

## Evidence

```
node --test tests/project-media-fit.test.mjs
ℹ pass 8
ℹ fail 0

node --test tests/project-*.test.mjs tests/studio-ui*.test.mjs tests/test-broadcast.test.mjs tests/hud-zones.test.mjs
ℹ pass 283
ℹ fail 0
```

## Files

- `services/project/media-info.mjs` (new), `services/project/scene-preset.mjs`
- `services/studio-ui/alpha.mjs`, `services/studio-ui/launch.mjs`
- `registry/presets/scene-default-h.json`
- `tests/project-media-fit.test.mjs` (new)
- `docs/plan/2026-10-29-v1-decisions.md` (D251, D252), this file, handover
