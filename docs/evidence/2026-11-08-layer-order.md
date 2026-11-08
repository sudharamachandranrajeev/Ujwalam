# 2026-11-08 Layer order saved to the project (P5b, D243)

Status: tests pass (native host, project change, UI server route); flag `scene-edit` off by default; not yet used on the real studio.

## Checks

- `node --test app/host/tests/host-structure.test.mjs`: 4/4. New: `layers.orderFromProject {project, scene}` reorders the scene's items on H and V to the document order (bottom first); a layer without a V placement is skipped on V; unknown scene or a non-project document refused (-32602) and nothing changes.
- `node --test tests/project-structure.test.mjs`: 8/8. New:
  - `moveLayer` passes the next layer above/below that is on the chosen canvas (a V-only layer is skipped when moving on H); `at-edge`, `not-on-canvas`, `bad-move`, unknown layer/scene refused; input unchanged.
  - Server op `layer.move`: host reorders from the changed document first, then the file is saved; unknown keys 400; refused while live, nothing saved.
- Project, studio-ui and flags suites: 258/258. `npm run lint`: 0 findings.

## Design

- The project has one bottom-first order per scene, shared by H and V. A move is made "as seen on" the canvas tab the user is on, so it always has a visible effect there.
- With scene editing on, the page's Up/Dn buttons use the structure op (saved). While live, or for a layer outside the project, they fall back to the host's live-only `layers.move` as before.

## Limits

- A saved move clears the undo history (as every structure edit does, D240).
- Moves are one step at a time; no drag and drop yet.
