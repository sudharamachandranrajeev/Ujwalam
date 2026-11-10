// SPDX-License-Identifier: GPL-3.0-or-later
// What the software is doing, in plain words, for the studio window's task bar (it only informs; it never blocks).
// A task: { id, title, kind, state: running|done|failed|waiting, done, total (null = unknown), stage, note,
// startedAt, updatedAt, stages?, stageText?, unit?, activeAt?, progressAt? } plus, in list(), progress (0..1 | null),
// elapsedMs and etaMs (null = unknown; D311 proposed), silentMs, stalled, stallAfterMs and step (2026-11-10). Two sources: files <dataDir>/tasks/<id>.json written by launcher-side jobs (writeTaskFile,
// atomic), and in-memory tasks of the UI server for its own long actions (createTasks().track). Finished or silent
// tasks are dropped after PRUNE_MS. Text only: no chat text, no viewer names, no paths beyond the clips folder.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASK_STATES = Object.freeze(['running', 'done', 'failed', 'waiting']);
export const PRUNE_MS = 10 * 60_000;
export const MAX_TASKS = 40;
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const FINISHED = new Set(['done', 'failed']);

const cut = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : null);
const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** A clean task from untrusted input (a file or a caller), or null. */
export function cleanTask(t, id = t?.id) {
  if (!t || typeof t !== 'object' || typeof id !== 'string' || !ID.test(id)) return null;
  const state = TASK_STATES.includes(t.state) ? t.state : null;
  const title = cut(t.title, 120);
  if (!state || !title) return null;
  const total = int(t.total);
  let done = int(t.done);
  if (done !== null && total !== null && done > total) done = total;
  // Panel detail (2026-11-10): the job's known stages in order, the current stage in plain words, what is counted
  // (frame, clip, MB), when it began working (activeAt; startedAt may be when it was queued) and when its last progress
  // line came (progressAt; null = none yet). Optional: older writers leave them out.
  const stages = Array.isArray(t.stages) ? t.stages.slice(0, 8).map((s) => cut(s, 24)).filter(Boolean) : [];
  return { id, title, kind: cut(t.kind, 24) ?? 'task', state, done, total: total === 0 ? null : total, stage: cut(t.stage, 24),
    note: cut(t.note, 160), startedAt: int(t.startedAt), updatedAt: int(t.updatedAt),
    stages: stages.length ? stages : null, stageText: cut(t.stageText, 60), unit: cut(t.unit, 16), activeAt: int(t.activeAt), progressAt: int(t.progressAt),
    measured: t.measured === false ? false : null }; // false = this stage reports no progress while it works
}

export const tasksDir = (dataDir) => path.join(dataDir, 'tasks');

/** Atomic write of one task file (best effort: the task bar must never break the job). */
export function writeTaskFile(dataDir, task) {
  const c = cleanTask(task);
  if (!c) return false;
  try {
    const dir = tasksDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${c.id}.json`);
    writeFileSync(`${f}.tmp`, JSON.stringify(c));
    renameSync(`${f}.tmp`, f);
    return true;
  } catch { return false; }
}

export function removeTaskFile(dataDir, id) {
  if (!ID.test(id)) return;
  try { rmSync(path.join(tasksDir(dataDir), `${id}.json`), { force: true }); } catch { /* gone */ }
}

/** Task files, newest first; files older than PRUNE_MS (finished or not updated) are deleted. */
export function readTaskFiles(dataDir, nowMs = Date.now()) {
  const dir = tasksDir(dataDir);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    let t = null;
    try { t = cleanTask(JSON.parse(readFileSync(path.join(dir, n), 'utf8')), id); } catch { t = null; }
    if (!t) continue;
    if (nowMs - (t.updatedAt ?? t.startedAt ?? 0) > PRUNE_MS) { removeTaskFile(dataDir, id); continue; }
    out.push(t);
  }
  return out;
}

// ---- progress, elapsed time and time left (user 2026-11-09, D311 proposed) ----
// Every task in the list carries: progress (0..1, or null = unknown amount of work), elapsedMs (since it started; a
// finished task: up to its last update) and etaMs (time left, or null = unknown). The time left comes only from the
// measured rate of the current stage: (time since the first sample of this stage) * (work left / work done since then).
// No rate yet (fewer than ETA_MIN_MS of samples, no progress since, unknown total, waiting): unknown, never a guess.
export const ETA_MIN_MS = 3000;

/** 0..1 for a task, or null when the amount of work is unknown. A finished "done" task is 1. */
export function progressOf(t) {
  if (t?.state === 'done') return 1;
  if (!Number.isFinite(t?.total) || t.total <= 0 || !Number.isFinite(t?.done)) return null;
  return Math.min(1, Math.max(0, t.done / t.total));
}

/** Time left in ms from a stage's first sample { at, p } and the current progress p at now; null = unknown. */
export function etaFrom(first, p, now) {
  if (!first || !Number.isFinite(p) || !Number.isFinite(first.p) || !Number.isFinite(first.at)) return null;
  const dt = now - first.at;
  const dp = p - first.p;
  if (dt < ETA_MIN_MS || dp <= 0 || p >= 1) return p >= 1 ? 0 : null;
  return Math.round(dt * (1 - p) / dp);
}

/**
 * A rate tracker: timing(task) -> { progress, elapsedMs, etaMs }. One sample per task and stage is kept (the first one
 * seen); it starts again when the stage changes or the progress goes back. Forgotten tasks are dropped by keep(ids).
 */
export function createTiming(now = Date.now) {
  const first = new Map();
  function timing(t) {
    const n = now();
    const p = progressOf(t);
    const start = Number.isFinite(t.startedAt) ? t.startedAt : null;
    const end = t.state === 'done' || t.state === 'failed' ? (t.updatedAt ?? n) : n;
    const elapsedMs = start === null ? null : Math.max(0, end - start);
    let etaMs = null;
    if (t.state === 'running' && p !== null) {
      const stage = t.stage ?? '';
      let f = first.get(t.id);
      if (!f || f.stage !== stage || p < f.p) { f = { stage, at: n, p }; first.set(t.id, f); }
      etaMs = etaFrom(f, p, n);
    } else first.delete(t.id);
    return { progress: p, elapsedMs, etaMs };
  }
  function keep(ids) { for (const id of [...first.keys()]) if (!ids.has(id)) first.delete(id); }
  return { timing, keep };
}

// ---- stall warning and step (user 2026-11-10) ----
// A running task that has sent no progress for stallAfterMs (data/studio/tasks.json), or none at all since it began
// working, is marked stalled: the panel warns "it may be stuck" and offers Stop. Only a warning; nothing is stopped.
export const TASKS_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'studio', 'tasks.json');

/** { stallAfterMs } from data/studio/tasks.json; stallAfterMs null (no warning) when the file is missing or wrong. */
export function loadTaskConfig(file = TASKS_CONFIG) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return { stallAfterMs: Number.isFinite(j.stallAfterMs) && j.stallAfterMs >= 10_000 ? Math.floor(j.stallAfterMs) : null };
  } catch { return { stallAfterMs: null }; }
}

/** For a running task: { silentMs, stalled } (silence since the last progress line, else since it began); else nulls. */
export function stallOf(t, now, stallAfterMs) {
  if (t?.state !== 'running') return { silentMs: null, stalled: false };
  const ref = t.progressAt ?? t.activeAt ?? t.startedAt;
  if (!Number.isFinite(ref)) return { silentMs: null, stalled: false };
  const silentMs = Math.max(0, now - ref);
  // A stage that reports no progress while it works (measured: false: publish, montage) is never called stuck.
  return { silentMs, stalled: t.measured !== false && Number.isFinite(stallAfterMs) && silentMs >= stallAfterMs };
}

/** { index (1-based), count } of the current stage in the task's known stages, or null. */
export function stepOf(t) {
  if (!Array.isArray(t?.stages) || !t.stage) return null;
  const i = t.stages.indexOf(t.stage);
  return i < 0 ? null : { index: i + 1, count: t.stages.length };
}

const RANK = { running: 0, waiting: 1, failed: 2, done: 3 };
const order = (a, b) => RANK[a.state] - RANK[b.state] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

/** opts: { dataDir?, now?, stallAfterMs? (default: data/studio/tasks.json) }. start() returns a handle; track() runs a
 *  function as a task. */
export function createTasks({ dataDir = null, now = Date.now, stallAfterMs = loadTaskConfig().stallAfterMs } = {}) {
  const mem = new Map();
  const clock = createTiming(now);
  let seq = 0;
  const prune = () => {
    const t = now();
    for (const [id, x] of mem) if (t - x.updatedAt > PRUNE_MS) mem.delete(id);
    while (mem.size > MAX_TASKS) mem.delete(mem.keys().next().value);
  };
  function start({ title, kind = 'task', total = null, stage = null, note = null }) {
    const id = `ui-${now().toString(36)}-${(seq++).toString(36)}`;
    const t = now();
    const rec = { id, title: cut(title, 120) ?? 'Working', kind: cut(kind, 24) ?? 'task', state: 'running', done: total === null ? null : 0, total: int(total), stage: cut(stage, 24), note: cut(note, 160), startedAt: t, updatedAt: t, activeAt: t, progressAt: null };
    mem.set(id, rec);
    prune();
    const set = (p) => { Object.assign(rec, p, { updatedAt: now() }); };
    return {
      id,
      update: (p = {}) => set({ ...(p.done !== undefined || p.stage !== undefined ? { progressAt: now() } : {}), ...(p.done !== undefined ? { done: int(p.done) } : {}), ...(p.total !== undefined ? { total: int(p.total) } : {}),
        ...(p.stage !== undefined ? { stage: cut(p.stage, 24) } : {}), ...(p.note !== undefined ? { note: cut(p.note, 160) } : {}), ...(p.title ? { title: cut(p.title, 120) } : {}) }),
      done: (note = null) => set({ state: 'done', note: cut(note, 160), ...(rec.total !== null ? { done: rec.total } : {}) }),
      fail: (note = null) => set({ state: 'failed', note: cut(note, 160) }),
    };
  }
  /** Runs fn(handle) as a task. A result with ok === false, or a thrown error, marks it failed (the error is rethrown). */
  async function track(spec, fn) {
    const h = start(spec);
    try {
      const r = await fn(h);
      if (r && typeof r === 'object' && r.failed === true) h.fail(r.note ?? 'Did not finish'); else h.done(spec.doneNote ?? null);
      return r;
    } catch (e) { h.fail('Did not finish'); throw e; }
  }
  /** All tasks: running first, then waiting, then the newest finished. */
  function list() {
    prune();
    const all = [...mem.values()].map((x) => ({ ...x }));
    if (dataDir) all.push(...readTaskFiles(dataDir, now()));
    const n = now();
    const out = all.sort(order).slice(0, MAX_TASKS).map((t) => ({ stages: null, stageText: null, unit: null, activeAt: null, progressAt: null, measured: null, ...t,
      ...clock.timing(t), ...stallOf(t, n, stallAfterMs), stallAfterMs, step: stepOf(t) }));
    clock.keep(new Set(out.map((t) => t.id)));
    return out;
  }
  return { start, track, list, isFinished: (t) => FINISHED.has(t.state) };
}
