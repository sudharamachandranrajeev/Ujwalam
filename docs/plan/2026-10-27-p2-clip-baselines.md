# Ujwalam — amendment: P2 clip baselines

Approved by the user on 2026-10-27. It changes the P2 "Done when" in `docs/2026-10-26-build-plan.md` §11 (line 258). Nothing else changes.

## Why

The P2 gate says the clipper must beat a chat-only baseline. A3 (`docs/evidence/2026-10-27-p2a-a3-chat-alignment.md`) measured chat at 0.19 viewer messages/min at most per session, and 176 viewer messages across about 49 h of clips. A chat-only ranker scores almost every moment as zero, so it performs close to random. Beating it alone proves little.

## Change

P2 "Done when" becomes:

- Runs on 3 real CODM sessions (labelled), evaluated on ≥ 2 held-out sessions that were never used for tuning.
- Beats each baseline on the held-out sessions, using the same ranking metric and the user's labels:
  1. **Chat-only:** chat velocity against the session baseline (as in §4.10). Kept as stated; expected to be near trivial with current chat volume.
  2. **Audio-loudness-only:** ranks windows by short-term loudness peaks (shouting, hype) from the cached 16 kHz audio. This is the real bar.
  3. **Random:** seeded, for reference.
- The evidence reports each baseline's score next to the clipper's, per held-out session.

Where no saved stream video covers part of a session, chat is "unavailable" there, not zero, for both the clipper and the chat-only baseline.
