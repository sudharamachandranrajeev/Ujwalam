# Ujwalam v1 — addendum: deadline Fri 6 Nov evening, autonomous mode

Applies on top of `2026-10-29-ujwalam-v1-10-day-plan.md`. Where they conflict, this file wins.

## 1. Deadline

**v1 ready by Friday 6 Nov 2026, evening.** That's 8 working days (Thu 29 Oct → Fri 6 Nov), so the 10-day plan is compressed:

| Day | Date | Change |
|---|---|---|
| 1–4 | 29 Oct – 1 Nov | As planned |
| 5 | 2 Nov | Streamable milestone (unchanged) |
| 6 | 3 Nov | Clipper + review screen (days 6 and 7 work merged) |
| 7 | 4 Nov | Posting: YouTube + TikTok draft; 3 variants + captions |
| 8 | 5 Nov | Full loop + 2 h soak (day 9 work moved here) |
| 9 | 6 Nov | Packaging, fixes, final acceptance by evening |

Cut order if behind is unchanged:
1. TikTok drafts (→ export-only).
2. Auto-post rules (review-first only).
3. Game detectors (chat/audio/hotkey markers only).

## 2. Work continuously

- **Keep going without waiting for me.** Don't stop at the end of a step to ask "shall I continue?". Move to the next v1 item.
- **Never sit idle.** If an item is blocked on me, record it in the end-list (§3) and continue with the next unblocked item. Use stubs or fakes behind a clear `BLOCKED-ON-RAY` flag where needed, so dependent work can proceed. Stubs are never reported as done.
- **Decide yourself** on anything within v1 scope, using the recommended default. Record each decision in `docs/plan/2026-10-29-v1-decisions.md` (one line each: decision, reason, how to undo).
- **Parallel agents** as planned; the main session integrates and runs CI continuously.
- **Local checkpoint commits** happen automatically after CI passes (end of each work block). They're local only, never pushed. Message: `wip(v1-dN): <summary>`.
- **No deletions.** Move anything to remove into `_to_delete/` and list it in the end-list.

## 3. Permissions: defer to one end-list

Keep a single file, `docs/plan/2026-10-29-v1-end-list.md`, updated continuously. Each item has what, why, risk, your recommendation, and a one-word answer slot. I'll go through it at set checkpoints, not as you go.

**Defer to the end-list (don't ask now):**
- deletions (files moved to `_to_delete/`)
- pushing to any remote
- baseline/budget acceptance
- squash or tidy of the wip commits
- licence and notice reviews
- anything cosmetic or reversible

**Ask immediately (absolutely necessary only), batched in one message at most twice a day:**
1. **Installs and new dependencies** (e.g. Whisper model, Google API client, OAuth libs). Collect everything v1 needs into **one install list today**, so I approve once.
2. **Account setup only I can do:** Google Cloud OAuth client (YouTube), TikTok developer app. Give exact steps and ask early (day 1–2), because approvals can take days.
3. **Devices and live streams:** before any real stream or device session, ask me to say "devices ready".
4. **Posting to a real platform:** the first real upload (private) needs my yes; after that, test posts stay private and need no further asks.
5. **Spending money** (none expected).
6. **Security or privacy changes:** anything that would send personal data off the machine, change token storage, or open a port beyond 127.0.0.1.

Everything else: decide, log, continue.

## 4. Checkpoints with me

- **Twice daily, at most:** one short message with progress, the immediate asks (if any), and today's test card.
- **Test cards continue** (`docs/tests/`), ≤ 20 min. If I haven't done a test card, don't block; carry the untested item forward, mark it "awaiting Ray test", and keep building.
- **Final acceptance Fri 6 Nov:** the end-list review plus the final test (T-final: install from the zip, go live, clip and post one Short privately).

## 5. Keeping the session running

- Laptop on AC, sleep disabled, while building (my side).
- If a usage limit pauses the session, resume where it stopped: state is in the plan, end-list and decisions files, so a fresh session can pick up.
- On resume, read the inbox, the decisions file, the end-list and the latest test card first.
- If Claude Code's own tool permission prompts are what's stopping progress, list the commands it keeps asking for and propose a project-level allowlist (safe commands only: npm/node/python scripts, git without push, ffmpeg/ffprobe, read-only system queries). I'll approve it once.

## 6. Unchanged

All privacy rules, "never work around a check", tests-before-done and the security review on tokens/ports still apply. Speed never skips a check.
