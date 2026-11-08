// SPDX-License-Identifier: GPL-3.0-or-later
// What the software is doing, in plain words, for the studio window's task bar (it only informs; it never blocks).
// A task: { id, title, kind, state: running|done|failed|waiting, done, total (null = unknown), stage, note,
// startedAt, updatedAt }. Two sources: files <dataDir>/tasks/<id>.json written by launcher-side jobs (writeTaskFile,
// atomic), and in-memory tasks of the UI server for its own long actions (createTasks().track). Finished or silent
// tasks are dropped after PRUNE_MS. Text only: no chat text, no viewer names, no paths beyond the clips folder.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  return { id, title, kind: cut(t.kind, 24) ?? 'task', state, done, total: total === 0 ? null : total, stage: cut(t.stage, 24),
    note: cut(t.note, 160), startedAt: int(t.startedAt), updatedAt: int(t.updatedAt) };
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

const RANK = { running: 0, waiting: 1, failed: 2, done: 3 };
const order = (a, b) => RANK[a.state] - RANK[b.state] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

/** opts: { dataDir?, now? }. start() returns a handle; track() runs a function as a task. */
export function createTasks({ dataDir = null, now = Date.now } = {}) {
  const mem = new Map();
  let seq = 0;
  const prune = () => {
    const t = now();
    for (const [id, x] of mem) if (t - x.updatedAt > PRUNE_MS) mem.delete(id);
    while (mem.size > MAX_TASKS) mem.delete(mem.keys().next().value);
  };
  function start({ title, kind = 'task', total = null, stage = null, note = null }) {
    const id = `ui-${now().toString(36)}-${(seq++).toString(36)}`;
    const t = now();
    const rec = { id, title: cut(title, 120) ?? 'Working', kind: cut(kind, 24) ?? 'task', state: 'running', done: total === null ? null : 0, total: int(total), stage: cut(stage, 24), note: cut(note, 160), startedAt: t, updatedAt: t };
    mem.set(id, rec);
    prune();
    const set = (p) => { Object.assign(rec, p, { updatedAt: now() }); };
    return {
      id,
      update: (p = {}) => set({ ...(p.done !== undefined ? { done: int(p.done) } : {}), ...(p.total !== undefined ? { total: int(p.total) } : {}),
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
    return all.sort(order).slice(0, MAX_TASKS);
  }
  return { start, track, list, isFinished: (t) => FINISHED.has(t.state) };
}
