# v1 Meld session importer (F1), 2026-10-30

Result: **PASS** for the importer, CLI and tests on a hand-made fixture. **Real-session run: done locally, counts only below.** Layers of eight kinds are not imported (see Skipped); mapping values are marked VERIFIED or UNVERIFIED per field. A render check (T2, preview) has not been done, so geometry, stacking order and audio levels stay UNVERIFIED as shown.

## Format studied (read only)

- Reference: the legacy reference setup under `legacy/meld/` (session backups from Meld, and an API dump) and the user's own Meld session file in the Meld Studio package data folder (`default/session.bak.json`, written April 2026; the live session is held by the running app). The Meld 0.10.7.7 install was not read. Nothing under `legacy/engage/logs` or `legacy/engage/memory` was opened. Nothing under `legacy/` or the Meld folders was modified.
- Two shapes exist:
  - **Session file** `{ version: 1, session: { scenes[], verticalScenes[], audioTracks[], videoCaptureDevices.devices[], currentScene, verticalCanvasEnabled, ... } }`. This is what the importer reads.
  - **API dump** `{ apiVersion: 3, items: { <id>: {type: scene|layer|effect|track, ...} } }`. It has no device ids and no source kinds, so the importer refuses it with a clear message (D53).
- Layer kind is `meta.sceneObjectSourceName` = `MeldStudio/<Kind>`. Nine kinds were seen: Media source, Browser, Widget, Game capture, Duplicator, Video device, Display capture, Group, Text.
- H and V are separate trees (`scenes[]` and `verticalScenes[]`); each vertical scene has a `linkedSceneId` pointing at its H scene (10 of 10 resolve in the real session).

## Mapping per field

| Meld field | Project field | Status |
|---|---|---|
| scene `id`, `name`; vertical `linkedSceneId` | scene origin and name; H and V scene merged | VERIFIED |
| `currentScene` | `activeScene` | VERIFIED (resolves to a scene id) |
| `meta.sceneObjectSourceName` | layer type | VERIFIED (9 kinds seen) |
| layer `x`, `y`, `width`, `height` | `placements.{h,v}` | VERIFIED against implicit size x scale; UNVERIFIED in a render |
| `rotation`, `visible`, `opacity`, `isLocked` | placement rotation, visible, opacity; layer `locked` | VERIFIED present; UNVERIFIED in a render |
| `childItems` order | z-order (index 0 taken as top, so reversed) | **UNVERIFIED** |
| Video device `deviceId`, `displayName`, `videoCaptureDevices[]` | device entry (`match.deviceId`, `directShowId`, `format`) and capture layer | VERIFIED present; UNVERIFIED that libobs resolves the id |
| Media source `mediaSource` (file URL), `isLoopPlayback` | media or image layer with `{base: media, rel}` | VERIFIED present |
| Browser `url`, `browserWidth`, `browserHeight` | browser layer; local overlay URLs become overlay + `query` | VERIFIED present |
| Text `text`, `fontFamily`, `pixelSize`, `foregroundColor` | text layer | UNVERIFIED (colour read as `#AARRGGBB`, stored `#RRGGBBAA`) |
| `audioTracks[]` type 1 | device (microphone or audio-output) + audio source | VERIFIED structure |
| `gain` | `volumeDb = 20*log10(gain)` | **UNVERIFIED** (assumed linear amplitude) |
| `monitoring` true | `monitor-only` | **UNVERIFIED** |
| `outputTracks` | track ids by bitmask | **UNVERIFIED** |
| layer `audioTrack` (enabled only) | audio source bound to the layer | VERIFIED structure |
| canvas fps | `--fps` option, default 60 | UNVERIFIED (Meld stores none) |

Ignored and counted, never guessed: effects, flips (negative scale), rounded corners, `fitmentMode` other than 0.

## Skipped (kept in `report.skipped` with Meld id, kind and reason)

Widget (Meld-hosted content), Duplicator (mirror of another layer), Game capture, Display capture, Group (children not flattened, coordinate space unverified), unknown kinds, geometry out of range, text from a file, remote media, application audio tracks, and V layers when the vertical canvas is disabled. The report holds ids and counts, not names. Real paths appear only in `report.bases`; do not commit a report.

## Real-session run (local; counts only)

Command (paths shown as placeholders):

```
node services/project/import-meld.mjs --in <meld-session.bak.json> --out <scratch>/real.project.json --report <scratch>/real.report.json
```

Output:

```
import-meld: 10 scene(s), 65 layer placement(s) imported (5 H+V pairs), 114 skipped, 7 device(s), 25 audio source(s), 0 overlay(s)
  skipped 35 x Widget: Meld-hosted widget (no equivalent, not copied)
  skipped 2 x Game capture: game capture has no device mapping
  skipped 67 x Duplicator: mirror of another layer (no duplicate layer type yet; superseded, see Update)
  skipped 5 x Display capture: display capture has no device mapping
  skipped 2 x Group: group not flattened (child coordinate space unverified); 3 child layer(s) not imported
  skipped 3 x audio track: not a device audio track (application or unknown audio has no device mapping)
```

Counts: layers seen 182 (including 3 group children); imported by type: media 44, text 3, capture 12, browser 1 (60 project layers); 21 H-only, 34 V-only, 5 H+V pairs; devices: 4 cameras, 2 microphones, 1 audio-output; 2 audio tracks used; effects ignored 74, rounded corners 15, fitmentMode not 0: 30, flips 6. Two warnings: a video-device layer refers to a device not in the session's device list (kept by id and name only). The project written by the importer validates (`validateProject`), and a second run to the same `--out` exits 1 with "refusing to overwrite".

Reading of the result: 73 percent of Duplicator, Widget and capture layers are not imported. Duplicators (67) were the main loss at the time of this run; the `duplicate` layer type (D54, accepted, D60) now recovers most of them, see the Update section below. This session file is from April 2026; the user's current Meld state is newer, so counts will differ.

## Tests

```
$ node --test tests/project-schema.test.mjs tests/project-store.test.mjs tests/project-import-meld.test.mjs
ℹ tests 71
ℹ pass 71
ℹ fail 0
ℹ skipped 0

$ npm run lint
lint: 0 finding(s), 26 allow marker(s)
```

`tests/project-import-meld.test.mjs` (12 tests) uses `tests/fixtures/project/meld-minimal.session.json`, hand-made with placeholder names, ids and a placeholder drive path:

- Mapping of every mapped kind, H+V pairing, V-only layer position, origins (`H+V` ids), devices (match, DirectShow id, format), overlay + query, audio (dB, tracks, monitoring, layer audio), counts.
- Skipped list: exact kinds and ids, reasons, group child count, unknown kind, out-of-range geometry.
- Report holds no names; every mapping entry is marked VERIFIED or UNVERIFIED.
- Deterministic, input deep-frozen (no mutation).
- Refusals: API dump, wrong version, not a session, no scenes.
- Vertical canvas disabled; empty session; unlinked V scene.
- CLI: new project and report written, counts only on stdout, refuses to overwrite `--out` or `--report` (nothing is written when the report path is taken), usage errors exit 2, bad input exits 1; a real child-process run.
- Fixture contains no user path, 32-hex Meld id or Meld cloud host.

The model also changed (additively, D55): `browser.source.query` and `device.match.directShowId`, with new rejection cases in `tests/project-schema.test.mjs`.

## UNVERIFIED and limits

- Stacking order direction, gain to dB, monitoring, track bitmask, text colour order, and all geometry in a render: no preview exists yet (T2).
- Pairing H and V layers by type, source and name is a heuristic. Only 5 pairs formed in the real session because V scenes mostly use their own layers.
- `directShowId` and `deviceId` resolution by libobs is untested.
- The importer does not read the live Meld app or its API. The live session is held by the running app, so a fresh export may be needed for the current state.
- Only session `version` 1 was seen. Other versions are refused.

## Files created or changed

- Created: `services/project/import-meld.mjs`, `tests/project-import-meld.test.mjs`, `tests/fixtures/project/meld-minimal.session.json`, this file.
- Changed: `services/project/validate.mjs` and `data/schemas/project.schema.json` (optional `query`, `directShowId`), `tests/project-schema.test.mjs` (cases for them), `docs/plan/2026-10-29-v1-decisions.md` (appended D53 to D59).

---

## Update: `duplicate` layer type (D54 accepted by main 2026-10-29, implemented as D60)

Supersedes the Duplicator rows above: a Duplicator is no longer always skipped.

### Model and semantics (for the host and the UI)

- Layer `type: "duplicate"`, `source: { "layer": "<layer id>" }`. Placements per canvas as for any layer.
- Host: a duplicate is a second scene item on the SAME libobs source as its target layer. It creates no new source: no second device open, no second browser instance, no second decoder. Only the item (transform, visibility, order) is new. The target's own source settings apply; the duplicate has no source settings of its own.
- Audio: a duplicate has no audio of its own. The importer ignores a Duplicator's layer audio (counted as `duplicate layer audio (same source)`).
- Rules (validator, tested): the target must exist (any scene), must not be a duplicate (a duplicate of a duplicate is rejected, error "is itself a duplicate"), and cycles are rejected ("duplicate cycle through ..."), including a layer pointing at itself.
- Version: unchanged, version 1. The type is additive, the model is unreleased and no reader outside this repo exists, so no bump or migration is needed. If a v1 reader ships before this lands, bump to 2 with an identity migration. Recorded as D60.
- The schema `description` states the host semantics, so the schema file carries the contract.

### Importer

- A Meld Duplicator becomes `duplicate` when its `sourceItemId` was imported as a real layer (either canvas; the target may be in another scene). H and V duplicators pair when their targets pair (same type, source and name).
- Otherwise it is skipped with reason `target-skipped` and a `detail`: `target layer was not imported` (for example game or display capture, a widget, a group child) or `target is itself a duplicator`. Nothing is resolved through a chain, because what a nested duplicator shows is unverified.
- If the H and V duplicators of a pair point at different project layers, the H target is kept and a warning is written.

### Real-session re-run (local, counts only)

| | Before | After |
|---|---|---|
| Layer placements imported | 65 | 103 |
| Skipped total | 114 | 76 |
| Duplicators skipped | 67 | 29 (24 target not imported, 5 target is itself a duplicator) |
| Project layers by type | media 44, capture 12, text 3, browser 1 (60) | media 44, duplicate 33, capture 12, text 3, browser 1 (93) |
| H+V pairs | 5 | 10 |
| H-only / V-only layers | 21 / 34 | 33 / 50 |
| Effects ignored / fitmentMode not 0 / rounded corners / flips | 74 / 30 / 15 / 6 | 105 / 68 / 28 / 8 |

Still skipped, unchanged: Widget 35, Display capture 5, Game capture 2, Group 2 (3 child layers), 3 application audio tracks. All duplicate targets in the written project resolve to a real layer (checked). The remaining 29 skipped Duplicators point at display or game capture, widgets, group children or other duplicators; they come back only when those layer types exist.

### Tests

```
$ node --test tests/project-schema.test.mjs tests/project-store.test.mjs tests/project-import-meld.test.mjs
tests 80, pass 80, fail 0, skipped 0

$ npm run lint
lint: 0 finding(s), 26 allow marker(s)
```

New cases: valid duplicate (also in another scene, V-only placement); missing target; duplicate of itself (cycle); duplicate of a duplicate; two-duplicate cycle; schema rejects a missing or extra `source` key; error messages name the problem; importer maps a fixture Duplicator to `duplicate` with paired H/V placements; `target-skipped` for a target that was skipped (display capture), for a duplicator of a duplicator, and for an unknown target; cross-scene target maps.

### Files changed by this update

- `data/schemas/project.schema.json`, `services/project/validate.mjs`, `services/project/import-meld.mjs`
- `tests/project-schema.test.mjs`, `tests/project-import-meld.test.mjs`, `tests/fixtures/project/meld-minimal.session.json`
- `docs/plan/2026-10-29-v1-decisions.md` (D54 marked accepted, D60 appended), `docs/evidence/2026-10-29-v1-project-model.md` (pointer), this file
