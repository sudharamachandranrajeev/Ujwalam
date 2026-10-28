# Ujwalam

Local-first streaming studio: Meld-style UX, embedded libobs, AI clipping, chat-driven scenes and effects.
Full plan: `docs/2026-10-26-build-plan.md` (§1–12, baseline). Amendments: `docs/plan/YYYY-MM-DD-*.md`, newest wins; index with phase placement: `docs/plan/INDEX.md`. Reference setup: `C:\AI\Claude\Meld Schenanigans` (copied to `legacy/` in P0).

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
- Done = test or runtime evidence in docs/evidence/. A mock is not a feature.
- New docs/reports: YYYY-MM-DD-descriptive-name. End each task listing files created or changed.
- Outputs: compositor → encoder pool → delivery pool. Sinks never own encoders. Audio encoded once.
- Platform limits live in data/platforms/*.json with source + checked date; never hardcode them.
- Never test outputs against real platforms until loopback ffprobe assertions pass.
- Never hardcode hardware encoder session limits; probe at runtime.
- Public repo: never commit or push brand names, channel names or ids, IGN, clan tag, any of their variants, face images, other players' names, game account/device ids (e.g. the CODM bottom-right watermark) or personal details. Committed files use placeholders; real values live in the gitignored `data/profile.local.json` (template: `data/profile.example.json`). Images that need them go in `docs/evidence/private/` (gitignored), or are cropped or blurred.
- Local build, tests and running use all of them freely: real brand, channel names, IGN and every variant, real footage and chat, real overlays and features. The scrub applies only to what is committed and pushed.
- Git hooks (`core.hooksPath tools/git-hooks`) scan staged files, paths and commit messages for every term in `data/profile.local.json` (case-insensitive, separator variants) and block hits. Never bypass them (`--no-verify`).
- Before any first push to a remote: run the pre-push scan over the full history, list every file to be pushed, and wait for the user's yes.
- Game-specific logic is data in `data/games/<id>/`; never hardcode a game in engine code.
- Every detector value needs evidence (frames, counts, date) and a status (unverified|verified).
- Event names, weights and windows are proposed from footage and labels and approved by the user; never invented.
- Pack changes are versioned with a changelog; a new version ships only if it beats the current one on held-out sessions.
- Training footage, crops and profiles stay local and gitignored (`data/profile.local.json`; per-game `data/games/<id>/local/` from W0). Labels in `data/labels/` are committed with timestamps and placeholder names only, no images; the pre-commit hook enforces this.
- `docs/inbox/` is where the user drops new plans or instructions. At the start of each session, check it; summarise each file and ask before applying. After applying, move it to `docs/plan/` (or `docs/backlog/` if deferred). Never delete an inbox file without asking.
- Training data: if more data would improve a phase (labels, recordings, chat exports, footage of specific events, other games), ask at the start of that phase: what, how much, and why.

## Settled design decisions

Agreed during planning (2026-10-26). Treat as settled unless the user reopens them.

- **Hardware:** RTX 4050 Laptop (6 GB VRAM) + Intel UHD. Pin the app to the NVIDIA GPU; check this in setup.
- **GPU (D1):** NVENC + CUDA first; DirectML + x264 fallback.
- **Kick (D2):** via the Streamer.bot bridge only.
- **Scope (D3):** personal tool, product-ready architecture. No hardcoded paths; licence headers; no installer work before P17. D3 stays open.
- **Never publish:** `legacy/` (private reference, never distributed) and Microsoft fonts (Corbel, Consolas) — not redistributable. Full list in `docs/licence-headers.md`.
- **Runtimes:** Node ≥22 (`"engines": {"node": ">=22"}`), developed on 26.12.1. Python 3.14.7; at P2 start check Windows wheels for onnxruntime, faster-whisper/whisper.cpp bindings, PaddleOCR — if missing, report and propose a project-local 3.12 venv. Runtime services are stdlib-first; `ajv` is a pinned dev dependency only.
- **git:** commits use `Rajeev Sudharamachandran <mail@rajeevsudharamachandran.com>` only (repo-level config). Never put any other name or email in commits, files, logs or docs — no co-author or tool attribution trailers. Line endings via `.gitattributes`: LF default, CRLF for .cmd/.bat/.ps1, media and fonts binary.
- **git:** commit at the end of each phase after the gate passes, with user approval each time. `data/labels/` is committed; media, analysis caches, node_modules, logs, `*.local.*` and secrets are ignored.
- **P2 labelling sessions:** 20 Oct, 18 Oct, plus a third session that has an engage log (17 Oct has none).
- **Versioning:** core-function and preset manifests are separate and both carry `version`; presets record the function version they target and are migrated on load.
- **Pools:** weighted pick with a seeded RNG and no-repeat-last-N.
- **Flash safety:** ≤ 3 flashes/s per canvas, enforced at runtime; `fx test` measures real flash rate from rendered-frame luminance and fails above the limit. Randomise and AI variants stay inside it.
- **Budget scope:** effects and any event-driven animated layer (e.g. Chat Spotlight) share one budget with priority and claimed screen region; overlaps queue or drop, never stack.
- **Encoding:** see `docs/plan/2026-10-26-output-graph.md`. Rungs are deduplicated libobs encoders scaled on the GPU from the canvas; recording and replay buffer bind to existing rungs like sinks. Health dashboard shows encoder-session and NVENC load.
- **VRAM:** while live, only the live-AI sidecar (small Whisper on GPU, C4 classifier on CPU) stays loaded. Post-stream models load and unload one at a time.
- **Processes:** Qt app hosts libobs and the supervisor. The supervisor starts and restarts Node event core, live-AI sidecar and Python clip worker. A service crash never stops stream or recording. Services talk to the app only through the local JSON-RPC API.
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

## Model routing

Decisions and review: main session. Coding through subagents:

- **Opus, high effort:** libobs, render/encode, GPU/threading, AI clipping, core-function/preset engine, crash/perf debugging. Phases P1, P2, O1–O3, P11, P14, P17, plus P4 NativeAdapter, P7 engine/SDK, P8 STT, P13 ONNX classifier, P15 plugin manager.
- **Sonnet, medium effort:** UI, preset ports, themes, chat, importers, tests, docs. Phases P0, O0, P3 (Opus reviews live-lock), P5, P9, P10, P12, P16, plus P4 importers, P7 preset ports, P8 rules, P13 engage port, P15 obs-websocket.
- **Sonnet, low effort:** mechanical edits, renames, boilerplate.
- A Sonnet task moves to Opus after one failed attempt or when it touches native or pipeline code.

## Phase gate (end of every phase)

Do not start the next phase. For each "Done when": PASS/FAIL/BLOCKED with evidence (command + output).
For ★ presets: side-by-side capture vs legacy. Run build, lint, tests, mock suites. List placeholders,
mocks, skipped tests, files changed, risks. Fix current-phase failures and re-run. Design blockers → ADR, stop.

★ parity compares behaviour, not pixels: timing, geometry, colours (token values), trigger response and guard behaviour, captured from legacy and Ujwalam with the same test events on H and V.
