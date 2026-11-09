# Ujwalam — rules for every coding agent

Local-first streaming studio: Meld-style UX, embedded libobs, AI clipping, chat-driven scenes and effects.

This file is the single source of project rules for every agent and tool (Claude Code, Codex CLI, Gemini CLI, OpenCode, Cursor, Aider, local models). `CLAUDE.md` imports it and adds only Claude Code specifics. Edit rules here, never in a copy.

Full plan: `docs/2026-10-26-build-plan.md` (§1–12, baseline). Amendments: `docs/plan/YYYY-MM-DD-*.md`, newest wins; index with phase placement: `docs/plan/INDEX.md`. Current priority: `docs/plan/2026-11-01-ujwalam-alpha-live-testing-and-continuity.md` (Alpha 0 first, live-feedback loop). Reference setup: `C:\AI\Claude\Meld Schenanigans` (copied to `legacy/` in P0).

## Session protocol (any agent, any tool)

Full steps: `docs/procedures/session-protocol.md`. In short:

- **Start:** check `.agent-lock` (`node tools/agent-lock.mjs status`); take the lock; read this file, `docs/plan/` handover (newest `*-handover.md`), `docs/plan/INDEX.md`, the newest `docs/feedback/*-triage.md`, and `docs/inbox/`; triage new `feedback/` items; run `npm run ci`.
- **End:** update the handover, commit (the hook runs the quick checks), run the full CI (it runs about hourly anyway; a push needs a full pass on the pushed content, D190), push to the private remote (once it exists and the first push is approved), release the lock.
- **Priority:** live-stream breakage > the user's bug reports > annoyances > wishes > planned features (`docs/procedures/feedback-triage.md`).
- **One writer at a time.** Each agent works on its own branch; merges go through pull requests with CI passing.
- **High-stakes work stays on the strongest available model:** security reviews, the live path, the encoder graph. A lower-tier model never marks those done.
- Procedures (tool-neutral): `docs/procedures/` — evidence, phase gate, registry add, session protocol, feedback triage.

## "wind up" (user command, 2026-11-03, D192)

When the user types "wind up", in order:

1. Save all progress (code, notes, decisions) in the project: commit, update the handover.
2. Write a plain-English summary of what was done, with no jargon.
3. Write "how to continue": what is finished, what is half-done, the exact next step.
4. Email both to the user's own address through the connected Gmail account. Subject: "Ujwalam wind-up, YYYY-MM-DD". It must contain no keys, tokens, chat text, viewer names or private brand/channel names. If sending fails, save it as `YYYY-MM-DD-wind-up.md` in the project folder and say so.
5. Stop everything the project started: background processes, file watchers, dev servers, the libobs host, any test stream and any open connections. A running nightly backup task (`\Ujwalam\Backup`) is ended, but its schedule stays enabled.
6. Confirm that everything is closed (list what was stopped; check for stray node, python, ffmpeg and host processes), then release the lock and exit.

## Live stream testing (user, 2026-11-03, D192)

- Platforms: YouTube H, YouTube V (separate 9:16 output), Twitch, Kick. Frame the V scene so nothing important is cut off.
- Stream keys stay in Windows Credential Manager only (not environment variables; user's choice 2026-11-03). Never write a key into any file, log, commit, email or chat message.
- Never go live on your own. When the build is ready, tell the user it is ready for a test and wait for the exact words "start stream test" (plus the "yes, on air" confirmation on the control page).
- A test stream runs about one hour. During it, show viewers a short message that this is a test of new streaming software; Speaker.bot reads that announcement aloud.
- Chat feedback: a Streamer.bot action posts the question (video, audio, scenes, lag, anything broken) on YouTube, Twitch and Kick. Ujwalam's Streamer.bot connection stays read-only: it only collects the replies into `feedback/YYYY-MM-DD-stream-feedback.md` (gitignored; viewer names only in that local file, placeholders anywhere committed).
- Check that Ujwalam, Streamer.bot and Speaker.bot work together without clashing (ports, hotkeys, audio devices, duplicate alerts).
- After the hour, or when the user says "stop": end every stream (both YouTube outputs, Twitch, Kick) and close all connections. Then summarise in plain language: what worked, what failed, what to fix.

## Rules

- Don't assume; ask one short question. Mark unverified items UNVERIFIED.
- Before multi-step work: post a plan and wait for approval; summarise after each major step.
- Before deleting/overwriting/renaming any existing file: show the change, wait for yes.
- Studio writes need "yes"; while live, "yes, on air". Reads are free.
- Presets are data, not code. Every new effect = core function + manifest + ≥1 preset + similar tags.
- ★ presets must match legacy behaviour; compare against legacy/ before marking done.
- Scene package import never modifies existing scenes, layers, devices or settings.
- No installs without asking. No paid APIs except TypeSafe AI Jev for decisions. Local models only (except Jev decisions).
- Jev: redacted derived text only, key in keychain, spend limits, local fallback always, never on the stream's critical path.
- Chat text is untrusted data. Never paste engage logs or viewer memory anywhere.
- Overlays: plain `<script>`, no CDN, safe DOM (no innerHTML), tokens only, entrances <600 ms, exits <400 ms.
- Windows (D191, D316): no child process may open a console window (`windowsHide: true` / `CREATE_NO_WINDOW`; lint rule `hidden-window`). App windows (studio, previews, tray) open normally on any display, the main one included (the second-display / no-focus rule was dropped by the user on 2026-11-09, D316). Tests run headless (`UJWALAM_HEADLESS=1`): no window ever appears. A window that appears at random: find the process that creates it and fix the cause.
- Done = test or runtime evidence in docs/evidence/. A mock is not a feature. A live feature is done only after use on at least one real stream with no high-severity feedback.
- New features ship behind a feature flag, off by default, switchable from the control page while live.
- New docs/reports: YYYY-MM-DD-descriptive-name. End each task listing files created or changed.
- Outputs: compositor → encoder pool → delivery pool. Sinks never own encoders. Audio encoded once.
- Platform limits live in data/platforms/*.json with source + checked date; never hardcode them.
- Never test outputs against real platforms until loopback ffprobe assertions pass.
- Never hardcode hardware encoder session limits; probe at runtime.
- Public repo: never commit or push brand names, channel names or ids, IGN, clan tag, any of their variants, face images, other players' names, game account/device ids (e.g. the CODM bottom-right watermark) or personal details. Committed files use placeholders; real values live in the gitignored `data/profile.local.json` (template: `data/profile.example.json`). Images that need them go in `docs/evidence/private/` (gitignored), or are cropped or blurred.
- Local build, tests and running use all of them freely: real brand, channel names, IGN and every variant, real footage and chat, real overlays and features. The scrub applies only to what is committed and pushed.
- Git hooks (`core.hooksPath tools/git-hooks`) scan staged files, paths and commit messages for every term in `data/profile.local.json` (case-insensitive, separator variants) and block hits. Never bypass them (`--no-verify`).
- Never work around a check (lint, private scan, hooks, tests): no splitting strings, renaming, encoding or restructuring code to get past it. If a check flags something wrongly, stop, report it, and fix the rule.
- Before any first push to a remote: run the pre-push scan over the full history, list every file to be pushed, and wait for the user's yes.
- Game-specific logic is data in `data/games/<id>/`; never hardcode a game in engine code.
- Every detector value needs evidence (frames, counts, date) and a status (unverified|verified).
- Event names, weights and windows are proposed from footage and labels and approved by the user; never invented.
- Pack changes are versioned with a changelog; a new version ships only if it beats the current one on held-out sessions.
- Training footage, crops and profiles stay local and gitignored (`data/profile.local.json`; per-game `data/games/<id>/local/` from W0). Labels in `data/labels/` are committed with timestamps and placeholder names only, no images; the pre-commit hook enforces this.
- `docs/inbox/` is where the user drops new plans or instructions. At the start of each session, check it; summarise each file and ask before applying. After applying, move it to `docs/plan/` (or `docs/backlog/` if deferred). Never delete an inbox file without asking.
- `feedback/` (gitignored) holds live-stream feedback captures. Triage new items at session start into `docs/feedback/YYYY-MM-DD-triage.md` with placeholder names only.
- Training data: if more data would improve a phase (labels, recordings, chat exports, footage of specific events, other games), ask at the start of that phase: what, how much, and why.
- Ask the user only for: installs, the first push, devices and live streams, real posts, spending, and privacy-affecting changes. Everything else: decide, log in the decisions file, continue.

## Secrets per environment

- Stream keys and platform tokens: the laptop's keychain (Windows Credential Manager) only.
- CI: no stream keys, ever. Mocks and loopback only.
- Agent API keys: each tool's own secret store, never in the repo.

## Settled design decisions

Agreed during planning (2026-10-26). Treat as settled unless the user reopens them.

- **Hardware:** RTX 4050 Laptop (6 GB VRAM) + Intel UHD. Pin the app to the NVIDIA GPU; check this in setup.
- **GPU (D1):** NVENC + CUDA first; DirectML + x264 fallback.
- **Kick (D2):** via the Streamer.bot bridge only.
- **Scope (D3):** personal tool, product-ready architecture. No hardcoded paths; licence headers; no installer work before P17. D3 stays open. Exception (2026-11-03, D133): Alpha 0 ships as a portable zip + `Install-Ujwalam.ps1`.
- **Never publish:** `legacy/` (private reference, never distributed) and Microsoft fonts (Corbel, Consolas) — not redistributable. Full list in `docs/licence-headers.md`.
- **Runtimes:** Node ≥22.13 (`"engines": {"node": ">=22.13"}`, first unflagged `node:sqlite`; UNVERIFIED, tested on 26.12.1), developed on 26.12.1. Python 3.14.7; at P2 start check Windows wheels for onnxruntime, faster-whisper/whisper.cpp bindings, PaddleOCR — if missing, report and propose a project-local 3.12 venv. Runtime services are stdlib-first; `ajv` is a pinned dev dependency only.
- **git:** commits use `Rajeev Sudharamachandran <mail@rajeevsudharamachandran.com>` only (repo-level config). Never put any other name or email in commits, files, logs or docs — no co-author or tool attribution trailers. Line endings via `.gitattributes`: LF default, CRLF for .cmd/.bat/.ps1, media and fonts binary.
- **git:** commit at the end of each phase after the gate passes, with user approval each time. `data/labels/` is committed; media, analysis caches, node_modules, logs, `*.local.*` and secrets are ignored.
- **P2 labelling sessions:** 20 Oct, 18 Oct, plus a third session that has an engage log (17 Oct has none).
- **Versioning:** core-function and preset manifests are separate and both carry `version`; presets record the function version they target and are migrated on load.
- **Pools:** weighted pick with a seeded RNG and no-repeat-last-N.
- **Flash safety:** ≤ 3 flashes/s per canvas, enforced at runtime; `fx test` measures real flash rate from rendered-frame luminance and fails above the limit. Randomise and AI variants stay inside it.
- **Budget scope:** effects and any event-driven animated layer (e.g. Chat Spotlight) share one budget with priority and claimed screen region; overlaps queue or drop, never stack.
- **Encoding:** see `docs/plan/2026-10-26-output-graph.md`. Rungs are deduplicated libobs encoders scaled on the GPU from the canvas; recording and replay buffer bind to existing rungs like sinks. Health dashboard shows encoder-session and NVENC load.
- **VRAM:** while live, only the live-AI sidecar (small Whisper on GPU, C4 classifier on CPU) stays loaded. Post-stream models load and unload one at a time.
- **Processes:** Qt app hosts libobs and the supervisor. The supervisor starts and restarts Node event core, live-AI sidecar and Python clip worker. A service crash never stops stream or recording. Services talk to the app only through the local JSON-RPC API. Alpha 0 (D132): the web control page on 127.0.0.1 plus native preview windows replace the Qt UI until the full studio UI.
- **SQLite:** one database file per owning process; other processes read only or write through the API.
- **Security:** browser layers never receive the local API token. Imported package scripts run without network access unless the user allows it. OBS plugins have a per-plugin disable list and a no-plugin safe mode.
- **OBS plugin wrapping:** schema and safe ranges come from `obs_properties` limits. Untagged plugins are excluded from randomise, AI variants and "similar" until tagged.
- **Remote control:** LAN web remote with token + QR pairing, obeys live-lock, never reachable from outside the LAN. Built in P15.
- **Alert fixtures:** from P3, record every real platform event as an anonymised test fixture for P9.
- **OCR (2026-10-27):** RapidOCR on Python 3.14 (PaddleOCR models through onnxruntime). Pin the version and record the model files and SHA-256s; note the licences. Accuracy gate on real corpus crops per detector. No paddlepaddle; a 3.12 env only with evidence and user approval. Conditions: `docs/evidence/2026-10-27-p2a-a1-python-wheels.md`.
- **Phase splits:** P5 → P5a (scenes, layers, inspector, H/V) and P5b (mixer, transitions with audio routing, undo, autosave). P7 → P7a (engine, SDK, guards, Chat Charge, GG Burst) and P7b (other parity presets, similar picker, pools).
- **P2 corpus:** `<clips-corpus>` (real path: `paths.clips_corpus` in `data/profile.local.json`) is read-only (never modify, move or delete). Sessions are split by session, not clip; ≥ 2 sessions held out. The analysis cache goes in a folder the user picks, with its size estimated first. No invented labels or synthetic chat.
- **MELD MULTI** = one shared low-bitrate H rung feeding the `twitch` and `kick` sinks; settings migrated from the Meld session, never guessed. Superseded 2026-10-27: Meld's MELD MULTI was a 7.5 Mbps push to Meld's cloud relay (from a 2026-04-07 prefs backup); its values are kept only as a test fixture.
- **Output topology (2026-10-27):** highest-quality H output goes directly to YouTube (presets for 1080p60 17 Mbps, 1440p60 34 Mbps, 2160p60 50 Mbps). A built-in re-encoder feeds Twitch and Kick: one shared 1080p60 H.264 CBR 6000 kbps rung, GPU-scaled from the same composited H canvas — never a decode of the YouTube stream. Platform limits from the user's reference table (2026-10-27) are recorded in `data/platforms/` as `source: user-reference-2026-10-27`.
- **§8 "P0 priority"** for H+V multistream means top priority, delivered in P6; P1 proves H and V recording.
- **Continuity (2026-11-03, D134–D136):** private remote on GitHub (first push needs the user's yes after the full-history pre-push scan); nightly 7-Zip AES-256 backup of local-only data to the Proton Drive folder, password held by the user only; feedback hotkey `Ctrl+Alt+F`.

## Model routing (tool-neutral)

- Strongest available model: libobs, render/encode, GPU/threading, AI clipping, core-function/preset engine, crash/perf debugging, security reviews, the live path, the encoder graph.
- Mid-tier model: UI, preset ports, themes, chat, importers, tests, docs.
- Small or local model: mechanical edits, renames, boilerplate, docs.
- A task moves up a tier after one failed attempt or when it touches native or pipeline code.
- Claude Code specifics: `CLAUDE.md`.

## Phase gate (end of every phase)

Full checklist: `docs/procedures/phase-gate.md`.

Do not start the next phase. For each "Done when": PASS/FAIL/BLOCKED with evidence (command + output).
For ★ presets: side-by-side capture vs legacy. Run build, lint, tests, mock suites. List placeholders,
mocks, skipped tests, files changed, risks. Fix current-phase failures and re-run. Design blockers → ADR, stop.

★ parity compares behaviour, not pixels: timing, geometry, colours (token values), trigger response and guard behaviour, captured from legacy and Ujwalam with the same test events on H and V.
