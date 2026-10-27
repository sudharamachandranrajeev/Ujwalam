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

## Decisions (2026-10-27, after the live reference capture)

Evidence: `docs/evidence/2026-10-27-g1-live-reference.md`.

- IGN and 3 variants: provided by the user. Kept out of git. They live in the gitignored `data/profile.local.json` (`games.codm`), with the brand and channel names; the committed pack and tests use placeholders (template `data/profile.example.json`).
- Medal list, extended: the 10 above plus Revenge, Bloodthirsty, Saboteur, Berserker, Keep It Fresh (spelling UNVERIFIED). "Normal Kill" and First Blood are not added.
- New detector: multi-kill / killstreak card ("4X MULTI-KILL", "On a 5 killstreak"). Name match required, because it also shows for other players.
- Impact Play is a post-match replay. While it is on screen, medal detections are suppressed so they don't count twice. The replay marks the match's best sequence, which is matched back to the live timeline.
- MP also has a kill feed; B1-style parsing can apply in MP.
- ROIs are relative to the detected game area (pillarboxed, about 1.45:1 on the current phone), not to the canvas.

## Open

- Whether MP or BR is more common on stream (sets the default mode).
- BR reference capture: the user says when ready.
