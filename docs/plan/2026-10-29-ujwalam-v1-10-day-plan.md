# Ujwalam v1 — 10-day delivery plan

Paste into Claude Code, or pick up from `docs/inbox/`. This replaces the phase order for v1. Everything not listed here is deferred, not dropped (§8).

**Target:**
- **Day 5 (2 Nov):** streamable build. I can go live from Ujwalam with my scenes, overlays and effects.
- **Day 10 (7 Nov):** v1. Automatic clipping and posting work end to end, packaged and tested.

---

## 1. v1 scope

| # | Feature | What "done" means |
|---|---|---|
| F1 | **Meld import** | My current Meld session imports: scenes, layers, devices (capture card, Insta360, FIFINE), H+V canvases |
| F2 | **Minimal studio UI** | Scenes list, layer list (show/hide/order), preview H and V, audio mixer (volume/mute/meters), start/stop stream + record, status bar (live, dropped frames, CPU/GPU) |
| F3 | **Outputs** | Shared encoders (O1 + O2): YouTube H, YouTube V, Multi (Twitch + Kick on one shared low-bitrate encode), local recording. A drop on one destination leaves the others running. |
| F4 | **Effects** | All legacy overlays run unchanged as browser layers (Chat Charge, Chat Storm, GG Burst, Voice Callout, Atmos, Cam-Pop Frame, alerts, chat list, ticker, HUD). The event core drives them with guards: effects-per-minute budget, cooldowns, flash limit ≤ 3/s. Chat-triggered **effects** are on. Chat-triggered **scene/stream actions** stay dry-run. |
| F5 | **Cam-pop** | Cam-pop rule runs inside Ujwalam via the adapter (chat / burst / voice spike / random) |
| F6 | **Automatic clipping** | Replay buffer (H and V) always on while live. Markers from: hotkey, chat spike, "clip it" in chat, audio peak, and the proven CODM detectors (medal banner, multi-kill) reading the clean game source **post-stream only**. After the stream: ranked candidates → 3 vertical variants (Shorts / TikTok / Reels layouts), burned captions (local Whisper), validated files. |
| F7 | **Automatic posting** | Review screen (simple list: preview, title, caption, accept/reject), then post. **YouTube Shorts:** real upload via YouTube Data API (OAuth, resumable, status check, no duplicates). **TikTok:** upload as a draft to my inbox (unaudited apps can't post publicly). **Instagram:** export-only in v1. Modes: review-first (default) and auto-post-approved-rules (opt-in). |
| F8 | **Event core** | As built in P3 (Streamer.bot ingest, live-lock, audit, API). |
| F9 | **Packaging** | Local install zip with SHA-256 checksum, start script, how-to doc, config/profile backup and restore. |

### Deferred to v1.1+ (do not build now)
- native effects engine, presets, similar-effects picker
- theme generator, C1 scene packages
- chat scene control (C2 live), suggestion identifier (C4)
- live game-event watcher, full clip studio editor
- Instagram posting, analytics
- plugin manager, obs-websocket compatibility
- bandwidth governor (O3)
- "Train a game" workflow, labelling
- updater, theme switching, bring-your-own AI, GitHub releases

---

## 2. Day plan

Three agents run in parallel (A = core/import, B = UI, C = outputs/clips). One integration owner (main session) merges and tests daily.

| Day | Agent A | Agent B | Agent C | **Ray test (end of day)** |
|---|---|---|---|---|
| 1 (29 Oct) | Close P3 (open items UNVERIFIED), checkpoint commit; project model | UI route decision + skeleton window with preview | Output config → O1 loopback (1 encoder, N sinks) | T1: app launches, preview shows capture card |
| 2 (30 Oct) | Meld importer + NativeAdapter | Scenes + layers panels wired to adapter | O2 shared encoders H/V/Multi, loopback ffprobe checks | T2: my Meld session imports and renders in preview |
| 3 (31 Oct) | Legacy overlays as browser layers; event core → overlays | Mixer, start/stop, status bar | Real unlisted test streams (YouTube H, V; Twitch; Kick) | T3: 15-min private test stream to all destinations |
| 4 (1 Nov) | Effect guards (budget, cooldown, flash), cam-pop rule | Polish: hotkeys, errors shown clearly | Replay buffer H+V, markers (hotkey, chat, audio) | T4: chat triggers effects; hotkey saves a marker |
| 5 (2 Nov) | Integration fixes | Integration fixes | 1 h stream + record soak | **T5: real stream from Ujwalam (streamable milestone)** |
| 6 (3 Nov) | — | Review/posting screen | Post-stream clipper: candidates + medal/multi-kill detectors | T6: run clipper on my day-5 recording; check the top 10 |
| 7 (4 Nov) | YouTube OAuth + upload (test account first) | Review screen wired to clipper | 3 variants + captions + validation | T7: approve 1 clip → private YouTube Short uploaded |
| 8 (5 Nov) | TikTok draft upload | Auto-post rules UI (opt-in) | Clip quality fixes from T6/T7 feedback | T8: full loop: stream → clips → review → post (YouTube private, TikTok draft) |
| 9 (6 Nov) | — | — | 2 h soak (stream + record + effects + clipper queued after) | T9: full real stream + auto clips |
| 10 (7 Nov) | Packaging, install zip + checksum, backup/restore | How-to doc | Fixes from T9 | **T10: install from zip on a clean folder, go live** |

If behind schedule, cut in this order:
1. TikTok drafts (→ export-only).
2. Auto-post rules (review-first only).
3. Game detectors (chat/audio/hotkey markers only).

Never cut testing or security checks.

---

## 3. Testing as we go

### Automated (every change)
- `npm run ci` (lint, all tests, private scan, validators, stray mocks). Benchmarks advisory until day 9.
- Each feature lands with its tests: unit tests plus at least one integration test against the real engine or loopback.
- Loopback first: no real platform until the loopback ffprobe checks pass.
- Mocks are never counted as "done".

### Daily Ray test (T1–T10)
- At the end of each day, Claude Code gives me a short **test card**:
  - what to test, step by step (≤ 10 steps, ~15–20 min);
  - what I should see;
  - how to report a failure (one line: step number + what happened).
- **The test card is written to `docs/tests/YYYY-MM-DD-T<n>.md`.**
- My results go into the same file. Failures become the first task next morning.
- A feature counts as done only after it passes my test **and** the automated tests.

### Release checks (day 9–10)
- 2 h soak: stream + record + effects, no stall > 100 ms on the live path, no dropped-frame budget breach, memory stable.
- Crash test: kill the app mid-stream; restart; project and recordings intact.
- Security review (independent agent, code only) of OAuth/token handling, the local API and anything opening a port.
- Private scan over the full history before any push.

---

## 4. Rules for speed

- **Keep working without asking** on approved v1 items, tests, fixes inside scope, docs and evidence.
- **One batched question list per day**, with your recommended default. If I don't answer within the day, defaults apply, **except for:**
  - deletions
  - installs
  - commits
  - real-platform posts
  - devices and live streams
  - spending
- **Commits:** a checkpoint commit at the end of each day after CI passes. Show `git status` in the daily report; I approve with one word.
- **Phase gates:** short. Tests pass, lint clean, private scan clean, evidence file, Ray test passed.
- **No extra runs or scope** without asking. Anything outside v1 goes to `docs/backlog/`.

---

## 5. Decisions needed on day 1 (with defaults)

1. **UI route:** fastest route to F2. Options:
   - minimal Qt/QML (the locked stack);
   - local web control UI + native preview window.

   Default: whichever you can show working by end of day 2; give reasons.
2. **YouTube account for testing:** default is posting as **private** to my channel until T8 passes, then I choose public/unlisted per clip.
3. **Google Cloud project + OAuth client:** I'll create it if you give me the exact steps (default: you write the steps on day 6, I do it).
4. **TikTok developer app:** same (default: steps on day 7; if approval is slow, TikTok becomes export-only).
5. **Captions:** Whisper model size. Default: small, CPU/GPU auto.

---

## 6. Privacy and safety (unchanged)

- Names, IGN, brand and paths stay local; nothing personal in git.
- Tokens are kept in the OS keychain only.
- Raw chat purged after 30 days.
- Nothing posts publicly without my approval, unless I turn on auto-post rules.
- Every post is logged with platform id and status. Retries never duplicate.
- Jev is optional and off by default in v1.

---

## 7. Daily report format (end of each day)

1. What's done (with test results).
2. Today's Ray test card (path).
3. Questions (batched, with defaults).
4. Risks to the date.
5. `git status` for the checkpoint commit.
6. Files created/changed.

---

## 8. After v1

Resume the original build plan from P7 onward (native effects, presets, theme generator, chat control, suggestions, live detectors, clip studio, plugins, publishing to Instagram, training workflow). The training-track backlog stays parked until then.
