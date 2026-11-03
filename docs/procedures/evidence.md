# Procedure: evidence files

Use whenever a feature or phase item is claimed done. Tool-neutral; `.claude/skills/evidence` points here.

Path: `docs/evidence/YYYY-MM-DD-<phase>-<topic>.md`, for example `2026-10-26-p0-registry-validate.md`.

Required content:

1. Title and date (YYYY-MM-DD) and the result: PASS, FAIL or BLOCKED.
2. The exact commands, in code blocks.
3. The real output (trimmed only if long; keep the decisive lines and counts).
4. What was and was not checked. Mark unverified items UNVERIFIED.
5. For ★ presets: the legacy capture and the Ujwalam capture side by side, with the compared values.
6. For live features (Alpha onwards): which real stream it was used on (date, placeholder channel name) and the feedback items it produced. Without a real stream it is "awaiting live test", not done.

Rules: a mock is not a feature. Never paste engage logs or viewer memory. Never include secrets or tokens. Images showing faces, names or ids go in `docs/evidence/private/` (gitignored) or are cropped or blurred.
