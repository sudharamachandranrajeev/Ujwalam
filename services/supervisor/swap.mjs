// SPDX-License-Identifier: GPL-3.0-or-later
// Service swap state machine (LU3, D337). Node stdlib only.
//
// The supervisor (services/studio-ui/launch.mjs) replaces a running service with a new version while live. Two modes:
//
//   side-by-side (event core, studio-ui server): the new version starts NEXT TO the old one, is health-checked, the API
//     is moved over (services/supervisor/front.mjs keeps the port and holds requests while it moves), then the old one
//     stops. A failed start or check stops the new one and keeps the old one untouched ("kept-old").
//   stop-start (clip/AI workers): two copies cannot run at once (both would save the same clips; one face link per
//     host; VRAM), so the old one stops, the new one starts and must stay healthy; if it does not, the old version is
//     started again ("restored-old").
//
// transition(state, event) is pure (the table below); runSwap() drives it with the caller's step functions and a
// timeout per step, and returns { result, history }. A step that throws or times out is the failure event of that step.
// Cancellation (Codex review P1): each step gets { signal }. A step that times out is aborted and the runner WAITS until
// it has settled before the next step (a rollback or restore) runs, so a late hand-over can never activate a core or
// move the front after the old one was restored. Steps check signal.aborted before each change they make. A hand-over
// that has not settled graceMs after the abort ends the swap as 'failed' with nothing rolled back (the caller treats it
// like a crash of that service): restoring next to a hand-over that may still act would be worse.
//
// Results: swapped | kept-old (the old one never stopped serving) | restored-old (the old version was started again
// after the new one failed past the point of no return) | failed (nothing could be restored; the caller treats it
// like a crash of that service).
//
// The host is never swapped (LU5: it owns the encoders); refuseReason() says why a swap is not allowed.

export const MODES = Object.freeze(['side-by-side', 'stop-start']);
export const RESULTS = Object.freeze(['swapped', 'kept-old', 'restored-old', 'failed']);

// state -> event -> [next state, action | null, result | null]
const T = {
  idle: {
    'begin-side': ['starting', 'spawn-new'],
    'begin-stop': ['stopping-first', 'stop-old'],
  },
  // side-by-side
  starting: { started: ['checking', 'check-new'], 'start-failed': ['rolling-back', 'stop-new'] },
  checking: { healthy: ['handing-over', 'hand-over'], unhealthy: ['rolling-back', 'stop-new'] },
  'handing-over': { 'handed-over': ['stopping-old', 'stop-old'], 'handover-refused': ['rolling-back', 'stop-new'], 'handover-failed': ['restoring', 'restore-old'] },
  'stopping-old': { 'old-stopped': ['idle', null, 'swapped'], 'old-stop-failed': ['idle', null, 'swapped'] },
  'rolling-back': { 'new-stopped': ['idle', null, 'kept-old'], 'new-stop-failed': ['idle', null, 'kept-old'] },
  // stop-start
  'stopping-first': { 'old-stopped': ['starting-after', 'spawn-new'], 'old-stop-failed': ['idle', null, 'kept-old'] },
  'starting-after': { started: ['checking-after', 'check-new'], 'start-failed': ['restoring', 'restore-old'] },
  'checking-after': { healthy: ['idle', null, 'swapped'], unhealthy: ['restoring-stop', 'stop-new'] },
  'restoring-stop': { 'new-stopped': ['restoring', 'restore-old'], 'new-stop-failed': ['restoring', 'restore-old'] },
  // both
  restoring: { restored: ['idle', null, 'restored-old'], 'restore-failed': ['idle', null, 'failed'] },
};

export const STATES = Object.freeze(Object.keys(T));

/** Pure: { state, action, result } after event, or throws on an event the state does not accept. */
export function transition(state, event) {
  const row = T[state];
  if (!row || !Object.hasOwn(row, event)) throw new Error(`swap: event ${event} not allowed in state ${state}`);
  const [next, action = null, result = null] = row[event];
  return { state: next, action, result };
}

// action -> [success event, failure event]
const OUTCOME = {
  'spawn-new': ['started', 'start-failed'],
  'check-new': ['healthy', 'unhealthy'],
  'hand-over': ['handed-over', 'handover-failed'],
  'stop-old': ['old-stopped', 'old-stop-failed'],
  'stop-new': ['new-stopped', 'new-stop-failed'],
  'restore-old': ['restored', 'restore-failed'],
};
const STEP = { 'spawn-new': 'spawnNew', 'check-new': 'check', 'hand-over': 'handover', 'stop-old': 'stopOld', 'stop-new': 'stopNew', 'restore-old': 'restoreOld' };

export const DEFAULT_TIMEOUTS = Object.freeze({ spawnNew: 20_000, check: 15_000, handover: 15_000, stopOld: 10_000, stopNew: 10_000, restoreOld: 20_000, graceMs: 30_000 });

/** A failure the step marks as "nothing changed on the old one yet" (the hand-over was refused before it touched the
 *  old service): the swap then rolls back instead of restoring. */
export class HandoverRefused extends Error {
  constructor(message) { super(message); this.name = 'HandoverRefused'; }
}

/** Throws when the swap cancelled this step (for steps: call before each change they make). */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error(`cancelled: ${signal.reason?.message ?? signal.reason ?? 'the swap gave up on this step'}`);
}

class StepStillRunning extends Error {}

// Runs one step with a deadline. On a timeout (or any failure) the step's signal is aborted and the step is awaited
// until it settles (at most graceMs), so nothing it does can overlap the next step.
async function runStep(fn, ms, graceMs, what) {
  const ac = new AbortController();
  const p = Promise.resolve().then(() => fn({ signal: ac.signal }));
  let t;
  const deadline = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); t.unref?.(); });
  try {
    return await Promise.race([p, deadline]);
  } catch (e) {
    if (!ac.signal.aborted) ac.abort(e);
    let g;
    const settled = await Promise.race([p.then(() => true, () => true), new Promise((r) => { g = setTimeout(() => r(false), graceMs); g.unref?.(); })]);
    clearTimeout(g);
    if (!settled) throw new StepStillRunning(`${what} did not stop ${graceMs} ms after it was cancelled (${e?.message ?? e})`);
    throw e;
  } finally { clearTimeout(t); }
}

/**
 * Runs one swap. opts: { mode, steps: { spawnNew, check, handover?, stopOld, stopNew, restoreOld }, timeouts?, now?,
 * onState?(state, action) }. Steps are async functions of ({ signal }); their resolved value is kept in history.
 * Returns { result, history: [{ state, action, ok, ms, error? }], ms }. Never throws for a step failure.
 */
export async function runSwap({ mode, steps, timeouts = {}, now = Date.now, onState = () => {} }) {
  if (!MODES.includes(mode)) throw new Error(`swap: unknown mode ${mode}`);
  for (const k of ['spawnNew', 'check', 'stopOld', 'stopNew', 'restoreOld', ...(mode === 'side-by-side' ? ['handover'] : [])]) {
    if (typeof steps?.[k] !== 'function') throw new Error(`swap: step ${k} missing`);
  }
  const tm = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const t0 = now();
  const history = [];
  let s = transition('idle', mode === 'side-by-side' ? 'begin-side' : 'begin-stop');
  for (;;) {
    onState(s.state, s.action);
    if (!s.action) return { result: s.result, history, ms: now() - t0 };
    const name = STEP[s.action];
    const started = now();
    let ev;
    try {
      const value = await runStep(steps[name], tm[name], tm.graceMs, name);
      history.push({ state: s.state, action: s.action, ok: true, ms: now() - started, ...(value !== undefined ? { value } : {}) });
      ev = OUTCOME[s.action][0];
    } catch (e) {
      history.push({ state: s.state, action: s.action, ok: false, ms: now() - started, error: String(e?.message ?? e).slice(0, 200) });
      // Only a hand-over that may still act blocks the rollback; a hung start or check only touches the new process,
      // which the rollback stops.
      if (e instanceof StepStillRunning && s.action === 'hand-over') { onState('idle', null); return { result: 'failed', history, ms: now() - t0 }; }
      ev = s.action === 'hand-over' && e instanceof HandoverRefused ? 'handover-refused' : OUTCOME[s.action][1];
    }
    s = transition(s.state, ev);
  }
}

// Services the supervisor knows. Not swappable while live: the host (LU5) and the overlay server (a child the host
// supervises: its script path and pinned ports belong to the host process; it is updated with the host, D337).
export const SERVICES = Object.freeze({
  'event-core': { mode: 'side-by-side' },
  'studio-ui': { mode: 'side-by-side' },
  'live-clipper': { mode: 'stop-start' },
  'face-worker': { mode: 'stop-start' },
  // LU4 (D346): the Qt studio window. Closed for the update ("swap-close", not a user close); the new exe reattaches
  // to the running host. The host, its encoders and outputs never stop. Stop-start: two windows never overlap.
  studio: { mode: 'stop-start' },
  host: { mode: null, why: 'the host owns the encoders and is never swapped while live; its update is applied at the next stop (LU5)' },
  'overlay-server': { mode: null, why: 'the overlay server is a child of the host (the host starts it, pins its ports and restarts it); it is updated with the host at the next stop' },
});

/** Why a swap of `service` is refused now, or null when it may run. busy: a swap is already running. */
export function refuseReason(service, { busy = false, known = SERVICES } = {}) {
  const s = Object.hasOwn(known, service) ? known[service] : null;
  if (!s) return `unknown service ${String(service).slice(0, 40)}`;
  if (!s.mode) return s.why;
  if (busy) return 'another swap is running; one at a time';
  return null;
}
