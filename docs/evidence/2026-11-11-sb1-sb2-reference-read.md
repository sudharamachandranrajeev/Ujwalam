# 2026-11-11 SB1 + SB2: read a reference image or video into typed data (D339)

Result: **PASS** on the drawn fixtures (SB1 input, SB2 slots, palette and style within the stated tolerances).
Real references: results listed below, **UNVERIFIED** until the user checks them.

Branch `sb/reference-read` (from `claude/alpha0-d1` at 4f0b9de). Plan section C of
`docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` (D324); build plan §4.6 and §4.7. Decision D339.
Behind the new flag `scene-builder` (off by default). Data only: no scene, project or file is changed.

## What was built

- `services/scene-builder/frames.mjs` (SB1): local image or video -> rgb24 frames at a 960 px long side; a video is
  sampled at N evenly spaced times. URLs, `file:` and network shares refused; ffprobe/ffmpeg hidden, file protocol only.
- `services/scene-builder/colour.mjs`: the §4.6 maths ported from the legacy reference tool (OKLab, seeded k-means++,
  WCAG contrast, lightness push). No other palette or slot code existed in the repo (the registry entries
  `theme-from-media` and `theme-scene-generator` are `planned` stubs).
- `analyse.mjs`, `layout.mjs`, `palette.mjs`, `style.mjs`, `read.mjs` (SB2): rules for slots, palette, type feel,
  corner radius, glow and shadow; the typed local-model hook; result schema `data/schemas/reference-read.schema.json`.
- `cli.mjs`: `read <file>` prints the typed read as JSON; exit 2 while the flag is off. Entry point for SB3/SB4
  (also `readReference()` / `readFrames()`).
- Tests: `tests/scene-builder-reference.test.mjs`; fixtures drawn at test time by `tests/helpers/sb-fixtures.mjs`
  (no picture committed).

## Tests (affected suites only, one at a time, BelowNormal)

```
node --test --test-timeout=60000 tests/scene-builder-reference.test.mjs
node --test --test-timeout=60000 tests/flags.test.mjs
```

```
scene-builder-reference: ℹ tests 19  ℹ pass 19  ℹ fail 0  (about 9 s)
flags:                   ℹ tests 7   ℹ pass 7   ℹ fail 0
```

Lint on every new or changed file: `lint: 0 finding(s)`. Commit hook quick checks: `ci: 9/9 passed` on each commit.

## Synthetic fixtures against known truth

Tolerances (D339): every slot side within 0.03 of the frame side; palette colour within OKLab distance 0.02 and share
within 2 points; corner radius within max(3 px, 15 %) on a 1080 px short side.

Measured (scratch run of the same fixtures; "off" = largest side error as a fraction of the frame):

| Fixture | game | camera | chat | alerts | graphics |
|---|---|---|---|---|---|
| H layout 960x540 | off 0.0007, c 1 | off 0.0007, c 0.95 | off 0.0026, c 0.55 | off 0.0046, c 0.85 | off 0.0022, c 0.65 |
| V layout 540x960 | off 0.0004, c 1 | off 0.0002, c 0.95 | off 0.0156, c 0.55 | off 0.0093, c 0.6 | off 0.0022, c 0.65 |
| H video, 4 samples of an MPEG-4 at 2 fps | off 0.0007, c 0.93, evidence "moving 1.00" | | | | |

Video sample times (3 s clip, last frame starts at 2.5 s): 0.25, 0.75, 1.25, 1.5 s (the fourth moved back from 2.625).
No extra slots on the clean drawings (exactly 5).

Palette (five flat colours, known shares): every colour found at OKLab distance 0.0000 and exact share
(0.6, 0.2, 0.1, 0.05, 0.05); roles background, surface, text, accent, accentAlt land on the drawn colours; a grey text
that misses 4.5:1 is pushed (role `derived`, contrast >= 4.5).

Corner radius (drawn radius r at a 540 px short side, so 2r at 1080):

| drawn r | want | got | class |
|---|---|---|---|
| 0 | 0 | 1 | none |
| 2 | 4 | 4 | small |
| 3 | 6 | 6 | small |
| 5 | 10 | 12 | medium |
| 8 | 16 | 17 | medium |
| 16 | 32 | 32 | large |
| 24 | 48 | 48 | large |
| 40 | 80 | 80 | large |
| 24 with glow / with shadow | 48 | 47 / 45 | large |

Type weight (28 px marks): stroke 2 -> light 0.070; 3 -> regular 0.103; 4 -> bold 0.135; 6 -> black 0.186;
polarity right on dark and light grounds. Glow found around glowing panels (colour within OKLab 0.05 of the drawn
one), not around plain ones. Drop shadow under light cards found ("below"), not on flat cards.

Model hook: a non-local adapter is refused and never called; a local answer with a higher confidence replaces that
role (source `model`), a lower one does not; out-of-shape answers (unknown role, box outside the frame, unknown font
family) and a throwing model are ignored with a note. CLI: flag off -> exit 2 and no output; flag on -> exit 0 with a
schema-valid read that holds no folder path; nothing is written next to the reference.

## Real references (read only, nothing copied or committed) — UNVERIFIED

Command (scratch script calling `readReference(file, { frames: 8 })`), plus one CLI run:

```
node services/scene-builder/cli.mjs read "<stream assets>/Stream layout/OBS Studio concept with AI.mp4" --frames 4 --data-dir <temp dir with scene-builder on>
-> exit 0; video 960x720, 17.004 s, frameTimesS [2.125, 6.376, 10.627, 14.878], 14 slots, model null
node services/scene-builder/cli.mjs read x.png --data-dir <empty temp dir>
-> scene-builder: the scene-builder feature flag is off (...); exit 2
```

Palette roles: background / surface / text / accent / accentAlt (`*` = derived), text contrast on background.
Boxes are x y w h fractions; c = confidence.

| Reference (base name) | Input | Palette | Type | Radius (1080) | Glow | Shadow |
|---|---|---|---|---|---|---|
| Style guides AI design_ Standardize sizes across the system.jpg | image 736x1318, V | #edede7 / #e0ded7 / #23221f / #2150b1 / null (13.51:1) | bold 0.160, small, dark-on-light (c 0.51) | not measured (0 corners) | yes #697db2 (c 0.71) | no (c 0.3) |
| Styleguides AI inspiration_ One spacing scale, endless consistency.jpg | image 736x1097, V | #393c40 / #25282c / #e1cfc4 / null / null (7.32:1) | bold 0.135, small, light-on-dark (c 0.49) | 0 none (c 0.38, 5 corners) | yes #f9dca9 (c 0.83) | yes, below (c 0.38) |
| UI Design Templates_ Build Faster & Ship Products.jpg | image 736x1097, V | #ece6d6 / #ddd5c4 / #2a4643 / null / null (8.18:1) | black 0.176, small, dark-on-light (c 0.57) | 6 small (c 0.5, 4 corners) | no (c 0.3) | no (c 0.25) |
| UI Design Templates_ Build Faster, Ship Smoother.jpg | image 736x1104, V | #1e3a45 / #294851 / #afd0cc / null / null (7.26:1) | bold 0.143, small, light-on-dark (c 0.53) | not measured (0 corners) | yes #7edacf (c 0.64) | no (c 0.3) |
| Horizontal stream layout.png | image 831x470, H | #72685b / #534d42 / #efebd1* / #d7435a / #4b5cd0 (4.55:1) | bold 0.163, small (c 0.06) | not measured | no (c 0.94) | no (c 0.3) |
| vertical stream layout.png | image 284x509, V | #403b33 / #23211b / #ebe0a8 / #8a3bce / null (8.33:1) | not measured (too few marks) | not measured | no (c 1) | no (c 0.3) |
| OBS Studio concept with AI.mp4 | video 960x720, H, 8 samples | #21202e / #30303f / #cccbd2 / #463a77 / null (9.98:1) | black 0.181, small (c 0.41) | 5 small (c 0.75, 8 corners) | no (c 1) | no (c 0.3) |

Slots (graphics counted only):

| Reference | Slots |
|---|---|
| Style guides AI design_ Standardize sizes … | chat [0.42 0.13 0.52 0.16] c 0.55; graphics x6; no game |
| Styleguides AI inspiration_ One spacing scale … | camera [0.87 0.29 0.13 0.07] c 0.6; graphics x11; no game |
| UI Design Templates_ Build Faster & Ship Products | camera [0.49 0.06 0.11 0.09] c 0.69; chat [0.06 0.04 0.11 0.17] c 0.45; alerts [0.31 0.81 0.57 0.07] c 0.5; graphics x24; no game |
| UI Design Templates_ Build Faster, Ship Smoother | game [0.55 0.31 0.42 0.29] c 0.85; graphics x1 |
| Horizontal stream layout.png | game [0.24 0.00 0.73 0.99] c 0.9; camera [0.00 0.27 0.15 0.10] c 0.59; chat [0.00 0.06 0.24 0.57] c 0.7; graphics x5 |
| vertical stream layout.png | game [0.00 0.24 1.00 0.51] c 0.9; camera [0.01 0.00 0.98 0.24] c 0.55; graphics x3 |
| OBS Studio concept with AI.mp4 | game [0.23 0.15 0.53 0.40] c 0.95; chat [0.78 0.24 0.14 0.18] c 0.73; graphics x9 |

The agent's own look (not the user's check): on the two target layouts the game box is about right on the long axis
but runs into the counter row and the bottom ticker on H (by eye the frame ends near y 0.93); the "camera" on both
target layouts is not a camera (a colourful logo/card on H, a blurred backdrop on V: skin-tone colours fool the rule);
the H chat rail is the alert-card stack on the left. The style guides are UI sheets, not stream layouts, so their
slots are mostly graphics, as expected; their palette, glow and type readings look plausible by eye.

For the user to check: per reference, are the palette roles, the glow/shadow answers and the game/chat/camera boxes
right? Say which are wrong; the rules are tuned on that, never on invented data.

## Not checked / limits

- Real references: UNVERIFIED (human check pending).
- Corner radius on real UI sheets is mostly not measured: their small corners sit inside merged regions, so few boxes
  have a whole outline at the 960 px analysis size.
- Font family is not read by rules (always null); the model hook may fill it later.
- Camera detection relies on skin tones plus texture; warm-coloured graphics are false positives (see above).
- No local vision model chosen or installed (needs the user's yes); no studio UI; SB3 (build scenes) not started.
- The full CI and the soak were not run (instructions: affected suites only).
