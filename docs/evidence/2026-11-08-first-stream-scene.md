# First stream scene: Default H 0.5.0 and Default V 0.4.0 against the user's target layouts

Date: 2026-11-08. Targets: the user's horizontal and vertical stream layout pictures (local only, gitignored, not copied here). Boxes were measured from the pictures to about 1-2 percent.

## Gap list (target vs preset 0.4.1 H / 0.3.0 V)

| # | Canvas | Layer | Target | Before | Action |
|---|--------|-------|--------|--------|--------|
| 1 | H | game | rounded inset frame, right three quarters | box right, corners square | rounded effect radius 64 source px (about 58 canvas px), behind flag `layer-effects` (off by default) |
| 2 | H | goal bar | top left | shown | hidden (user 2026-11-08), layer kept |
| 3 | H | character | bottom right, about 14 percent wide | 7 percent wide box | box x 0.855, y 0.777, w 0.145, h 0.223, fit contain; transparent placeholder without profile key |
| 4 | V | character | mascot bottom right under the wordmark | missing | new layer z4.5, box x 0.62, y 0.835, w 0.38, h 0.125, fit contain, behind `layer-effects` |
| 5 | H | facecam | no slot in target | bottom left | unchanged, open question for the user |
| 6 | V | facecam | blurred game at the top, no camera | visible top centre-right | unchanged (user decision), open question |

Already matching (no change): H game box, wordmark, events stack, both counters, subscribe pill, ticker; V blurred backdrop, rounded game band, subscribe pill top left, confetti prompt top right, counters under the game, subscribe-and-support CTA bottom left, wordmark, ticker. All CTA and backdrop layers are behind `layer-effects`; counters behind `live-counters`.

## Tests

- `node --test tests/project-scene-preset.test.mjs tests/project-scene-preset-v.test.mjs`: 23 pass, 2 fail. The 2 failures are the registry-validation tests; they fail only because the `legacy/` folder (private, gitignored) does not exist in this worktree (every message is `legacySource ... does not exist on disk`). Filtered for any other message: 0 findings.
- New tests: `H target layout` and `V target layout` (boxes inside target regions, order, goal off, rounded and mascot behind flag).
- `node tools/lint.mjs`: 0 findings.

## Render evidence

Not produced. A headless render needs the native host (`app/host`) built and running; not attempted in this worktree. Compare by eye on the laptop with the real host.

## Open questions for the user

- H facecam: target shows no camera; layer kept bottom left.
- V facecam: target shows no camera; layer kept top centre-right.
- Mascot file: set `brand.character` in the local profile (H and V use it).
