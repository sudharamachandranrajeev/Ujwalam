# v1 project model (F1/F2), 2026-10-29

Result: **PASS** for the model, validator, store and tests below. The Meld session format was NOT studied in this task (the importer is next), so the mapping table is a design intent and is UNVERIFIED against a real session file.

## What was built

| Item | Path |
|---|---|
| JSON Schema (draft 2020-12, structure) | `data/schemas/project.schema.json` |
| Runtime validator (structure + cross-references + path safety), stdlib only | `services/project/validate.mjs` |
| Migrations keyed on `version` (v0 to v1 included) | `services/project/migrate.mjs` |
| Load, atomic save, `.bak`, temp cleanup, path-ref resolver | `services/project/store.mjs` |
| Entry point, `createProject`, `newId` | `services/project/index.mjs` |
| Tests | `tests/project-schema.test.mjs`, `tests/project-store.test.mjs`, helper `tests/project-child-save.mjs` |
| Fixtures (placeholders only) | `tests/fixtures/project/sample.project.json`, `tests/fixtures/project/v0.project.json` |
| Decisions | `docs/plan/2026-10-29-v1-decisions.md` D45 to D52 |

## Shape

`project { version:1, id, name, activeScene?, origin?, canvases[h,v: width,height,fps], devices[], scenes[], audio{tracks,masterVolumeDb?,sources}, outputs[], overlays[] }`

- **canvases:** `h` 1920x1080 and `v` 1080x1920 by default (`createProject`), fps per canvas.
- **devices:** `{id, kind: capture-card|camera|microphone|audio-output, name, match:{deviceId?, name?}, format?}`. Matched by stable device id. Layers and audio sources reference the entry by `id`.
- **scenes[].layers[]:** array order is z-order, bottom first. `type` is capture, browser, image, media, text or color, with a typed `source`. `placements.{h,v}` = `{visible,x,y,width,height,rotation?,opacity?,crop?}`; a missing canvas means not shown there. Layer-level `visible` and `locked`.
- **audio:** up to 6 tracks; sources `{device|layer, volumeDb, muted, monitoring: off|monitor-only|monitor-and-output, tracks[]}`.
- **outputs:** `{id, type: rung|sink, ref, canvas}`. Reference by id only; the schema rejects encoder settings (tested). Agent C owns the output config.
- **overlays:** `{id, name, file:{base,rel}}`; browser layers reference an overlay by id (or an http(s) URL).
- **files:** `{base: data|media|overlays|profile, rel}`; `rel` is relative, no drive letter, no rooted path, no `..`. `resolvePathRef(ref, bases)` takes the directories from the caller.
- **origin:** optional `{importer, id}` on project, device, scene, layer, audio source for the Meld importer.

## Intended Meld import mapping (UNVERIFIED, session format not read yet)

Meld scene to `scenes[]`; Meld layer to `layers[]`, with H and V layout in `placements.h` and `placements.v`; capture card, camera and microphone to `devices[]` by device id; Meld audio faders to `audio.sources[]`; Meld id kept in `origin`. Anything the importer cannot place goes to its own report, not into the project.

## Runs

```
$ node --test tests/project-schema.test.mjs tests/project-store.test.mjs
ℹ tests 54
ℹ pass 54
ℹ fail 0
ℹ skipped 0

$ npm run lint
lint: 0 finding(s), 26 allow marker(s)
```

What the tests cover:

- Sample fixture valid for ajv (schema) and for the validator.
- 24 structural bad cases rejected by both the schema and the validator, and 16 semantic cases (duplicate ids, unknown device, overlay, track, scene or canvas, absolute and traversal paths, device and layer both set) rejected by the validator.
- `createProject` gives distinct ids and the H and V canvases.
- Round trip. A second save keeps exactly one `.bak` with the previous version. An invalid project is refused with nothing written.
- **Killed write:** a child process is killed (exit 1) after the temp file is written, and again after the `.bak` copy. In both cases the original file is byte-identical and loads, the temp file remains, and `cleanTemps` removes it.
- Missing or corrupt main file falls back to a valid `.bak`; both bad throws `ProjectError`.
- Migration v0 to v1: per-canvas placements, H and V canvases, default track, input not mutated. Future, missing or negative versions refused.
- Fixtures and `services/project/*` contain no drive-letter path, user path or machine user name; device names and ids are `<placeholders>`.

Lint first reported 2 eol findings (CRLF written by a Python rewrite of two of my own files); fixed to LF, not worked around, then 0 findings.

## Limits and UNVERIFIED

- Meld mapping above is intent only.
- `outputs[].ref` is not checked against the output config (Agent C scope). A cross-check belongs in the host or an integration test.
- Source-specific settings for text (font name, size) are minimal. Browser layers carry only overlay or URL plus size.
- Not exercised: concurrent saves from two processes (single writer assumed; the UI server or host owns the project).
- Full `npm test` was not re-run for this task. Only the two new suites and lint.

## Files created or changed

- Created: `data/schemas/project.schema.json`, `services/project/{index,validate,migrate,store}.mjs`, `tests/project-schema.test.mjs`, `tests/project-store.test.mjs`, `tests/project-child-save.mjs`, `tests/fixtures/project/sample.project.json`, `tests/fixtures/project/v0.project.json`, this file.
- Changed: `docs/plan/2026-10-29-v1-decisions.md` (appended D45 to D52).

## Update 2026-10-30: layer type `duplicate`

Layer types now also include `duplicate` (`source: {layer: <layer id>}`, a second item on the same libobs source as the target, no new source). Rules and tests are in `docs/evidence/2026-10-30-v1-meld-import.md` (section "Update"). Version stays 1 (D60).
