# Ujwalam — Claude Build Plan

A local-first streaming studio with Meld-style UX, OBS plugin support, AI clipping, and chat-driven scenes and effects.

Starting point: Meld Schenanigans (C:\AI\Claude\Meld Schenanigans) is the streamer's existing Meld Studio add-on setup: browser-layer overlays, chat and voice effects, a camera pop-up, a chat-engagement caricature, a theme system and a Streamer.bot bridge. Its replication guide is the reference for those features. In Ujwalam, every one of them becomes a built-in preset running on a generic core function, and each preset has a "similar effects" picker.

Feed one phase at a time to Claude Code. §10 goes into CLAUDE.md.

## 1. Objectives

- Meld Studio-quality UX and workflow (reference only; no copied assets or code).
- OBS plugin ecosystem via embedded libobs.
- AI clipping is the top priority: one highlight becomes Shorts, TikTok and Reels variants.
- Theme → scene generation, with packages that import without touching existing scenes.
- Chat scene control, chat-controlled effects, chat engagement and a scene-suggestion identifier.
- Runs locally with no AI subscriptions.
- Imports Meld session JSON and OBS scene collections.

Feature model: the app is organised as Category → Core function → Presets → Similar options. Meld Schenanigans features are the first presets and the parity tests for each core function.

## 2. Locked decisions

| Area | Decision |
|---|---|
| OS (first release) | Windows 11 |
| Engine | libobs headless + obs-browser (CEF) for HTML layers |
| UI | Qt 6 + QML, Meld-style layout |
| Services | Node ≥22, developed and tested on 26.12.1 (event core, effects runtime, engage), Python worker (AI clipping; 3.14.7 for now, wheel availability checked at P2 start) |
| Storage | SQLite + media on disk |
| AI | Local only: whisper.cpp, ONNX models, FFmpeg, optional llama.cpp |
| Meld | MeldAdapter kept for the transition period and for import; the native app is the target |
| Licence | GPL-2.0+ if distributed |

Resolved 2026-10-26:

- **D1 GPU vendor:** NVIDIA-first (NVENC; CUDA for whisper.cpp/ONNX), with DirectML + x264 fallback.
- **D2 Kick ingestion route:** Streamer.bot bridge.
- **D3 Personal tool or product:** personal first, product-ready architecture (no hardcoded paths, licence headers, clean boundaries). Installer, auto-update and GPL distribution work deferred.

Dev hardware: RTX 4050 Laptop (6 GB VRAM) + Intel UHD (hybrid/Optimus). NVENC, Whisper and llama share 6 GB, so AI jobs need a VRAM budget and queue. The app must be pinned to the NVIDIA GPU for capture.

## 3. Feature model

```
Category        e.g. Effects
 └ Core function   e.g. Edge discharge (generic, parameterised engine capability)
    └ Preset        e.g. "Chat Charge" (from Meld Schenanigans) = function + params + theme + trigger
       └ Similar    e.g. Neon Pulse, Fire Edge, Glitch Edge (same function or same family)
```

Rules:

- A core function is engine code with a typed parameter schema, H/V canvas support, theme-token inputs and a performance budget.
- A preset is data only (JSON): function id + params + trigger binding + theme overrides. No code.
- Presets are swappable in place: changing the effect keeps its trigger, layer, canvas and scene.
- Every preset declares family, tags (motion, intensity, mood, colourUse, flashes) and canvases.

"Similar effects" picker (every preset):

- Same function, different params: curated variants plus a "randomise within safe ranges" button.
- Same family, different function: e.g. edge discharge → border pulse, corner flare.
- Similarity ranking: deterministic tag/param distance; optional local embedding of descriptions. No cloud.
- Live side-by-side preview: fire test events on H and V canvases, then "Replace", "Add to pool" or "Duplicate as new preset".
- Optional AI variant: a local LLM proposes params only, validated against the schema; never code.
- Effect pools: a group of presets with weights. One is picked per trigger, e.g. chat-storm's 8 effects.

## 4. Categories, core functions, built-in presets, similar options

Legend: ★ = Meld Schenanigans parity preset (must match the original behaviour).

### 4.1 Layers & graphics engine

| Core function | Built-in presets | Similar options |
|---|---|---|
| Full-canvas transparent HTML layer (H/V aware, auto-reload when server restarts) | ★ all current overlays | — |
| Native text/image/video layers with fitment modes | — | — |
| Chat list rail (lines, height, platform badges) | ★ Chat List | Bubble stack, ticker-style chat, fade-in column |
| Alert cards (follow, sub, gift, raid, member, tip) | ★ Alert Box (glass cards) | Banner slide, stamp, full-screen takeover |
| HUD composite (goal bar, counters, wordmark, camera brackets) | ★ Blood Moon HUD | Minimal bar, esports scorebug, corner stack |
| Scrolling ticker | ★ Social Ticker | Rotating cards, fade carousel |
| Chat spotlight (highlight one message, slam a keyword, sender badge) | ★ Chat Spotlight (native rebuild of the Spark widget, no network SDK) | Comic panel, lower-third quote, sticky note |
| Single-monitor HUD (status, timer, chat over the game) | New | — |

### 4.2 Effects engine

| Core function | Built-in presets | Similar options |
|---|---|---|
| Edge discharge (electric arcs around the canvas edge; colour, duration, thickness) | ★ Chat Charge (red/blue) | Neon pulse, fire edge, glitch edge, ice crackle |
| Full-canvas burst (particles, shapes, overlays; one-shot) | ★ Chat Storm pool: red lightning, blue lightning, vampire bloodlust, werewolf claw, ghost possession, kaiju roar, zombie horde, sparkling party | Confetti, snowstorm, shockwave, screen crack, emoji rain |
| Text slam (word slams in with sparks and shake) | ★ GG Burst (GG, POW), ★ Voice Callout HUD bar | Typewriter, stamp, neon flicker, comic POW |
| Camera frame decorator (follows a layer's live geometry) | ★ Cam-Pop Frame (claw rip-in, fang corners, blood drips, fog) | Neon frame, film-strip, glitch border, seasonal frames |
| Atmosphere layer (rain, moon, heat, embers, vignette, flash, brackets; back and front instances) | ★ Atmos Frame | Snow, fog, dust motes, scanlines, petals |
| Keyed character clip (alpha video plus speech bubble, entry side and width) | ★ Chat Engage caricature | Mascot sprite, emoji avatar, PNG-tuber bounce |
| Effect pool (weighted random pick per trigger) | ★ Chat Storm 8-effect pool | User-built pools |

Engine guards (all effects):

- Global effects-per-minute budget and per-effect cooldown.
- Max concurrency.
- Flash limiter: ≤ 3 flashes per second per canvas.
- Intensity cap so gameplay stays readable.
- Text rendered safely (no innerHTML).
- Entrances < 600 ms, exits < 400 ms.
- Effects stay idle between events.

### 4.3 Triggers & automation (rules engine)

Triggers:

- Chat message, keyword/regex, emote
- Burst (N messages in T seconds) and distinct-user burst
- Voice word (local speech-to-text), voice level spike (threshold, hold time, device)
- Random timer (mean interval)
- Layer shown / scene changed, hotkey
- Redemption, bits/superchat tier, follow/sub/raid
- Clip-signal spike

Conditions: current scene, live/offline, canvas, role, cooldown, time window.

Actions:

- Show/hide layer, animate transform (stepped grow/shrink), restore exact geometry
- Fire effect or pool, switch scene, toggle camera background effect
- Post chat reply, save replay, drop marker

| Built-in rules | Similar options |
|---|---|
| ★ Cam Pop: on chat message / burst 5 in 10 s / voice spike 0.12 for 150 ms / random about every 12 min → grow camera from 0.72 in 6 steps (360 ms in, 300 ms out), hold 5 s, hide, restore geometry; drop triggers during a pop | Slide-in, corner swap, zoom punch, picture-in-picture flip |
| ★ Voice triggers: DOMINATION, HARDPOINT, KILL, SUPER, WEAPON → Voice Callout | Per-game word packs |
| ★ Timed messages: Stream Tips, Ask For Suggestions, Appreciation (one random line per tick, per platform) | Schedules, polls, rotating CTAs |

### 4.4 Sources, camera & audio

| Core function | Built-in presets |
|---|---|
| Capture devices (capture card, webcam, mic) with permission and disconnect handling | ★ Live Gamer Ultra 2.1, Insta360 Link 2C, WARRKY capture, FIFINE SC3 bindings |
| Source duplicator (V canvas mirrors an H source) | ★ Vertical camera duplicate |
| Camera background effects (removal, blur, tint) via plugin | Replaces the unreliable Meld toggle |
| Mic metering and spike detection (WASAPI), calibration wizard (noise floor, speech, peak) | ★ mic-check |
| Local speech-to-text keyword spotting (replaces Streamer.bot STT, which stays optional) | ★ voice-callout source |
| Audio mixer: ordering, VST3, multitrack, Twitch VOD music split | — |

### 4.5 Chat & community

| Core function | Built-in presets | Similar options |
|---|---|---|
| Unified multi-chat ingest (Twitch EventSub, YouTube streamList, Kick via bridge, Streamer.bot connector) | ★ Twitch, YouTube, Kick | — |
| Moderation: blocklist in and out, self-echo filter, reply routing to the source platform | ★ engage blocklist, 120 s self-echo | — |
| Engagement bot: template pools (regex match/not), tiers (welcome, return, direct, ambient), rate limits, per-viewer memory, trigger-only self-learning | ★ Chat Engage (about 83 lines, 25 pools incl. 7 CODM pools; gaps 25 s / 90 s; 40 per hour; 2 per user per stream) | Pool packs per game, shout-out bot, quiz bot |
| Timed message groups | ★ see 4.3 | — |
| Scene-suggestion identifier (C4 below) | New | — |

### 4.6 Theme & brand

| Core function | Built-in presets |
|---|---|
| Token system (tokens.json → CSS variables; every layer reads tokens only) | ★ Stream Brand |
| Theme from media (OKLab k-means, WCAG-pushed text roles, provenance: extracted, derived, invented, fixed; refuses partial palettes) | ★ Blood Moon, ★ Halloween 2026 |
| Atmosphere params per theme | ★ Blood Moon atmos |
| Per-layer theme override and multiple stored themes | ★ ?theme= behaviour |
| Local fonts only (incl. Malayalam) | ★ Black Ops One, Consolas, Corbel, Baloo Chettan 2 |
| Similar themes: palette and mood neighbours, seasonal variants | New |

### 4.7 Scenes, packages & generation (core C1)

| Core function | Built-in presets |
|---|---|
| Scene recipe → scene (positions, sizes, URLs, visibility, effects; "by hand" list for unsupported items) | ★ Mobile Live Full view H/V, ★ Mobile Live - Blood Moon H/V (14 layers) |
| Theme → scene generator: layout slots (atmos-back, game, cam, chat-rail, HUD, effects, atmos-front) with H/V rules and safe zones; rules first, optional local LLM via typed schema | New |
| Scene Package .upkg (manifest, scenes, theme, assets, overlays, previews) | Export of every built-in scene |
| Isolated import: new namespaced scenes only; devices linked by reference; dry-run diff; one transaction with rollback; before/after hash of existing state must match | New |
| Importers: Meld session.json, OBS scene collection, Schenanigans recipes | ★ session-backups |
| Layer map and session snapshot (auto-generated docs) | ★ layer-map.md, dump |

### 4.8 Chat scene control (core C2)

- Commands and aliases (multilingual), timed votes counted by distinct users, redemptions with fulfil/refund.
- Role permissions; per-scene chatControllable flag (default off); cooldowns; auto-return timer; queue cap.
- Never from chat: stream, record, outputs, deletion, settings, devices, main mic mute.
- Audit log; panic hotkey.
- Presets: "Cam on demand", "Vote next scene", "Redeem: horror mode". Similar options: vote vs command vs redemption variants of each.

### 4.9 Chat engagement + scene-suggestion identifier (core C4)

- Intents: scene_request, replay_request, effect_request, question, hype, other.
- Classifier: lexicon/regex per language (English, Malayalam, Manglish) → small multilingual ONNX classifier for misses.
- Aggregate by distinct users in a sliding window → suggestion card with confidence → hotkey accept.
- Auto-apply only for chatControllable scenes when live-lock allows.
- Per-stream report: what chat asked for, which requests went unanswered, top intents.
- Engage replies stay template-based; an optional local LLM may draft into a review queue only.

### 4.10 AI clipping (core C5, top priority)

- Live: replay buffer H and V; per-second fusion of signals:
  - chat velocity EWMA against the stream's baseline, distinct users, emote/caps density
  - "clip it" intents, audio level, voice words, redemptions, hotkey
- Above threshold → save replay + marker with signal breakdown. Windows are backdated 20–40 s, because chat reacts after the moment.
- Post-stream: transcribe → kill-feed OCR (CODM profile) → ranked candidates with reasons → master edit → 3 variants (full crop, gameplay + facecam, blurred fill) → captions and safe zones → validate → export.
- Presets: "CODM ranked", "Squad wipe", "Funny moment (chat-led)". Similar options: alternative caption styles, layouts and pacing per platform.

### 4.11 Outputs

> **Superseded** by `docs/plan/2026-10-26-output-graph.md` (compositor → encoder pool → delivery pool). Text below kept for history.

- Multistream with independent profiles: ★ MELD MULTI, YouTube H, YouTube V, Twitch.
- Recording; replay buffer; "record from N seconds ago".
- Health dashboard: dropped frames, CPU/GPU, per-output stats.

### 4.12 Control, safety & dev tooling

| Core function | Built-in from Schenanigans |
|---|---|
| Local API (JSON-RPC, token) incl. createScene/createLayer; obs-websocket v5 subset for Streamer.bot and Stream Deck | ★ meld.mjs commands (superset) |
| Live-lock: writes need confirmation, on-air writes need a second confirmation | ★ "yes" / "yes, on air" |
| Dry run by default for every bulk change; automatic backups | ★ scene-build backups |
| Test bench: preview page, fire test events, both canvases | ★ preview.html, check-overlays |
| Mock services (studio, chat bus) for CI | ★ mock-meld, mock-streamerbot, mock-chat |
| Program screenshot H and V | ★ meld.screenshot (adds V, which Meld lacks) |
| Service supervisor (starts with the app) | ★ engage-watch |

## 5. Effect & preset authoring (Effect SDK)

Formats: HTML/Canvas2D/WebGL page (runs in a browser layer) or native shader filter (libobs .effect / plugin).

Manifest:

```
{id, function, family, tags, params{schema, defaults, safeRanges}, triggers[], canvases,
 durationMs, maxConcurrent, flashesPerSec, budgetCost, themeTokens[]}
```

CLI:

- `ujwalam fx new <function>` scaffolds from template
- `fx test` renders H/V and fires events
- `fx variants` generates N param variants inside safe ranges

Imported OBS plugins that add filters or sources are wrapped as core functions, so they also get presets and appear in "similar".

## 6. Architecture (summary)

```
Inputs (chat, voice, hotkeys, redemptions)
 → Event Core (normalise, moderate, classify, rules, live-lock, audit)
 → Effects runtime / Scene control / Engage / Suggestions / Clip signals
 → StudioAdapter (NativeAdapter = libobs; MeldAdapter for transition and import)
 → Outputs + AI worker (post-stream clipping) → Publishing
```

## 7. Phases

Format: Goal / Done when. Each phase is one session; split if larger. Each phase ends with the gate in §11. Parity presets (★) are the acceptance tests for their core functions.

| # | Goal | Done when |
|---|---|---|
| P0 | Repo, CLAUDE.md, skills, Schenanigans copied to legacy/ as reference, feature registry schema (category / function / preset / tags) | Registry validates; legacy overlays still serve |
| P1 | libobs spike: capture card + mic, GPU recording, obs-browser renders legacy overlays, 5 plugins tiered | ★ Chat Charge renders in a recording |
| P2 | AI clip CLI spike (offline): recording + chat log → ranked candidates → 3 variants | Runs on 3 real CODM streams; beats chat-only baseline |
| P3 | Event Core + multi-chat ingest + moderation + live-lock + audit | Real and mock chat flow; forbidden actions refused |
| P4 | Project model, NativeAdapter, local API, Meld/OBS/recipe importers | ★ Mobile Live Full view H/V import and render |
| P5 | Studio shell (Meld-style): scenes, layers, inspector, mixer, H/V canvases, undo, autosave | Imported session usable end to end |
| P6 | Replaced by O0–O3 in `docs/plan/2026-10-26-output-graph.md` (O0 may run right after P0; O4–O5 deferred) | See O0–O3 |
| P7 | Effects engine core functions + Effect SDK + similar picker + pools | ★ Chat Charge, ★ Chat Storm pool, ★ GG Burst, ★ Voice Callout, ★ Atmos, ★ Cam-Pop Frame at parity; 3 similar options each |
| P8 | Rules engine (triggers/conditions/actions) + mic calibration + local STT keywords | ★ Cam Pop and ★ voice triggers at parity |
| P9 | Layers library: chat list, alerts, HUD, ticker, spotlight, single-monitor HUD | ★ presets at parity, Spark replaced |
| P10 | Theme engine + similar themes | ★ Blood Moon and ★ Halloween regenerate identically from source art |
| P11 | C1 generator + .upkg + isolated import | New theme → H+V scenes; existing state hash unchanged |
| P12 | C2 chat scene control + redemptions | Permission and cooldown tests pass live-locked |
| P13 | C4 engage port + suggestion identifier + stream report | ★ Chat Engage parity; scene_request precision ≥ 0.8 |
| P14 | C5 live signals + clip studio UI (review, master edit, variants) | Live test stream → markers → 3 exported variants |
| P15 | obs-websocket compat + plugin manager (plugins appear as functions) | Streamer.bot drives Ujwalam; plugin filter has presets |
| P16 | Publishing: export-only, YouTube, TikTok drafts, Instagram | Test-account upload verified, no duplicates |
| P17 | Hardening: load test, crash recovery, packaging, licence notices | Go/no-go report |

Deferred: cloud inference, analytics feedback loop, macOS/Linux.

## 8. Most-requested features (from community research)

| Feature | Where in the plan |
|---|---|
| Horizontal + vertical simultaneous multistream | 4.11 (P0 priority) |
| Unified multi-chat | 4.5 |
| Instant replay / "record from N seconds ago" | 4.11, 4.10 |
| Scene export with filters and media | 4.7 |
| Chat / channel-point control | 4.8 |
| Auto clips from chat spikes | 4.10 |
| In-game HUD for single-monitor setups | 4.1 |
| Audio mixer ordering, VST3, multitrack, VOD music split | 4.4 |
| Per-scene/stinger transitions with audio routing | P5 |
| Health dashboard, remote/touch control | 4.11, 4.12 |

## 9. Known Schenanigans issues → tests

- A layer stays blank when its server was down → auto-reload test.
- Alerts not mapped → real-payload alert mapping.
- Vertical rendering unverified → V screenshot test.
- Camera background toggle unreliable → plugin-based background effect.
- Chat Spotlight overlaps Chat Charge / Chat Storm → effect budget and priority test.
- Invented colours → provenance flag shown in the theme UI.

## 10. CLAUDE.md rules

See `CLAUDE.md` at the repo root (rules copied verbatim, plus settled design decisions and model routing).

## 11. Phase gate

Do not start the next phase. For each "Done when": PASS/FAIL/BLOCKED with evidence (command + output).
For ★ presets: side-by-side capture vs legacy. Run build, lint, tests, mock suites. List placeholders,
mocks, skipped tests, files changed, risks. Fix current-phase failures and re-run. Design blockers → ADR, stop.

## 12. Cost

Runtime is free (local models, own hardware). Platform APIs are free but quota- or audit-gated. Development uses your Claude plan.
