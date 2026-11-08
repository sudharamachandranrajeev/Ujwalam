# 2026-11-07 Image and video layers from the stream assets folder (P5b, D241)

Status: tests pass (project change, UI server route, alpha bases); flag `scene-edit` off by default; not yet used on the real studio.

## Checks

- `node --test tests/project-structure.test.mjs`: image and media kinds.
  - addLayer kind `image` / `media` with `{file}` gives `source.file = {base: 'media', rel}`; media adds `loop: true`; the name is the file name without extension.
  - A path that leaves the folder (`../x.png`), an absolute path or no file is refused (`bad-file`); an unknown kind is `bad-kind`.
  - `listAssets` lists images and videos (.mp4 .webm .mov .mkv .m4v) sorted, skips hidden names and links, depth 4, at most 500.
  - Server route: a file not in the current listing is refused (`unknown-asset`); the choices include the asset list.
- `node --test tests/studio-ui-alpha.test.mjs`: `alphaBases` adds `media` = profile `paths.stream_assets`, else `<repo>/data/stream assets` when it exists; the launcher test (profile with `stream_assets` set to a temp folder) loads the host with bases `media` and `profile`.
- Project, studio-ui and flags suites: 256/256. `npm run lint`: 0 findings.

## Design

- The stream assets folder is the `media` pathRef base of the alpha load. `data/stream assets/` is gitignored; its files never enter the repo.
- The page lists only what is in the folder; the server re-lists and accepts only a listed file, so the page cannot name an arbitrary path.

## Limits

- On an imported Meld project the `media` base is the Meld media root, not the stream assets folder; assets chosen from the folder resolve there only for the alpha project.
- No upload: files are added to the folder by hand.
