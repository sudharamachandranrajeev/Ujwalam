# Procedure: session protocol (any agent, any tool)

Project state lives in the repo, not in any one tool. Any agent (Claude Code, Codex CLI, Gemini CLI, OpenCode, Cursor, Aider, local models) follows the same steps, so work can move between tools without loss.

## Start

1. `node tools/agent-lock.mjs status`. If another tool holds the lock, stop and tell the user (one writer at a time). A stale lock (holder known to be gone) is cleared only with the user's yes: `node tools/agent-lock.mjs acquire --tool <name> --force`.
2. `node tools/agent-lock.mjs acquire --tool <name>` (writes `.agent-lock`: tool, branch, start time, host; gitignored).
3. Read, in order: `AGENTS.md`; the newest `docs/plan/*-handover.md`; `docs/plan/INDEX.md`; the newest `docs/feedback/*-triage.md`; `docs/inbox/` (summarise each file, ask before applying).
4. Triage new `feedback/` items (`docs/procedures/feedback-triage.md`).
5. `npm run ci`. A red CI is the first task.

## While working

- Work on your own branch: `<tool>/<topic>` (for example `claude/alpha0-d1`, `codex/feedback-form`). Merge to `master` only with CI passing; once the private remote exists, merges go through pull requests.
- Decisions go into the current decisions file (`docs/plan/2026-10-29-v1-decisions.md` during v1), one line each: decision, reason, how to undo.
- Items that need the user go to the end-list (`docs/plan/2026-10-29-v1-end-list.md`), except the immediate asks listed in `AGENTS.md`.
- High-stakes work (security review, live path, encoder graph) stays on the strongest available model; a lower-tier model never marks it done.

## End

1. Update the handover (`docs/plan/YYYY-MM-DD-handover.md`, new file per day): where we are, done with evidence, in progress, next tasks, open questions, blocked-on-user, known failures, resume commands.
2. `npm run ci`; commit when it passes (hooks run; never `--no-verify`).
3. Push to the private remote (only after the first push has been approved).
4. `node tools/agent-lock.mjs release --tool <name>`.

## Agents and subscriptions

| Option | Use when |
|---|---|
| Claude Code (subscription) | Default |
| Claude Code with an API key | Subscription limit reached and the work is urgent |
| Claude Code on the web | Away from the laptop; repo work that needs no devices |
| Codex CLI, Gemini CLI, OpenCode, Aider | Any of the above unavailable; they read `AGENTS.md` |
| Local models (Ollama / llama.cpp coder models) | Small, low-risk tasks (docs, tests, refactors) when offline or out of quota |

Device, GPU, encoder and live-stream tests run on the laptop only. CI never holds stream keys.
