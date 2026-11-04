# Ujwalam — Claude Code

All project rules live in `AGENTS.md` (single source for every agent and tool). Edit rules there, not here.

@AGENTS.md

## Model routing (Claude Code + Codex + local, D207/D208)

Decisions and review: main session. Coding through subagents, every cloud model at **medium effort**
(no high-effort tier; precision comes from task routing and cross-model review, not from spending more
effort on one model):

- **Opus, medium effort:** libobs, render/encode, GPU/threading, AI clipping, core-function/preset engine, crash/perf debugging, security review, the live path, the encoder graph. Phases P1, P2, O1–O3, P11, P14, P17, plus P4 NativeAdapter, P7 engine/SDK, P8 STT, P13 ONNX classifier, P15 plugin manager. Also: final sign-off on anything Codex builds in these phases.
- **Codex (OpenAI CLI), medium effort:** (1) an independent phase built in parallel on its own branch/worktree when two phases can proceed independently and throughput matters; (2) mandatory second-opinion review of Opus-gated high-stakes phases before they are marked done — two different model families agreeing catches blind spots a single family shares, which is the point, not a shortcut.
- **Sonnet, medium effort:** UI, preset ports, themes, chat, importers, tests, docs. Phases P0, O0, P3 (Opus reviews live-lock), P5, P9, P10, P12, P16, plus P4 importers, P7 preset ports, P8 rules, P13 engage port, P15 obs-websocket. Also reviews/merges Haiku's and the local model's output.
- **Haiku:** mechanical-only — CI log triage, evidence-doc scaffolding, boilerplate data entry (preset manifests, labels, changelog lines), mechanical lint-fix passes. Always has an objective check attached (tests/schema/exact diff); never self-certifying, never marks a phase done.
- **Local (Qwen2.5-Coder, via LM Studio/Bionic), zero-cost:** the same mechanical category as Haiku, used for high-volume/offline work where no API cost should be spent (bulk preset/label drafts). Same rule: never self-certifying, always reviewed up a tier, always CI-gated. Never load it while MeldStudio or a live/test stream is running — 6 GB VRAM has no slack for both (see D1).
- A Sonnet task moves to Opus after one failed attempt or when it touches native or pipeline code.
- No task moves to Haiku/local to save tokens — only when it is mechanical and cheaply/automatically verifiable. A wrong cheap answer that needs a redo costs more net than doing it right once.

## Claude Code specifics

- Skills in `.claude/skills/` are pointers to `docs/procedures/`; the procedure files are the source.
- Claude Code on the web (cloud sessions) suits repo work that needs no devices; device, GPU and live tests run on the laptop only.
