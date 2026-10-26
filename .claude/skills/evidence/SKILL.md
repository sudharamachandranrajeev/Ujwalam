---
name: evidence
description: Write a test or runtime evidence file for Ujwalam under docs/evidence/. Use whenever a feature or phase item is claimed done.
---

# Evidence files

Path: `docs/evidence/YYYY-MM-DD-<phase>-<topic>.md`, for example `2026-10-26-p0-registry-validate.md`.

Required content:

1. Title and date (YYYY-MM-DD) and the result: PASS, FAIL or BLOCKED.
2. The exact commands, in code blocks.
3. The real output (trimmed only if long; keep the decisive lines and counts).
4. What was and was not checked. Mark unverified items UNVERIFIED.
5. For ★ presets: the legacy capture and the Ujwalam capture side by side, with the compared values.

Rules: a mock is not a feature. Never paste engage logs or viewer memory. Never include secrets or tokens.
