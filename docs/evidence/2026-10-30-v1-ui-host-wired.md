# 2026-10-30 v1 F2: studio UI wired to the real host (test card, no devices)

Status: UI to real host PASS for scenes, layers, mixer list, status, native H and V preview windows (test card only). Start/stop stream
and record are NOT exercised (outputs not configured in this run, buttons correctly disabled). Event core was not part of this smoke.

## Changes since the skeleton

- `services/studio-ui/server.mjs`: `HOST_CALLS` use the host's names (`scene`, `layer`, `index`, `id`, `db`, `canvas`); mixer id pattern `<scene>/<layer>`; `preview.close` added.
- `services/studio-ui/backends.mjs`: host token from env `UJWALAM_HOST_TOKEN` (discovery file has `token: null`); `rpc` exported; fake host returns the real shapes.
- `services/studio-ui/launch.mjs`: starts the host (exe, runtime, data from `app/host/lib/config.mjs`), `--allow-devices` passthrough (off by default), `--fake-host`, clean stop with `host.shutdown`. Host token goes by env to host and UI server only.
- `ui/js/app.js`: unwraps `{scenes}/{layers}/{sources}`, top-first layer list, scene canvas tag, shows start-up errors. No BLOCKED-ON-HOST banner when the real host is connected.
- `package.json`: `npm run studio`.
- `tests/studio-ui-server.test.mjs`: 22 tests.

## Tests

`node --test tests/studio-ui-server.test.mjs` -> pass 22, fail 0. Covers: no cookie 401; wrong Host 403; cross-site 403; OPTIONS 405 and no CORS headers;
cookie flags (HttpOnly, SameSite=Strict, Path=/); single-use and expiring launch key; login lock after 5 failures; POST needs Origin, CSRF, JSON, size limit;
CSRF without the cookie refused; method allowlist and param schemas (host.shutdown, project.load, outputs.configure refused); typed-phrase confirmation
(host not called before; wrong phrase stays pending; single use; cancel); core confirmId and actionHash never in a response and used only after the phrase;
no backend secret or launch key in session, status, SSE, static files; page scripts contain no unsafe DOM calls or auth headers; path traversal (20 variants)
and extension allowlist; bind 127.0.0.1; SSE cap.
`node tools/lint.mjs` on the changed files: 0 findings.

## Real-host smoke (scratch script, host started with the test-card project, no `--allow-devices`)

- Host call results seen through the UI client: `host.status` (fps ~60, GPU load, `outputsReady` false for stream and record), `scenes.list` (3 scenes, canvases H/V),
  `layers.list card-h` (3 layers, bottom first), `mixer.list` (sources `card-h/bars`, `card-h/motion`, `card-v/motion`, peakDb present for the tone layer),
  `preview.open h` and `v` -> `open: true`, `host.shutdown` -> `shuttingDown: true`, host exit.
- Headless Chrome screenshot of the page after login: `docs/evidence/img/2026-10-30-ui-host-wired.png`. Shows scenes, layers (top first), mixer with a live meter, status bar with FPS/CPU/GPU,
  `Host: up`, no banner, Record and Start stream disabled.
- Native previews (test card only, client areas cropped): `docs/evidence/img/2026-10-30-preview-h.png`, `docs/evidence/img/2026-10-30-preview-v.png`.
  A full-screen capture was also taken; it showed personal desktop content, so it was moved to the gitignored `docs/evidence/private/` and not used.

## Findings

- Node `fetch` is refused by the host (`browser-request-refused`, Sec-Fetch headers). The UI server uses `node:http`. The launcher shutdown call was fixed for the same reason.
- BLOCKED-ON-HOST for the host: the host exe in `out/host/build` (built 20:58) rejected `app/host/projects/test-card.project.json` as edited at 21:23
  (`project: unknown field "format"`, exit 3). The smoke used a copy without `format`. `npm run studio` will show the host down until the exe is rebuilt
  (`node app/host/tools/build.mjs`, Agent C). Not changed here (not mine).
- Headless Chrome with an open SSE never goes idle; the smoke used `--timeout=20000`.

## Not verified

- Full `npm run studio` launch with the real host and event core together (blocked by the project/exe mismatch above). UNVERIFIED.
- Stream/record start/stop through the typed confirmation against the real host (needs `outputs.configure`; loopback targets only).
- Event core confirm role (ADR option 2) still TODO for main; see `docs/evidence/2026-10-29-v1-ui-skeleton.md`.
- Layer move and mixer volume against the real host were only checked at the contract level, not clicked in a browser.

## Files

Created: `tests/studio-ui-server.test.mjs`, `docs/evidence/2026-10-30-v1-ui-host-wired.md`, `docs/evidence/img/2026-10-30-ui-host-wired.png`, `docs/evidence/img/2026-10-30-preview-h.png`, `docs/evidence/img/2026-10-30-preview-v.png`, `docs/evidence/private/2026-10-30-native-previews-full.png` (gitignored).
Changed: `services/studio-ui/{server,backends,launch}.mjs`, `ui/js/{app,dom}.js`, `ui/css/app.css`, `package.json` (one script line), `docs/plan/2026-10-29-v1-decisions.md` (D61-D65).

## Day-2 host (build-c) and Meld import

- Host exe `out/host/build-c/ujwalam-host.exe` (device-less, test-card project with `format`). The earlier "Not verified" note about the day-1 exe/project mismatch is resolved by using build-c.
- New: optional `canvas` on scenes/layers calls, device-audio mixer ids `audio:<id>`, one scene row per id with H/V tabs, `project.load` retry on -32009, **Import Meld session** button.
- Tests: `node --test tests/studio-ui-server.test.mjs` -> pass 26, fail 0 (4 new: import creates a new file and returns counts only with device names withheld; session path cannot come from the page and no session -> 503; load needs an import, a typed phrase, retries twice on -32009, project doc stays server-side; canvas and `audio:` ids validated).
- Real-host run (build-c host, no `--allow-devices`, hand-made fixture session `tests/fixtures/project/meld-minimal.session.json`, no personal data):
  - import -> 200: 2 scenes, 10 layer placements imported, 8 skipped (by kind), file `meld-import-<stamp>.project.json`; `project.plan` -> `unavailable 10, warnings 3` (devices off, as expected)
  - load -> `confirm`, phrase `yes`; typing it -> `allow`: `built 4, unavailable 10, warnings 3`; `scenes.list` afterwards shows the 2 imported scenes on H and V; `mixer.list` ok
  - screenshot `docs/evidence/img/2026-10-30-ui-after-import.png` (Scene One / Scene Two, H/V tabs, Host: up, no banner)
- A first screenshot showed `Start-up failed: host-error` (layers.list needs a canvas for a scene on both canvases). Fixed by merging the scene rows and passing the canvas. Re-run is clean.
- Host `out/host/build` was not used or held by this run; no host is left running.

Still not verified: full `npm run studio` with host + event core together; stream/record through the confirmation against the real host; anything with devices (not opened; device names are never logged or shown in evidence); the importer against the user's real session (needs `paths.meld_session` or `UJWALAM_MELD_SESSION`, and the user's "devices ready" for device sources).

Extra files: `services/studio-ui/import.mjs`; `ui/index.html`, `ui/js/{api,app}.js`, `ui/css/app.css`, `services/studio-ui/{server,cli,launch}.mjs` changed; `docs/evidence/img/2026-10-30-ui-after-import.png`; decisions D66-D68.
