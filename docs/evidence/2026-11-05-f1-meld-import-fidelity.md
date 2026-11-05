# F1 Meld import fidelity: z-order, gain, monitoring, rotation, Group, Game/Display capture

Date: 2026-11-05. Scope: `services/project/import-meld.mjs`, `tests/project-import-meld.test.mjs`, one fixture line. Real session files read locally and read-only (statistics only; no names or values recorded here).

## Findings and changes

| Item | Finding | Status |
|---|---|---|
| Z-order | `childItems[0]` = top. 332 of 493 large-vs-small top-level layer pairs have the large layer at the higher index; background-named layers are never first, overlay-named layers never last. Importer already reverses to bottom first (matches the host `layers` list "bottom to top"). No change. | Supported by statistics; UNVERIFIED in a render |
| Gain to dB | Real gains 0.0316228 and 0.0562341 are exactly -30.00 and -25.00 dB, so gain is linear amplitude. `20*log10(g)` is right; max seen is 1 (0 dB), 0 maps to the -100 floor. No change; test added. | VERIFIED by data; UNVERIFIED by ear |
| Monitoring | Meld stores a boolean. Every monitored real track also has `outputTracks != 0` (goes to the stream). Old mapping `monitor-only` would have removed a monitored mic from the stream (host: `OBS_MONITORING_TYPE_MONITOR_ONLY` mutes output). Fixed: `true` maps to `monitor-and-output`. | BUG FIXED; UNVERIFIED in Meld |
| Rotation | All real rotations are 180 and sit on webcams with exactly one negative scale axis: that is a mirror, not upside down. Importer kept 180 and ignored the flip, so cameras imported upside down. Fixed: rotation 180 with exactly one flipped axis drops the rotation; the mirror is lost (project placement has no flip) and reported under `ignored['flip (negative scale)']`. Other angles kept. | BUG FIXED; UNVERIFIED in a render; mirror not representable |
| Video device fill mode | Real cams use `fitmentMode` 2: scaled uniformly, clipped to the rectangle (e.g. 1920x1080 at 0.345 shown in a 387x373 box). The importer stretched the full frame into the box. Fixed: centre crop in source pixels (`placements.crop`); `offsetX/Y` ignored and reported. 16 layers got a crop across the real file. | FIXED; UNVERIFIED (cover reading, offset sign unknown) |
| Group | In all real groups seen, children lie inside the group rectangle in canvas coordinates; groups have scale 1, offset 0. Now flattened in place (nested groups too) when the group has scale 1, rotation 0, offset 0; children inherit hidden, lock and opacity (multiplied). Groups with their own scale, rotation or offset are skipped with a reason and child count (2 to 3 in the real files). | NEW; UNVERIFIED in a render |
| Game capture, Display capture | The host (`app/host/src/studio.cpp`) builds only: color, test_pattern, media, image, dshow_video, wasapi_input, browser. No game_capture or monitor_capture, so no import. Kept as reported skips with the reason `no host source kind for game|display capture ...`. Adding the kinds needs a host and project-schema change plus a privacy decision (screen capture); not done. | Skip kept; clear reason |
| Widget, Duplicator | Unchanged: Widget has no equivalent; Duplicator imports only when its target was imported. | Unchanged |

Also seen (not changed): `Spark Element` is a layer kind the importer does not know (28 in the real file) and goes to `unknown layer kind`. Worth a look next.

## Evidence

```
node --test tests/project-import-meld.test.mjs tests/studio-ui-server.test.mjs
ℹ pass 47   ℹ fail 0
node tools/lint.mjs
lint: 0 finding(s)
```

Real files through `importMeld` (counts only):

```
Session.json (wrapper-less, schema 3): layers seen 390, imported 154 -> 181, skipped 199 -> 190 (groups flattened), crops 16
legacy backup (wrapped, schema 3):     layers seen 355, imported 150 -> 159, skipped 177 -> 184
```
(Skipped can rise because unsupported children of flattened groups are now reported individually.)

Tests added: gain points, monitoring mode, rotation cases, fill-mode crop, group flatten (inherit, nested, counts), group skip reasons, game/display skip reason. Fixture change: `H-L-GROUP` in `tests/fixtures/project/meld-minimal.session.json` now has scale 2 so it stays a skipped group.

## UNVERIFIED

- Z-order and rotation/crop direction in an actual render against Meld.
- Monitoring semantics (boolean read as monitor-and-output).
- Fill-mode crop offsets; group flatten coordinate space beyond the sessions seen.
- Host crop applies to stretch bounds as assumed (host comment says UNVERIFIED against Meld).
