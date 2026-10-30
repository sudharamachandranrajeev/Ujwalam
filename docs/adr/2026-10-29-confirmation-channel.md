# 2026-10-29 — Confirmation channel: separate "may request" from "may confirm"

Status: proposed
Phase: P3 (found at the E8 security review); to be decided before P4 and built in P4/P5

## Context

- The live-lock gate asks for a confirmation ("yes", or "yes, on air" while live; two steps for some actions) before
  a studio write or a destructive action. Source: `services/event-core/livelock/gate.mjs`, `CONFIRM_SOURCES = ['ui','api']`.
- `actions.request` returns `confirmId`, `phrase` and `actionHash` to the requester
  (`services/event-core/api/methods.mjs`, `outcome()`), and `actions.confirm` is open to the `api` role.
- So one holder of the api token can request an action and confirm it itself. Review finding E8-02
  (`docs/evidence/2026-10-29-p3-e8-security-review.md`) showed this with probe A12/A13:
  - an `audit.purge {all:true}` request, confirmed by the same token, purged all stored raw chat (5 invented lines);
  - while live, both confirm steps of `scene.switch` were passed by the same api token.
- The api token is written to `<dataDir>/api.json`, which only the current user can read (ACL, see E8-06). Any process
  running as that user can read it: a stray tool, a future plugin, an AI helper.
- In P3 the only real effect is the raw-chat purge. P4 and P6 add studio handlers, and P15 adds the LAN remote, so
  the gap grows with each phase.
- The confirmation proves only that the client can echo the response. It does not prove that a human said "yes".

## Options

1. **Keep as is and document it.** Cost: none. Risk: any api-token holder has full authority, including destructive
   purges and on-air writes. This is acceptable only while the UI is the only api client.
2. **A separate confirm credential held by the human-facing surface.** The Qt app gets a `confirm` token (or role)
   from the supervisor in memory, never written to `api.json`. `actions.confirm` accepts only that role. The
   `actions.request` response to an `api` client carries `confirmId` and a status only, never the phrase or
   `actionHash`. The UI shows the phrase and the action summary to the user and sends the confirmation itself.
   Cost: small (a third token, a role check, a response change, UI work in P5). Risk: the token is still in the Qt
   process memory, so code running inside that process can confirm. That is the same trust as the UI itself.
3. **An out-of-band human prompt per confirmation.** A modal in the Qt app (or a TTY prompt for CLI use) that the
   event core triggers and waits for. The confirm call is not on the API at all. Cost: more work: an app-side prompt
   channel, a timeout and cancel path, and a headless story for CLI and tests. Risk: low, but it needs the P5 app shell.
4. **Different-credential rule only.** Record the confirmer identity and refuse when the requester and the confirmer
   are the same credential, for destructive and on-air classes. Cost: small. Risk: on its own it does not stop a
   client that holds two tokens, and `api.json` today holds both the api and system tokens.

## Decision

Proposed, not accepted: **option 2, with the rule from option 4 added.**

- A confirm credential that only the human-facing UI holds. It is passed by the supervisor in memory and never
  written to `api.json` or any file or log.
- `actions.confirm` accepts only the confirm role. The `api` role keeps `actions.request` and gets back `confirmId`
  and a status, not the phrase or `actionHash`.
- For destructive and on-air classes, the confirmer must not be the same credential as the requester. Both are
  recorded in the audit.
- Option 3 (a modal prompt) stays open for the LAN remote in P15, where the remote is itself a requester.

Timing: decide before P4 starts (P4 adds the first studio handlers). Build the server side in P4 and the UI side in
P5 (the UI is where the phrase is shown).

## Interim statement (until this ADR is accepted and built)

**The api token has full authority**, including destructive actions (raw-chat purge) and on-air confirmations. A
confirmation passed with the api token proves only that the client could echo the response, not that a human
approved. Do not give the api token, or read access to `api.json`, to anything except the UI.

## Consequences

- P4: add the confirm role and the response change. Update the gate tests: an api-token self-confirm is refused for
  destructive and on-air classes. Re-run the E8 probes A12 and A13, which must then fail.
- P5: the UI shows the phrase and summary and sends the confirmation with the confirm credential.
- P15: the LAN remote is a requester. Its confirmations go through the UI channel or an explicit remote-pairing
  decision (new ADR).
- E8-14 (a token holder can use up the SSE slots) falls under the same trust statement until then.
- Re-check: `api.json` contents (no confirm token ever), the audit fields for requester and confirmer, and the
  catalogue text "Needs a confirmation from ui or api".
