# Ujwalam: Alpha build in 2–4 days, live-feedback loop, continuity from anywhere

This takes priority over the v1 10-day plan's order. Scope stays the same; the order changes so that a **live-testable Windows 11 build comes first** and every later feature lands one at a time, tested live.

---

## Part A: Testable Alpha build (2–4 days)

### Goal
A Windows 11 install I can stream with: real scenes, my overlays and effects, multistream, recording. It has to be usable on a real stream, not polished. Meld stays installed as my fallback throughout the alpha.

### Alpha 0 scope (only this)
1. **Engine:** libobs headless (proven in P1), with the capture card, Insta360 and FIFINE.
2. **Scene:** the "Default H" preset (`docs/plan/2026-10-29-preset-h-default-layout.md`) plus a vertical scene. Use the Meld import if it's ready; otherwise hand-build these two scenes from the preset.
3. **Overlays and effects:** all legacy overlays as browser layers, driven by Streamer.bot as today.
4. **Outputs:** YouTube H, YouTube V, Multi (Twitch + Kick on one shared encode), local recording. Stream keys stored in the Windows keychain.
5. **Control UI, the fastest route:** a local web control page served by the app on 127.0.0.1 (scenes, layers show/hide, mixer, start/stop, status), plus a native preview window. A full Qt studio UI comes later.
6. **Safety:** panic hotkey, live-lock, feature flags, crash-safe recording.
7. **Live feedback capture** (Part B).
8. **Replay buffer + clip hotkey** (markers only; the clip pipeline comes later).

### Day plan

| Day | Work | Ray test (≤ 20 min) |
|---|---|---|
| 1 | Clean checkpoint commit (handover items). App shell: engine + scenes + web control page + preview window. Keychain stream keys. | App opens, preview shows game + cam + overlays |
| 2 | Outputs (loopback check, then real private/unlisted tests), recording, replay buffer, Streamer.bot overlays, cam-pop, panic, feedback hotkey | 15-min private test stream to all destinations |
| 3 | Installer + packaging (below), diagnostics bundle, crash recovery, 1 h soak | Install from the package on a clean folder, go live privately |
| 4 | Buffer: fixes from day 3, first **real** stream on Alpha 0 | Real stream, with Meld ready as fallback |

### Packaging for Windows 11
- **Default:** a portable zip + `Install-Ujwalam.ps1` that copies to `%LOCALAPPDATA%\Ujwalam\<version>`, creates Start-menu/desktop shortcuts, and keeps the previous version for one-click rollback. No admin rights needed.
- Bundles the OBS runtime it needs (with GPL notices), checks for the VC++ runtime, and ships the SHA-256 checksum file.
- **Later (needs approval):** a proper installer (Inno Setup or MSIX) and code signing.
- **Version scheme:** `0.1.0-alpha.N`, with a short changelog per build.

---

## Part B: Live-feedback-first development loop

Live feedback outranks everything else on the plan.

### Capturing feedback during a stream
- **Feedback hotkey** (default `Ctrl+Alt+F`, configurable). Each press saves:
  - a timestamp;
  - the last 30 s of replay (H and V);
  - current scene, CPU/GPU and dropped frames;
  - the last 200 log lines.

  It goes to `feedback/<date>/<time>/`, which is local and gitignored.
- **Quick voice note (optional):** hold the hotkey to record 10 s of my mic as the note. It's transcribed locally after the stream.
- **Post-stream feedback form** (web control page): list of hotkey moments, add text, tag each one bug / annoying / wish / works-well, and set its severity.
- **In-app "Report" button:** creates a prefilled GitHub issue in the private repo (title, version, diagnostics summary, no personal data) once the private remote exists.

### How the agent uses feedback
- **Every session starts with `feedback/`.** Triage new items into `docs/feedback/YYYY-MM-DD-triage.md` (one line each: item, cause guess, fix, size).
- **Priority order:**
  1. Anything that broke or risked a live stream.
  2. My bug reports.
  3. Annoyances.
  4. Wishes.
  5. Planned features.
- **Build cadence:** at least one alpha build per day with fixes, so I can test on my next stream.

### Adding features one by one, live-tested
- Each new feature ships behind a **feature flag**, off by default. I switch it on from the control page while live and off instantly if it misbehaves, with no rebuild.
- **Order after Alpha 0:**
  1. Clip pipeline (post-stream variants).
  2. Posting (YouTube private, TikTok drafts).
  3. Effect guards + chat-triggered effects.
  4. Full studio UI.
  5. Meld import polish.
  6. Then the rest of the build plan.
- A feature is "done" only after it's used on at least one real stream with no high-severity feedback.

---

## Part C: Continuity from anywhere (no single limit blocks the project)

### 1. Project state lives in the repo, not in any one tool
- **`AGENTS.md`** at the root, mirroring the rules in `CLAUDE.md`. Most coding agents read it (Codex CLI, Gemini CLI, OpenCode, Cursor and others). Keep the two in sync: CLAUDE.md includes AGENTS.md, or they're generated from one source.
- **Always current:** the handover file, plan index, decisions, end-list and feedback triage.
- **Session protocol for any agent or tool:**
  - *Start:* read AGENTS.md, the handover, the plan index and the feedback triage, then run CI.
  - *End:* update the handover, commit, push to the private remote.
- **Tool-neutral skills:** move the procedures (phase gate, evidence, registry-add) into `docs/procedures/` as plain markdown. `.claude/skills/` just points to them.

### 2. Code available from anywhere
- **Private remote repository** (GitHub private by default; self-hosted Gitea as an option). **Needs Ray's yes**, because it's the first push.
  - The pre-push check runs first: private scan over full history, file list.
  - `legacy/`, private evidence, profiles, recordings and caches are never pushed.
- **Encrypted backup of local-only data** (profile.local.json, private evidence, labels, feedback): a nightly encrypted archive (7-Zip AES-256 or age) to my cloud drive. The key stays with me, never in the repo.

### 3. Agents and subscriptions, interchangeable

| Option | Use when |
|---|---|
| Claude Code (my subscription) | Default |
| Claude Code with an API key (pay-as-you-go) | Subscription limit reached and the work is urgent |
| Claude Code on the web (cloud sessions) | Away from the laptop; repo work that doesn't need devices |
| Other agent CLIs (OpenAI Codex CLI, Gemini CLI, OpenCode with any provider, Aider) | Any of the above unavailable; they read AGENTS.md |
| Local models (Ollama / llama.cpp coder models) | Small, low-risk tasks (docs, tests, refactors) when offline or out of quota |

**Rules:**
- **One writer at a time:**
  - Each agent works on its own branch; merges happen through pull requests with CI passing.
  - A session lock (`.agent-lock` with tool name, branch and start time) is checked at start.
- **High-stakes work stays on the strongest available model:** security reviews, the live path, the encoder graph. Lower-tier models never mark those done.
- **Check quality across tools:** whichever agent does the work, CI, the phase gate and evidence rules are the same.

### 4. Build and test environments

| Need | Where |
|---|---|
| Build + unit/integration tests + packaging | **GitHub Actions Windows runners** on the private repo, so every push produces a downloadable alpha zip without the laptop |
| GPU / encoder / device / live-stream tests | **My laptop only** (capture card, camera, mic, NVENC) |
| Remote access to the laptop | Claude desktop app linking (as now). Optional: Tailscale + SSH for other agents (needs my approval) |
| Heavier cloud Windows (optional, later) | Azure / AWS Windows VM with a GPU for soak tests. Needs approval and has a cost |

### 5. Secrets per environment
- **Stream keys and platform tokens:** on the laptop's keychain only.
- **CI:** no stream keys, ever. Uses mocks and loopback.
- **Agent API keys:** in each tool's own secret store, never in the repo.

---

## Part D: Decisions needed from Ray (defaults in bold)

1. **Control UI for Alpha 0:** **local web control page + native preview**, or minimal Qt.
2. **Packaging:** **portable zip + install script** now; Inno Setup/MSIX later.
3. **Private remote:** **GitHub private repo**, or self-hosted Gitea. Needs my explicit yes before the first push.
4. **Encrypted backups to my cloud drive:** **yes, nightly**.
5. **Backup subscriptions/APIs:** which of these do I have or want? Claude API key, OpenAI (Codex), Google (Gemini), OpenRouter, local models. **Default:** set up AGENTS.md now; add tools as I get access.
6. **Feedback hotkey:** **Ctrl+Alt+F**.

## Part E: Rules that still apply
- Privacy: no names, faces or paths in git.
- Never work around a check; tests before done.
- Security review on ports and tokens.
- Ask only for: installs, the first push, devices and live streams, real posts, spending, and privacy-affecting changes. Everything else is decided, logged and continued.
