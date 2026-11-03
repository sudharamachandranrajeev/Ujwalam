# Ujwalam — Claude Code

All project rules live in `AGENTS.md` (single source for every agent and tool). Edit rules there, not here.

@AGENTS.md

## Model routing (Claude Code)

Decisions and review: main session. Coding through subagents:

- **Opus, high effort:** libobs, render/encode, GPU/threading, AI clipping, core-function/preset engine, crash/perf debugging. Phases P1, P2, O1–O3, P11, P14, P17, plus P4 NativeAdapter, P7 engine/SDK, P8 STT, P13 ONNX classifier, P15 plugin manager.
- **Sonnet, medium effort:** UI, preset ports, themes, chat, importers, tests, docs. Phases P0, O0, P3 (Opus reviews live-lock), P5, P9, P10, P12, P16, plus P4 importers, P7 preset ports, P8 rules, P13 engage port, P15 obs-websocket.
- **Sonnet, low effort:** mechanical edits, renames, boilerplate.
- A Sonnet task moves to Opus after one failed attempt or when it touches native or pipeline code.

## Claude Code specifics

- Skills in `.claude/skills/` are pointers to `docs/procedures/`; the procedure files are the source.
- Claude Code on the web (cloud sessions) suits repo work that needs no devices; device, GPU and live tests run on the laptop only.
