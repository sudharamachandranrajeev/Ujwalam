# Procedure: live-feedback triage

Live feedback outranks everything else on the plan (`docs/plan/2026-11-01-ujwalam-alpha-live-testing-and-continuity.md`, Part B).

## Where feedback comes from

- `feedback/<YYYY-MM-DD>/<HHMMSS>/` (local, gitignored), one folder per feedback-hotkey press (`Ctrl+Alt+F`): `moment.json` (timestamp, scene, CPU/GPU, dropped frames, version), `log.txt` (last 200 log lines), replay clips (last 30 s, H and V) and an optional voice note.
- Post-stream form on the control page: adds text, a tag (`bug` | `annoying` | `wish` | `works-well`) and a severity (`high` | `medium` | `low`) to each moment.
- Direct messages from the user.

## Steps (start of every session)

1. List `feedback/` folders newer than the last triage file in `docs/feedback/`.
2. For each new item write one line in `docs/feedback/YYYY-MM-DD-triage.md`:
   `| id (date/time) | tag | severity | what happened | cause guess (UNVERIFIED unless proven) | fix | size S/M/L | status |`
3. Never copy chat text, viewer names, faces, stream keys or paths with the user name into the triage file. Describe; don't paste. Use placeholders for channel and player names.
4. Order the work:
   1. Anything that broke or risked a live stream.
   2. The user's bug reports.
   3. Annoyances.
   4. Wishes.
   5. Planned features.
5. Ship at least one alpha build per day with fixes (`0.1.0-alpha.N`, changelog line per fix).
6. A fix is done when it has a test or runtime evidence, and it is closed only after the next real stream shows no repeat.

## Feature flags

Every new feature ships behind a flag, off by default, switchable from the control page while live with no rebuild. A feature is "done" only after it is used on at least one real stream with no high-severity feedback.
