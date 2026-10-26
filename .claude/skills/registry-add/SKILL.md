---
name: registry-add
description: Add a core function or a preset to the Ujwalam feature registry (registry/). Use for every new effect, layer type or parity preset.
---

# Add to the registry

Presets are data, not code. Every new effect = core function + manifest + at least one preset + similar tags.

1. Pick the category in `registry/categories.json` (plan section 4.x).
2. Core function: create `registry/functions/<id>.json` (file name = id). Fields follow `registry/schema/function.schema.json`: id, version (semver), category, family, name, description, params {schema, defaults, safeRanges}, canvases (H and/or V), themeTokens, durationMs, maxConcurrent, flashesPerSec (max 3), budgetCost, status (planned | in-progress | done), format (required once not planned).
3. Preset: create `registry/presets/<id>.json` per `preset.schema.json`: function, functionVersion (exact, ^, ~ or >=), params, themeOverrides, family, tags (values only from `registry/tags.json`), canvases (subset of the function's), parity, status. Add `similar` ids for same-function and same-family neighbours.
4. Legacy parity (★): set parity "pending" and `legacySource` to a real path under `legacy/`. If unsure of the source, give the best candidate and `"legacySourceVerified": false`, and say so.
5. New tag value: add it to `registry/tags.json` first.
6. Pool: `registry/pools/<id>.json` with `presets[{preset, weight > 0}]` and `noRepeatLastN`.
7. Run `npm run validate:registry` and `npm test`. Fix every error before finishing.
8. List files created or changed.
