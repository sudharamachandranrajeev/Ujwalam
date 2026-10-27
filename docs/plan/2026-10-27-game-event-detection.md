# Ujwalam — amendment: Game profiles + gameplay event detection

Save as `docs/plan/2026-10-27-game-event-detection.md`. It extends AI clipping (§4.10, core C5), P2 and P14, and adds an onboarding step to P5. Nothing else changes.

---

## 1. Idea

A vision/OCR watcher reads the game screen for **game-awarded events** that tie to the streamer's in-game name (IGN). These are strong, low-noise clip signals: the game itself is saying "this was good". They join chat, audio and hotkey signals in the clip fusion.

---

## 2. Game profile (data, not code)

The studio asks during onboarding, and the answers are editable later in settings:

| Field | Example | Notes |
|---|---|---|
| Streamer name | `<<streamer name>>` | Used for chat and titles |
| In-game name(s) | `<<IGN>>` + variants | Variants cover clan tags, special characters and common OCR misreads |
| Game | Call of Duty: Mobile | Picks the detector pack |
| Default mode | Multiplayer / Battle Royale / Auto | Auto = detect mode from the HUD |
| Capture canvas | H, V or both | Which canvas the watcher reads (clean H master preferred) |

Stored in `data/games/<game-id>/profile.json` (user values) and `data/games/<game-id>/detectors.json` (detector pack). Everything is local; IGN never leaves the machine.

---

## 3. CODM detector pack (first pack)

Each detector is a data entry:
`{id, mode, roi, method, patterns, colour, nameRequired, weight, window{preSec, postSec}, cooldownSec}`

### Multiplayer
| # | Event | What to detect | Method | Clip meaning |
|---|---|---|---|---|
| M1 | **MVP + IGN** | "MVP" text with the streamer's IGN on the same screen | OCR on the end-of-match ROI; fuzzy IGN match | Match-level boost: raises every candidate from that match; tag the match "MVP" |
| M2 | **Impact Play + IGN** | "Impact Play" text with the IGN on screen | OCR; fuzzy IGN match | Strong candidate; exact screen layout to be confirmed from footage |
| M3 | **Medals** | Medal banner text: Double Kill, Triple Kill, Fury Kill, Frenzy Kill, Merciless, Nuclear, Ultimate Terminator, Ultra Kill, Mega Kill, Super Kill | OCR on the medal ROI, exact list match; optional icon template later | Candidate; weight by medal |
| M4 | **Yellow "+" points** | Yellow "+N" score popups | Yellow colour mask → OCR `\+\d+` | Action-density signal: a burst of popups in a short window = busy fight |

### Battle Royale
| # | Event | What to detect | Method | Clip meaning |
|---|---|---|---|---|
| B1 | **Kills by IGN in the kill feed** | Kill-feed lines where the IGN is the **killer** (not the victim) | OCR on the kill-feed ROI, parse each line's killer/victim side, fuzzy IGN match | Each kill = event; several kills close together = multi-kill candidate |

### Rules for all detectors
- **The name match is required** where the event belongs to a player (M1, M2, B1). Another player's MVP or kill is not a clip.
- **Medal list and weights are data.** The 10 medals above are the starting list. Default weights are proposed from my labelled clips (see §6) and shown to me to confirm. Don't invent a ranking.
- **Backdate windows.** Medals and kills appear after the action. Defaults are proposed from the labelled data, not guessed.
- **De-duplicate.** One fight that fires several medals becomes one candidate with all events attached.
- **Every detection is logged with evidence:** frame time, ROI crop thumbnail, OCR text, match score. This is the "reasons" shown in the clip review.
- **UNVERIFIED until checked on footage:** ROI positions, banner text exactly as rendered, colours. Confirm all on real frames before trusting.

---

## 4. Performance (live)

- Read **ROIs only**, never the full frame, at a low sample rate (start at 4 fps; tune).
- Cheap gate first (colour mask / frame change in the ROI), then OCR only when the gate fires.
- Runs in the AI worker at low priority. If the encoder or compositor is under load, the watcher drops frames first.
- Live: detections become markers and replay saves. Post-stream: a full pass over the recording at higher sample rate.

---

## 5. Choosing what's worth clipping

The score for a candidate combines three layers:

1. **Event strength:** game events (this amendment) + chat, audio, voice and hotkey signals.
2. **Personal preference:** what I keep, edit, publish, accept or reject in the clip review. Learned per game.
3. **Audience preference:** what actually performs with viewers, for this game, backed by real data:
   - **Primary: my own channel.** Views, retention and engagement of my published clips, via the official YouTube Analytics API (and other platforms' official APIs where available). Linked back to each clip's events, so "Nuclear clips retain better" can be measured.
   - **Secondary: public data for the game.** Official APIs only (e.g. YouTube Data API search for the game's Shorts: titles, view counts, publish dates). Respect quotas. No scraping.
   - Each data point records source, date and sample size. Recommendations are shown only when there's enough data. Correlation is never presented as cause. I can turn this layer off.

Until layers 2 and 3 have enough data, layer 1 decides and the UI says so.

---

## 6. How to build it

| Step | Where | Done when |
|---|---|---|
| G0 | Game profile schema + detector pack schema + validator (data only) | Validator tests pass; CODM pack seeded with M1–M4, B1 marked UNVERIFIED |
| G1 | **Footage check on my clips corpus** (read-only). Sample frames from several sessions and find: medal banner, MVP/Impact Play screens, yellow "+" popups, kill feed. Report whether each is readable in the vertical composite. | Evidence file with frame crops and a readable / not-readable verdict per detector |
| G2 | Offline detectors (P2 extension): run on the 3 labelled sessions; measure precision and recall per detector against my labels | Report per detector; medal list confirmed against what actually appears |
| G3 | Fusion: add game events to the clip score; propose default weights and windows from labelled data for my approval | Beats chat-only and audio-only baselines on held-out sessions |
| G4 | Onboarding wizard + profile settings (P5) | New user can enter streamer name, IGN(s), game, mode |
| G5 | Live watcher (P14): ROI sampling, gating, markers | Live test: medals and kills by my IGN create markers; other players' events don't |
| G6 | Audience-preference layer (with the analytics phase) | Shows per-event performance only with enough data |

Other games get their own detector packs later using the same schema.

---

## 7. Needed from me
- My exact in-game name(s) for CODM, including clan tag and any variants: `<<IGN>>`
- Whether MP or BR is more common on stream (sets the default mode).
- Confirm the medal weights and windows when G3 proposes them.
