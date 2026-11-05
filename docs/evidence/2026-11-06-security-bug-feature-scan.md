# Security, bug and feature-gap scan — 2026-11-06

Session: subagent `security-bug-scan`, branch `claude/alpha0-d1`, tree at start `6c1116b`.
Scope: deep security scan, bug scan, lightweight competitor feature-gap pass, per user request.
No code changes were needed — nothing broken was found. This file is the evidence record.

## 1. Security scan

### Secrets
- `npm run ci`'s own `private-scan` step: PASS, 0 flagged (scans staged/tracked files against
  `data/profile.local.json` terms).
- Manual regex sweep for hardcoded API keys/tokens/passwords/private-key blocks across
  `*.js,.mjs,.ts,.json,.env,.yaml,.yml`: only 3 hits, all test fixtures with obviously-fake values
  (`tests/lint.test.mjs`, `tests/event-core-streamerbot-credential.test.mjs`) — these exist
  specifically to test the secret-detection lint rule.
- Stream keys/platform tokens: confirmed design-only (Windows Credential Manager via
  `createCredentialStore`), never read/written by an agent, matching AGENTS.md.

### Dependency vulnerabilities
- `npm audit`: **0 vulnerabilities** (production + dev). Dependency surface is intentionally tiny
  — `ajv` is the only pinned dependency outside devDependencies; everything else is Node stdlib.

### Auth / local API token handling
- `services/studio-ui/server.mjs`: single-use launch key (`UJWALAM_UI_LAUNCH_KEY`, ≥32 chars,
  120 s TTL), compared with `timingSafeEqual` over fixed-length SHA-256 digests (`sameSecret`) —
  no length leak, no short-circuit.
- `services/event-core/api/server.mjs`, `pipe.mjs`, `tools/label/server.mjs`: same pattern
  (`timingSafeEqual(sha256(given), tokenHash)`) everywhere a bearer/launch token is checked.
- `app/host/overlay/child.mjs`: reads `UJWALAM_EVENT_CORE_API_TOKEN` from env, immediately
  `delete`s it from `process.env`, uses the value only to add one SSE header
  server-side (`services/overlay-server/event-source.mjs`) — never forwarded into the browser
  layer the overlay serves. Matches AGENTS.md §104 ("browser layers never receive the local API
  token"). `envKeys` reported back to the host lists only variable *names*, never values.
- No server found bound to `0.0.0.0` or any non-loopback address; no `Access-Control-Allow-Origin`
  wildcard found anywhere in `services/`.

### "Electron exposure"
- The app is **not Electron** — confirmed `package.json` has no `electron` dependency; the
  architecture is a native Qt host + stdlib-Node services + a local web control page (per
  AGENTS.md §102). No `BrowserWindow`/`webPreferences` usage exists, so nodeIntegration /
  contextIsolation / sandbox-type findings don't apply. The equivalent risk surface (the web
  control page and overlay pages) is covered by the project's own tested rule instead: no CDN
  script tags, no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`eval`/`new
  Function` in any shipped page script — enforced by dedicated assertions in
  `tests/label-server.test.mjs`, `tests/report-button.test.mjs`, `tests/studio-ui-bots.test.mjs`,
  `tests/studio-ui-flags-feedback.test.mjs`, `tests/studio-ui-posting.test.mjs`,
  `tests/test-broadcast.test.mjs`, `tests/studio-ui-server.test.mjs`. Manual grep across the repo
  confirmed zero `innerHTML` use outside those test assertions.

### Child-process / window hygiene (D191)
- `tools/lint.mjs`'s `hidden-window` rule (checks every `child_process` call site for
  `windowsHide: true`) ran clean in CI (`lint PASS`, 0 findings) — did not re-verify each of the
  ~27 `spawn`/`exec`/`execFile` call sites by hand since the lint rule exists specifically to
  guarantee this and is itself tested.

### Severity-ranked findings
No security findings at Critical/High/Medium severity. One **informational** note, not a defect:
the `data/platforms/*.json` and `docs/evidence/` trees correctly hold no real credentials —
verified by inspection, nothing to fix.

## 2. Bug scan

- `npm run ci` (full, not just the pre-commit quick check): **15/15 PASS in 1190.8 s**, stamped
  for tree `ebe8ce688aba` ("a push of a commit with this content is allowed"). Steps: build,
  lint, build-host, test, test-host, test-py, test-ocr, test-capture, validate-registry,
  validate-outputs, validate-games, private-scan, legacy-verify, stray-mocks all PASS.
- `bench`: ADVISORY only, the bench tool's own noise detector flagged the run itself as unreliable
  (background CPU load 77.4% before start vs a 10% limit, system load 70.8% during vs 15%,
  Windows Defender 3.7% vs 1.5%) — this matches the exact pattern already investigated and
  written up on 2026-11-06 (`720b8c8`, bench-regression-investigation): not a real regression,
  environment noise on this laptop. Not re-investigated further; same root cause, nothing new to
  fix.
- `docs/feedback/` is empty — no unresolved user-reported bugs to triage.
- No `docs/inbox/` items pending.
- No obvious logic bugs found in the areas read during the security pass (token handling, overlay
  child IPC, studio-ui server auth) — all covered by passing tests.
- **No code changes made** — nothing needed fixing.

## 3. Feature-gap pass (lightweight, not review-mining)

Checked `docs/2026-10-26-build-plan.md`, `docs/plan/INDEX.md` and amendments against
commonly-cited features of OBS Studio, Streamlabs, Restream and Melon:

1. **Virtual camera** (OBS/Streamlabs: expose the composited output as a system webcam for Zoom/
   Meet/Discord). Not in Ujwalam's plan docs at all; the packaging tool
   (`tools/package/manifest.mjs`) explicitly *excludes* OBS's virtual-camera DirectShow filter
   from the shipped build ("virtual camera filter (not used)"). Genuine gap — worth a backlog
   line if cross-app use (not just streaming platforms) matters to the user.
2. **Multi-track audio recording** (OBS: separate mic/desktop/game/Discord tracks in one
   recording, for post-edit flexibility). Present in the plan (§4.4, "Audio mixer: ordering,
   VST3, multitrack, Twitch VOD music split") but marked `—` (not yet built/scheduled) in the
   build-order table. Already tracked, just not prioritized — flagging, not a new finding.
3. **Studio/Preview-Program mode** (OBS: stage a scene change before it goes live). One passing
   mention in evidence (`2026-11-04-a0-alpha-wiring.md`: "studio mode keeps the test card and
   adds nothing") but no dedicated plan item for a preview-vs-program split confirmed across
   `docs/plan/`. Worth confirming with the user whether Ujwalam's scene-transition model already
   covers this need differently (its transition/guard system may make this moot) before treating
   it as a real gap.

Not pursued further (explicitly out of scope per the task: "lightweight pass, not a full
review-mining operation").

## Repo state at end of session

- Branch `claude/alpha0-d1`, working tree clean after this doc + handover commit.
- 7 local commits ahead of `origin/claude/alpha0-d1` (6 from before this session, +1 this
  session) — **not pushed**: no explicit user go-ahead this session and `UJWALAM_PUSH_APPROVED`
  is unset, per AGENTS.md's push gate.
- Full CI stamp is fresh (`ebe8ce688aba`) and would cover a push of exactly this tree if the user
  approves.
- `.agent-lock` released at end of session.
