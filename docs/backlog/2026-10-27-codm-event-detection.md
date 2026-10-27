# 2026-10-27 — Backlog: CODM game-event detection

Status: backlog. Raise at P2. This note does not change the build plan. The full design is the amendment `docs/plan/2026-10-27-game-event-detection.md`.

User's note (verbatim):

Idea: a vision/OCR watcher reads game-awarded events as clip signals,
alongside chat, audio and hotkey.
- Game profile asked at onboarding: streamer name, in-game name(s) +
  variants, game, mode (MP/BR/auto). Stored as data per game. My CODM IGN:
  <<IGN + clan tag/variants>>.
- CODM multiplayer:
  - "MVP" + my IGN on screen (match-level boost);
  - "Impact Play" + my IGN;
  - medals: Double Kill, Triple Kill, Fury Kill, Frenzy Kill, Merciless,
    Nuclear, Ultimate Terminator, Ultra Kill, Mega Kill, Super Kill;
  - yellow "+N" point popups (bursts = busy fight).
- CODM BR: kill-feed lines where my IGN is the killer, not the victim.
- Rules:
  - My name must match for MVP, Impact Play and kill feed.
  - Read small screen regions only, at low priority while live.
  - Log each detection with a crop and the OCR text as the reason.
  - Screen positions, text and colours are UNVERIFIED until checked on
    footage.
- Later: rank what's worth clipping by what I keep or reject, and by how
  clips perform with viewers (my channel's analytics first, public data
  via official APIs second; only with enough data).
- First step at P2: check on my clips corpus (read-only) which of these
  screens are readable in the vertical recordings. Report per detector
  with crops; keep crops with faces or other players' names out of git.

## Open

- CODM IGN, clan tag and variants: still the placeholder `<<IGN + clan tag/variants>>`.
- Whether MP or BR is more common on stream (sets the default mode).
