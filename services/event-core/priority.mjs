// SPDX-License-Identifier: GPL-3.0-or-later
// Process priority rule for the event core (user decision 2026-10-28). Node stdlib only.
//
// The live event core runs at Normal process priority, never BelowNormal: a Normal-priority burst elsewhere on the
// host (an agent session, a scan, a VM start) must not starve the live path. AI workers, benchmarks and background
// jobs stay low priority (BelowNormal), so the live path never runs below background work. The Qt app with libobs
// (P4+) should outrank the core; that is a later decision (no AboveNormal now).
//
//   const r = setLivePriority();            // { ok, target: 'normal', before, after, error? }
//   out(`[serve] ${formatPriority(r)}`);
//   setBackgroundPriority(child.pid);       // for any background child process the core starts (none in P3)
//
// Failure is reported, never fatal: the core still runs, the log line says the priority was not set.

import os from 'node:os';

const P = os.constants.priority;
const NAMES = new Map([
  [P.PRIORITY_LOW, 'low'], [P.PRIORITY_BELOW_NORMAL, 'below-normal'], [P.PRIORITY_NORMAL, 'normal'],
  [P.PRIORITY_ABOVE_NORMAL, 'above-normal'], [P.PRIORITY_HIGH, 'high'], [P.PRIORITY_HIGHEST, 'highest'],
]);
export const LIVE_PRIORITY = P.PRIORITY_NORMAL;
export const BACKGROUND_PRIORITY = P.PRIORITY_BELOW_NORMAL;

/** Name of an os priority value ('normal', 'below-normal' ...), or null when unknown. */
export const priorityName = (v) => (typeof v === 'number' ? NAMES.get(v) ?? `value-${v}` : null);

const codeOf = (e) => (typeof e?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(e.code) ? e.code : 'ERROR');

/** Sets the priority of `pid` (0 = this process). sys is a test seam ({ getPriority, setPriority }, default node:os). */
export function setPriorityOf(pid, level, sys = os) {
  let before = null;
  try { before = sys.getPriority(pid); } catch { /* unknown */ }
  try { sys.setPriority(pid, level); } catch (e) {
    return { ok: false, target: priorityName(level), before: priorityName(before), after: priorityName(before), error: codeOf(e) };
  }
  let after = null;
  try { after = sys.getPriority(pid); } catch { /* unknown */ }
  return { ok: after === null || after === level, target: priorityName(level), before: priorityName(before), after: priorityName(after) };
}

/** The live core sets itself to Normal. */
export const setLivePriority = (sys = os) => setPriorityOf(0, LIVE_PRIORITY, sys);
/** A background child process (AI worker, job) goes to BelowNormal. */
export const setBackgroundPriority = (pid, sys = os) => setPriorityOf(pid, BACKGROUND_PRIORITY, sys);

/** One log line (no paths, no values beyond names and an error code). */
export function formatPriority(r) {
  if (r.ok) return `process priority ${r.after ?? r.target} (target ${r.target}, was ${r.before ?? 'unknown'})`;
  return `warn: process priority NOT set to ${r.target} (${r.error ?? 'mismatch'}); now ${r.after ?? 'unknown'}; continuing`;
}
