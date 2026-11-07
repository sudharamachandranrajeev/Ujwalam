# 2026-11-07 Scene and layer add/remove from the control page (P5b, D240)

Status: tests pass (native host, project changes, UI server route); flag `scene-edit` off by default; not yet used on the real studio.

## Checks

- `node --test app/host/tests/host-structure.test.mjs`: 3/3 (built host, headless, project v1 loaded).
  - `layers.addFromProject` puts a new layer at its project position on each canvas it has a placement on (H: bg, mid, top; V: bg, mid), hidden where its placement is hidden; the document becomes the host model (`project.get`).
  - A copy (duplicate) in another scene shares the source of the original (`source` = original id); no V placement = not on V.
  - Refusals change nothing: already there (-32009), not in the document, unknown scene, not a project v1 (-32602).
  - `scenes.create` on H and V, `layers.remove`, `scenes.remove`; removing a showing scene is refused (-32009).
- `node --test tests/project-structure.test.mjs`: 4/4.
  - addScene / removeScene: bad name, start scene, unknown scene, a scene whose layer is copied elsewhere are refused.
  - addLayer: a copy points at the real layer (also a copy of a copy) with its placements; colour full canvas; text centred box named after its first line; capture only for camera / capture-card devices; overlay sized to H, shown full width at its aspect on V (1080x608); bad colour, unknown kind or layer refused.
  - removeLayer refused while copied or bound to an audio source.
  - Server route: 404 while the flag is off; unknown keys 400; scenes.create on H then V; addFromProject gets the changed document; a host refusal saves nothing; refused while live (`live-locked`); remove layer and scene saved.
- Studio-ui, project and flags suites: 251/251. `node tools/lint.mjs`: 0 findings.

## Design

- Order: fresh `host.status` (refused while live, fail closed) -> pending layer edits written -> project file read -> pure change (validated) -> host -> file saved. A failed save leaves the host change live-only and the page says so.
- The project-sync cache is re-read after a structure edit, so a later placement save cannot write an older document.
- Undo history is cleared by a structure edit.
- Removals ask for a browser confirm on the page.

## Limits

- Image and media layers (file paths) and new devices or overlays are not added from the page yet; the page offers the project's existing devices and overlays.
- Layer order changes are still live-only (D238 note).
