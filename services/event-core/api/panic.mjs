// SPDX-License-Identifier: GPL-3.0-or-later
// In-process panic entry point (review E8-03 follow-up, user decision 2026-10-29). Node stdlib only.
//
// panicNow() engages panic through the action gate with source 'system'. It does no I/O and never awaits, so no
// connection flood, full accept queue or slow disk can delay it: the only thing it needs is the event-core process
// itself. The system pipe (pipe.mjs) and any other in-process caller use this same gate handle; actions.panic over
// HTTP reaches the same gate.panic().
//
// Call contract for the host / supervisor (Agent C; the host code itself is not part of this module):
//   1. The in-app panic hotkey acts in the host process FIRST, without any IPC: whatever the host owns (effect layers,
//      overlays, outputs per the host's own panic rules) is handled there. That step can never be blocked by event-core.
//   2. Then the host tells event-core, so chat- and rule-driven actions stop too: it sends actions.panic over the
//      system pipe named in <dataDir>/system.json (or passed by the launcher), with the system token, using
//      panicViaPipe() semantics: one JSON line {"auth":"<system token>"}, then
//      {"jsonrpc":"2.0","id":<n>,"method":"actions.panic","params":{"reason":"hotkey"}}; reason matches
//      /^[\w .:,-]{0,200}$/. Retry at most 5 times (50, 100, 200, 400 ms apart) and only on ECONNREFUSED or ECONNRESET.
//   3. Panic is idempotent: a repeat answers {"ok":true,"reason":"already-panic"}, so a retry after a lost reply is
//      safe. Clearing panic is NOT available on the pipe; it stays a confirmed action (actions.request panic.clear).
//   4. Success = result.ok === true. {"ok":false,"reason":"internal-error"} means the gate failed while engaging; the
//      host keeps its own in-process panic state regardless.
//   5. Do not use the HTTP API as the only panic path: under a local connect flood a single TCP connect can be refused.

const REASON_RE = /^[\w .:,-]{0,200}$/;

/** Engages panic now. Returns { ok, reason } exactly as the gate does ('panic-engaged' | 'already-panic' | refusals). */
export function panicNow(core, { reason = 'hotkey' } = {}) {
  if (!core?.actions) return { ok: false, reason: 'actions-unavailable' };
  const r = typeof reason === 'string' && REASON_RE.test(reason) ? reason : 'hotkey';
  return core.actions.forSource('system').panic({ reason: r });
}
