# BM3: test broadcast banner (2026-11-03)

## What was built
- Page `services/overlay-server/pages/ujwalam-test-broadcast/` (`index.html`, `banner.js`): authored here, not a legacy overlay; `legacy/` is untouched. Plain script, no CDN, text set with `textContent` only, colours and fonts from `brand/tokens.css` tokens (`--glass`, `--ink`, `--ember`, `--flare`, `--text-outline`, `--font-body`, `--font-display`).
- Motion: opacity and a short slide by CSS transition. Entrance 450 ms (limit 600), exit 300 ms (limit 400). No keyframes, no flashing.
- Timing: shown when the flag turns on, visible 18 s (hold), then every 900 s (15 min); hidden at once (exit motion) when the flag turns off. Text, label, interval, hold, enter, exit and the flag id come from the layer query; no text means nothing is shown. Values are clamped to the safe ranges (interval 60-3600 s, hold 5-60 s, enter 100-550 ms, exit 100-350 ms).
- Serving: `createStaticServer` gets an `ownOverlays` option; `createOverlayServer` passes `services/overlay-server/pages`. A request for `/overlays/ujwalam-<name>/...` is served from there first; any other folder name still comes from the overlay root, so a legacy page can never be shadowed. Same checks as before (host, dot segments, symlinks, extension allowlist, CSP). The host builds layer URLs as `/overlays/<rel>`, so the layer `overlay` is `ujwalam-test-broadcast/index.html` and no host change was needed. `tokens.css` is reached as `../../brand/tokens.css` from the overlay root.
- Packaging: `services/overlay-server` is already in `REPO_DIRS` of `tools/package/manifest.mjs`; `repoFiles()` lists both page files and `importProblems()` is empty.
- Registry: function `registry/functions/timed-banner.json` (layers-graphics, family text-effects, in-progress, format html, flashesPerSec 0, budgetCost 0, params schema, defaults and safeRanges); preset `registry/presets/test-broadcast.json` (tags from `registry/tags.json`, parity none, similar `gg-burst`). `npm run validate:registry`: OK.
- Scene layers: key `test-broadcast`, top of the stack (z13; cam-pop rule moved to z14) in `scene-default-h.json` and `scene-default-v.json`. Layer query is built from the preset params (a test keeps them equal).
  - H: x 0.25, y 0.04, w 0.72, h 0.12 (1382 x 130 px), top of the game area.
  - V: x 0.06, y 0.08, w 0.88, h 0.14 (950 x 269 px). V safe area used: 6 percent side margins, 8 percent top, nothing below 80 percent of the height; the box ends at 22 percent, above the game capture (starts 23.9 percent) and below the subscribe pill (ends 7.1 percent). These numbers are a proposal: no platform source was checked (UNVERIFIED).
- Flag `test-broadcast` in `data/flags.json`, default off, switchable live from the control page (Flags card, existing typed confirmation; "yes, on air" while live). The overlay server answers `GET /_ujwalam/flags.json` with `{ "test-broadcast": true|false }`: only the ids in `OVERLAY_FLAGS` (`services/overlay-server/index.mjs`), read on each request through `services/flags`, so a flip is seen without a restart. The host's overlay child (`app/host/overlay/child.mjs`, plain JS, no host rebuild) resolves the data dir from the profile like the studio does; no profile, or a studio run with an explicit `--data-dir`, means every overlay flag reads as off. The page polls every 5 s; a failed or odd answer reads as off. The scene layer is always built visible; the page gates itself.
- First use on the installed build: the existing alpha project has no banner layer, so one run with `--rebuild-alpha` is needed (the old project moves to `projects/_old/`). After that, flips are live.

## Budget scope (AGENTS.md)
The banner is timer driven, not an event-driven effect, so it does not pass through the effect gate and costs no budget (`budgetCost 0`, `maxConcurrent 1`). It is not registered in `data/effects/guards.json`. On H its box (y 0.04 to 0.16) overlaps the top strip of the `edge` region used by Chat Charge, and on both canvases it can overlap full-canvas effects for up to 18 s every 15 min. Decision (review, D196): accepted for test streams; the banner is a short timed notice, not an effect, and routing it through the gate would let effects delay a notice that must be seen. Revisit if it is ever used outside test streams.

## Live flag switch (review change)
The first version applied the flag only when the alpha project was built (layer hidden when off), because the host has no RPC to change a layer's visibility. That missed the AGENTS.md rule "switchable from the control page while live", so in review the gate moved into the page (see the flag bullet above). The build-time `flag` field in `scene-preset.mjs`, `alpha.mjs` and `launch.mjs` was dropped again (those files are unchanged).

## Tests (no window, no child process, no network beyond loopback)
- `node --test tests/test-broadcast.test.mjs`: 14 passed, 0 failed. Registry validates; page ranges equal the function safeRanges and entrance < 600, exit < 400; preset params inside schema and ranges; query round trip (flag included), clamping, no text = nothing; schedule; run with a fake DOM and manual timers (nothing until on, then visible, hidden after 18 s, back at 900 s, text as plain text); off hides at once and schedules nothing, on again shows at once, a repeated "on" does not restart the cycle; `watchFlag` (on only for an exact `true`; error, non-200, null, string "true" read as off); source rules (no innerHTML, no CDN, no module, no colour literals, no keyframes, announcement text not in the page); scene layers carry the same query on H and V with `flag=test-broadcast`; V safe area; flag default off and in `OVERLAY_FLAGS`, layer built visible on both canvases, project validates; mount (page served, legacy-style page still served, `ujwalam-*` only, dot-segment spellings 400, unknown 404); `/_ujwalam/flags.json` (JSON, no-store, only overlay flags, a `flags.set` flip seen on the next request, `bot-manager` never listed, a throwing source gives `{}`, no source gives 404).
- Smoke run of the real overlay child (`node app/host/overlay/child.mjs --root <empty temp root>`, hidden, headless, no host): ready line, `GET /_ujwalam/flags.json` 200 `{"test-broadcast":false}` read from the laptop's data dir through the profile, no stderr, exit 0 when stdin closed.
- Changed tests: `tests/project-scene-preset.test.mjs`, `tests/project-scene-preset-v.test.mjs` (14 layers, z0..z13, rule z14).
- Also run and passing: `tests/project-scene-preset*.test.mjs`, `tests/studio-ui-alpha.test.mjs` (37 passed), `tests/overlay-server.test.mjs`, `tests/package-alpha.test.mjs` (the full-build case is skipped by design), `tests/flags.test.mjs`, `tests/studio-ui-flags-feedback.test.mjs`.
- `node tools/lint.mjs`: 0 findings. `npm run validate:registry`: OK.
- The full suite (`npm run ci`) was not run here.

## H/V capture on the laptop (2026-11-03, user yes)

Studio `npm run alpha -- --allow-devices --mock` (project rebuilt once with `--rebuild-alpha`), real devices, mock chat, nothing live. Flag `test-broadcast` set on, 20 s later off; 7 s later Ctrl+Alt+F saved the 30 s replay of H (1920x1080) and V (1080x1920). Frames at 1 fps; stills and contact sheets in `docs/evidence/private/2026-11-03-bm3b/` (gitignored: camera and channel names).

- First try FAILED: no banner in any frame. Cause: the local `app/host/host.local.json` set `overlayRoot` to `legacy/overlays`, one level too deep; every legacy page and `brand/`/`kit/` style returned 404 (9 "Refused to apply style ... MIME type ('')" lines in the host log), so all browser layers rendered empty. Fixed the setting (user yes) and added the check `overlayRootProblem()` (D200).
- Second try PASS:
  - The banner appears after the switch-on (fade in visible on the first frame) and is on screen for about 19 of the 20 s it was on; it is gone on the first frame after the switch-off. So the live switch works inside the libobs browser source: `fetch` to `/_ujwalam/flags.json` under the CSP works in CEF.
  - H: one line ("TEST BROADCAST" label plus the text) at the top, right of the logo, inside its box.
  - V: the text wraps to three lines inside the box; nothing is clipped; the box sits above the game area and does not cover the logo or counters.
  - Brand fonts and tokens load (host log: 0 MIME errors). The other legacy overlays (ticker, goal bar, mock effects) now render too.
- Still open: the 15-minute repeat (not waited for), and the look on a real stream.

## PENDING (closed by the capture above, kept for the record)
H and V frame captures. No headless render path exists in the repo (earlier evidence made no screenshots; `program-screenshot` is still planned), and a render needs the libobs host or a browser window, which this task must not start.
1. Run the studio in alpha mode with `--rebuild-alpha` once (same command as `docs/tests/2026-11-03-A0-D1.md`), with the user's yes.
2. Turn `test-broadcast` on in the control page (Flags card); the banner should appear within 5 s.
3. Capture the H and V previews and check: text inside the box, nothing clipped on V, entrance and exit visible. Turn the flag off and check the banner leaves within 5 s. Save the images in `docs/evidence/private/`.
4. UNVERIFIED until then: the overlay child finding the data dir in the installed build, `fetch` to `/_ujwalam/flags.json` inside the libobs browser source (CEF; the CSP allows `connect-src 'self'`), font fit on both boxes, CSS transitions, the brand fonts loading through `brand/fonts.css`.

## Files
Created: `services/overlay-server/pages/ujwalam-test-broadcast/index.html`, `services/overlay-server/pages/ujwalam-test-broadcast/banner.js`, `registry/functions/timed-banner.json`, `registry/presets/test-broadcast.json`, `tests/test-broadcast.test.mjs`, this file.
Changed: `services/overlay-server/static.mjs`, `services/overlay-server/index.mjs`, `app/host/overlay/child.mjs`, `registry/presets/scene-default-h.json`, `registry/presets/scene-default-v.json`, `data/flags.json`, `tests/project-scene-preset.test.mjs`, `tests/project-scene-preset-v.test.mjs`, `docs/plan/2026-10-29-v1-decisions.md` (D196), `docs/plan/2026-11-03-bot-manager-plan.md` (BM3 status).
