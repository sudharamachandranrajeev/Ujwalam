# Call-to-action videos in the default layouts (P5, D248)

Date: 2026-11-08. Status: tests pass; headless render checked by eye; not yet seen on a real stream.

## What changed

- `registry/presets/scene-default-h.json`, `scene-default-v.json` (0.1.0 -> 0.2.0):
  - `subscribe-cta` (H, V): was a transparent colour placeholder; now a looping video, file
    `{assets.subscribe_cta}` under base `media`, chromaKey #00ff00 300/1. V keeps Meld's opacity 0.59.
  - `support-cta` (V): `{assets.support_cta}`, chromaKey #00ff00 440/102.
  - `confetti-cta` (V, new, z 3.5): `{assets.confetti_cta}`, Meld box 870,173 263x148 at rotation 269.72,
    chromaKey #00ff00 430/1 plus rounded 360 (Meld radius clamped to half the box height, D247). It is in the user's
    vertical target layout (2026-11-07).
  - All three: `flag: layer-effects`, so with the flag off they are hidden (a keyed video without its key would
    show a green box).
  - `wordmark` (H, V): `videoEffects` chromaKey 300/1 (the Meld value for the user's wordmark video), applied only
    when the profile file is a video, under `effectsFlag: layer-effects`.
- `services/project/scene-preset.mjs`:
  - preset layers may carry `rotation` and `opacity`;
  - `videoEffects` apply only when the asset resolved to a media (video) layer;
  - fix: an image layer whose profile file key is missing becomes a placeholder without effects (before, a
    transparent colour layer would have received the key and rounding).
- `tests/fixtures/project/profile.fixture.json`: placeholder `assets` keys.
- Key values are the Meld import of these layers (D246 mapping, UNVERIFIED for other footage).

## Local setup (not committed)

`data/profile.local.json` needs `assets.subscribe_cta`, `assets.support_cta`, `assets.confetti_cta`: file names
relative to the stream assets folder. Without them the layers stay transparent placeholders and the keys are listed
in `missingAssets`.

## Evidence

```
node --test tests/project-scene-preset.test.mjs tests/project-scene-preset-v.test.mjs tests/studio-ui-alpha.test.mjs tests/test-broadcast.test.mjs tests/hud-zones.test.mjs
ℹ pass 69
ℹ fail 0
```

New tests: "call-to-action videos (D248)" (media + loop + key + opacity + rotation with the flag on; hidden and
unkeyed with it off; placeholders without effects when the profile has no file) and "wordmark (D248)" (video keyed
under the flag, no key with the flag off, a PNG never keyed). The V rect check now accounts for quarter turns.

Headless render (scratch probe, real files from the stream assets folder via a temporary profile, grey backdrop,
browser layers off, 4 s NVENC recording of V, frame at 3 s): the subscribe pill, the confetti prompt (upright strip,
top right) and the support animation show with their green removed; the wordmark video is keyed. The still is kept
locally only (it shows the brand).

## Open

- The user's wordmark video is 1280x720 with black side bars of 102/103 px, and the H preset box is 3.8:1, so it is
  stretched and the bars show. Needs a crop or fit choice for that asset.
- Counters (Streamer.bot, user 2026-11-08: yes), goal bar (user: leave it), character image (user: later).

## Files

- `registry/presets/scene-default-h.json`, `registry/presets/scene-default-v.json`
- `services/project/scene-preset.mjs`
- `tests/project-scene-preset-v.test.mjs`, `tests/fixtures/project/profile.fixture.json`
- `docs/plan/2026-10-29-v1-decisions.md` (D248), `docs/evidence/2026-11-08-cta-videos.md`
