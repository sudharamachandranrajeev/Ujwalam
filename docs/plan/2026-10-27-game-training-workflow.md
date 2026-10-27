# Ujwalam — add-on: Game Training Workflow (repeatable for any game)

Approved 2026-10-27. Extends `2026-10-27-game-event-detection.md` (G0–G6); newest wins where they differ.

**Already covered elsewhere (not duplicated):** T0 → G0/G4; pack basics → G0 (pack 0.2.1); T2 crash-safe capture → `tools/capture/record.py`; T3 → P2a A2/A2b/A5; T5 → A6; T7 → G2 + `2026-10-27-p2-clip-baselines.md`; T8 → G3; T9 → G5.
**New here:** T1 capture plan + coverage, T4 discovery, T10 feedback loop, pack file split, generic detector types, CLI, W0–W5, §9 sharing.

**Decisions (user, 2026-10-27):**
- The streamer profile stays global in `data/profile.local.json` (gitignored). Per-game private data moves to `data/games/<id>/local/` (gitignored) at W0.
- Labels stay committed in `data/labels/` with timestamps and placeholder names only, no real names and no images. The pre-commit hook enforces this.
- Placement: W0–W1 at P2b start (after the P2a gate commit), W2–W3 in P2b, W4 with P14, W5 after P14. Ask the user for second-game footage at W5.

---

## 1. Purpose

Turn what we did manually for CODM into a built-in feature: **"Train a game"**. Any streamer, for any game, runs the same guided steps: capture, discover events, label, build detectors, evaluate, deploy, improve. The result is a versioned detector pack for that game.

CODM becomes the first pack built with this workflow, and its test case. Nothing about CODM is hardcoded in the engine.

---

## 2. Principles

- **Engine generic, games as data.** Detector types are engine code; everything game-specific is data: screens, screen positions (fractions of the game frame), text patterns, colours, weights, windows, end-of-match logic, modes.
- **Reads the clean game source**, never the composited program, so scene layouts don't matter. For old composited footage, find where the game sits in the frame first.
- **The streamer confirms, the system proposes.** Nothing is invented: event names, weights and windows come from footage and labels, and the streamer approves them.
- **Every number has evidence:** frames, crops, counts, date and pack version.
- **Private by default.** Footage, crops, other players' names and the streamer's identity stay local and gitignored. Packs can be exported without personal data (§9).
- **Local only:** no paid APIs, no cloud training.

---

## 3. Workflow (the feature)

| Step | What happens | Streamer does | Output |
|---|---|---|---|
| T0 **Profile** | Game, modes, streamer name, IGN(s) and variants, language and script of names, capture source | Fills a form | `profile.local.json` (gitignored) |
| T1 **Capture plan** | System generates a capture checklist per mode: required screens, events and outcomes (win/lose, end screens), duration targets | Reads checklist | `capture-plan.json` |
| T2 **Capture** | Records the clean game source, crash-safe (segmented or fragmented, finalised-file check), with live coverage tracking against the checklist | Plays; says start/stop | Recordings + coverage report ("still missing: X") |
| T3 **Import existing footage** *(optional)* | Indexes old clips/VODs: session rebuild, boundary check, locate the game in composited frames, mode tagging | Points to folders | Footage index |
| T4 **Discover** | Finds candidate events without labels: recurring banners and text (OCR clustering), colour popups, HUD regions, kill-feed area, end-of-match screen types. Groups similar crops. | Names and accepts or rejects each group | Event catalogue: positive, reference-only, ignore |
| T5 **Label** | Labelling page: scrub footage, mark highlights, confirm detections, mark false positives | Labels sessions | `labels/*.json` |
| T6 **Build pack** | Generates detector entries from accepted events: screen position, method, patterns, name rules, gating, cooldown | Reviews | `detectors.json` vN (draft) |
| T7 **Evaluate** | Per-detector precision/recall on held-out sessions (split by session); fusion vs baselines (random, audio-only, chat-only with coverage); timing error; layout-independence test | Reviews report | Evaluation report |
| T8 **Tune & approve** | Proposes weights, windows and thresholds from labels | Approves or edits | `detectors.json` vN (approved) |
| T9 **Deploy** | Pack used by the live watcher and the post-stream clipper | — | Active pack |
| T10 **Improve** | Live feedback (hotkey, accepted/rejected suggestions, kept/published clips) adds labels; periodic re-evaluation; propose a new pack version when it beats the current one | Approves updates | vN+1 with changelog |

The streamer can stop at any step and resume later. Each step shows what's done, what's missing and what's next.

---

## 4. Game pack format

```
data/games/<game-id>/
  game.json              id, name, modes[], endOfMatch logic, languages/scripts
  detectors.json         versioned; entries below
  capture-plan.json      required screens/events/outcomes per mode
  events.json            catalogue: positive | reference | ignore, with weights
  screens.json           screen types (gameplay, lobby, profile, end screens...) for gating
  CHANGELOG.md
  local/                 (gitignored) profile, labels, crops, evaluations, reference datasets
```

Detector entry:
`{id, mode, screen, roi (fractions), method, patterns, colour, nameRequired, nameSide (killer|victim|card), minTextHeight, gate, weight, window{pre,post}, cooldownSec, status (unverified|verified), evidence[]}`

### Generic detector types (engine)
- **Banner text:** medals and awards (OCR + list match).
- **Name-on-screen:** MVP, Impact Play, killcam killer (OCR + fuzzy IGN, position-aware).
- **Feed line parser:** kill feeds (killer/victim sides, icons such as knock vs kill).
- **Colour popup:** "+N" style (colour mask + OCR pattern).
- **Screen classifier:** gameplay vs lobby vs profile vs end screens. It gates other detectors so menus don't fire.
- **End-of-match selector:** which end screen appeared, then the name check.
- **Audio cue** *(later)*: game sounds.
- **Template/icon match** *(later)*: medal icons, kill icons.

New games should only need data; a new detector type is an engine change and needs its own amendment.

---

## 5. Lessons from CODM, built in as defaults

- Read the clean source; fractional screen positions; layout-independence test.
- Minimum text height and screen gating to avoid self-name false positives (e.g. squad list).
- Mutually exclusive end screens: detect which appeared, then check the name.
- Multiple scripts in names (Latin, Cyrillic, etc.). Report per-script OCR accuracy, and plan another OCR model where needed.
- Reference-only events: logged as a dataset, weight 0, can be promoted later.
- Mode tagging, so excluded modes (e.g. DMZ) don't pollute tuning.
- Crash-safe recording, verified before any capture session.
- Chat coverage reported; missing chat = unavailable, not zero.

---

## 6. UI

- **Games** page: list of packs, version, status, evaluation summary.
- **Train a game** wizard: T0–T10 with a progress checklist.
- **Capture coverage** panel during T2: required items ticked off live.
- **Discovery review:** grid of grouped crops; name / positive / reference / ignore.
- **Labelling page** (the same tool as P2).
- **Evaluation report** per pack version, with side-by-side comparison against the previous version.

---

## 7. Commands (CLI parity for testing)

```
ujwalam game new <id>
ujwalam game capture-plan <id>
ujwalam game import <id> <folder>
ujwalam game discover <id>
ujwalam game build <id>
ujwalam game eval <id> [--against vN]
ujwalam game approve <id> vN
```

---

## 8. Build steps

| # | Goal | Done when |
|---|---|---|
| W0 | Pack schemas (game, detectors, events, screens, capture plan) + validator; migrate the CODM pack into it | CODM pack validates; existing CODM results reproduce |
| W1 | Capture plan + coverage tracker + crash-safe capture | A capture session reports live coverage; killing the recorder loses ≤ 1 segment |
| W2 | Discovery (OCR clustering, colour popups, screen types) + review UI | Run on CODM footage rediscovers the known events without being told |
| W3 | Pack builder + evaluation report + versioning and changelog | CODM v-next built and evaluated end to end through the workflow |
| W4 | Feedback loop + "propose new version" | A new version is proposed only when it beats the current one on held-out sessions |
| W5 | **Second-game proof:** run the full workflow on a different game, with no engine code changes | A working pack for game #2 built with data only |

Order: W0 can start once the current CODM detector work is committed. W5 needs footage from another game; ask me at that step, and say what's needed and how much.

---

## 9. Sharing packs (later, optional)

- Export a pack without personal data: no IGN, no crops with names or faces, no labels tied to my footage. Screen positions, patterns and screen types only.
- Import someone else's pack, then re-evaluate it on my own footage before trusting it.
- The pre-commit / pre-push name checks run on every export.

---

## 10. CLAUDE.md additions

```
- Game-specific logic is data in data/games/<id>/; never hardcode a game in engine code.
- Every detector value needs evidence (frames, counts, date) and a status (unverified|verified).
- Event names, weights and windows are proposed from footage and labels and approved by me; never invented.
- Pack changes are versioned with a changelog; a new version ships only if it beats the current one on held-out sessions.
- Training footage, crops, labels and profiles stay in local/ (gitignored).
- Ask me for training data at the start of a step that needs it: what, how much, why.
```
