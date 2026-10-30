# 2026-10-29 v1 F2 studio UI skeleton (day 1, Agent B)

Status: skeleton built and smoke-tested by hand. Automated tests NOT written yet (waiting for "commit done" from main).
F2 is NOT done: the host side is BLOCKED-ON-HOST.

## What exists

- `services/studio-ui/server.mjs`: Node stdlib server, 127.0.0.1 only, serves `ui/`, same-origin API under `/ui/api/*`.
- `services/studio-ui/backends.mjs`: event-core client (api token only), host client (discovery file, UNVERIFIED contract), in-memory fake host.
- `services/studio-ui/cli.mjs`, `services/studio-ui/launch.mjs`: UI server entry and one-command launcher.
- `ui/index.html`, `ui/css/{tokens,app}.css`, `ui/js/{dom,api,app}.js`: Meld-style layout (scenes + layers left, preview buttons center, mixer placeholder right, stream/record top, status bar bottom). Plain scripts, tokens in CSS variables, no CDN, no innerHTML.

## Security design (checked by hand, see smoke run)

| Item | Behaviour |
|---|---|
| Bind | `127.0.0.1` only |
| Host | must equal `127.0.0.1:<port>` else 403 |
| Login | `GET /login?k=<launch key>`: one-time key (env, 120 s TTL, timing-safe compare, 5 failures lock 60 s) -> cookie `HttpOnly; SameSite=Strict; Path=/` |
| Other requests | need the session cookie, else 401 |
| POST | Origin == own origin, `X-Ujwalam-Csrf` header (value from `/ui/api/session`), `application/json`, body <= 16 KiB |
| Cross-site | `Sec-Fetch-Site` other than same-origin/none refused; OPTIONS refused; no CORS headers |
| Headers | CSP `default-src 'none'; script-src 'self'; ...`, nosniff, no-referrer, no-store |
| Static | GET only, extension allowlist, no dotfiles, decoded-path and realpath checks inside `ui/` |
| Backend tokens | read and held only by the server process; never in a response, header or page; status snapshot is text-free (no chat) |
| Host calls | allowlist `HOST_CALLS` with strict param schemas |

## Confirmation channel (ADR 2026-10-29-confirmation-channel.md, D7)

The UI server is the human-facing surface. Stream/record start/stop and every event-core action request create a server-side pending
record (30 s). The page receives only `pendingId`, summary and the phrase to type. confirmId and actionHash stay on the server. The server
calls the backend only when the typed text equals the phrase (live-aware: "yes" / "yes, on air"; two-step on-air confirmations from the
core produce a second pending record).

TODO for main (needs event-core changes, not done here): event-core still accepts `actions.confirm` from the api token, and returns the
phrase and actionHash to the requester. The UI server uses the api token for `actions.confirm` today (`backends.mjs` `confirm()`). When the
confirm role exists (ADR option 2), give the UI server the separate confirm credential by env (in memory, never in `api.json`) and switch
`confirm()` to it. The launcher must then pass that credential to the UI server only.

## Runtime evidence (manual smoke, scratch script, fake host with outputs ready)

- unauthenticated GET / -> 401
- `/login?k=<key>` -> 302 with `ujwalam_ui=...; HttpOnly; SameSite=Strict; Path=/`
- GET / and /js/app.js with cookie -> 200; `/ui/api/session` -> keys csrf, host, core, limits
- POST host `scenes.list` -> 200; `stream.start` -> `verdict: confirm`, phrase `yes, on air`; typing `yes` -> `wrong-phrase` (stays pending); typing `Yes, on air` -> `allow`
- POST with Origin `http://evil.test` -> 403
- `/..%2f..%2fpackage.json` and `/%2e%2e/package.json` -> 404
- SSE `/ui/api/events` -> `status` frame with host kind `fake`, blockedOnHost true
- Real event core (`serve --mock`, temp data dir): `createCoreClient({dataDir})` read `api.json`, `core.status` returned, and `actions.request chat.raw.purge {all:true}` returned a confirmation (not confirmed).
- Launcher run (`launch.mjs --data-dir <tmp> --mock --no-open`): started event core, printed BLOCKED-ON-HOST, started UI server; `GET /` without cookie -> 401; no token printed. Browser open step (`start`) not exercised.
- `node tools/lint.mjs` on the new files: 0 findings.

## Not verified / open

- Browser rendering not checked in a real browser (no browser automation run). UNVERIFIED.
- Host API names, discovery file and token handoff are PROPOSED (D43), UNVERIFIED with Agent C.
- Mixer meters: placeholder only. Preview buttons call `preview.open/focus`; the fake answers with a BLOCKED-ON-HOST note.
- Tests (security, token leakage, traversal) and the `npm run studio` script: after "commit done".
- No priority change was made to any process; children inherit Normal.

## Files created

`services/studio-ui/{server,backends,cli,launch}.mjs`, `ui/index.html`, `ui/css/tokens.css`, `ui/css/app.css`, `ui/js/{dom,api,app}.js`,
this file. Changed (append only): `docs/plan/2026-10-29-v1-decisions.md` (D40-D44).
