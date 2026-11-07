# 2026-11-07 Target stream layout (user reference)

Source: the user's layout images in `data/stream assets/Stream layout/` (gitignored: brand and character art). The user's other Meld-era assets (intro/outro videos, mode title animations, stingers, subscribe buttons, custom kills/score overlays, Meld session backups) sit in the same gitignored folder; using them is optional.

## Horizontal (16:9)

- Game in a rounded inset frame filling the right ~3/4 of the canvas.
- Left column: goal bar, channel logo, stack of follow alerts.
- Top: follower count (Twitch) and subscriber count (YouTube); a "don't miss out / subscribe" popup at top centre.
- Bottom: scrolling social-handle ticker. Mascot character bottom-right, over the frame edge.

## Vertical (9:16)

- Top band: blurred copy of the game as background; subscribe popup top-left; confetti call-to-action top-right.
- Middle band: the game frame (rounded).
- Below: follower and subscriber counts; "subscribe and support" call-to-action, logo, mascot.
- Bottom: social-handle ticker.

## Use

- Layout target for the full studio UI (P5) and the alpha project once layer add/remove and overlays allow it.
- Overlay pieces (counters, ticker, popup, goal bar) map to browser-layer presets; the blurred V background maps to a duplicate game layer with a blur effect.
- Assets are referenced by local path only (pathRef bases); committed files use placeholders.
