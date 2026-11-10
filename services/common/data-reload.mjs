// SPDX-License-Identifier: GPL-3.0-or-later
// Data hot-reload (LU2, D324): one data file, read from disk again when it changes, schema-checked first.
// A valid file applies at once (no restart, also while live); an invalid file keeps the last good value and says why.
// Node stdlib only.
//
//   const src = createDataSource({ kind, file, parse, missing?, report?, minCheckMs?, settleMs? });
//   src.get()      the current value: re-checks the file (stat; at most once per minCheckMs) and applies a valid change
//   src.watch()    also re-checks on file-system events (directory watch, debounced) and on a slow poll, so a change
//                  applies even when nobody calls get(); returns a stop function
//   src.status()   { kind, file (base name), ok, version, appliedAt, hash, rejected: { at, why } | null, missing }
//   src.onApply(fn) fn(value, status) after each applied change (not the first load)
//
// parse(text, file) returns the value or throws (the message is the reason shown to the user, so keep it plain).
// missing: a function () => value used while the file does not exist (e.g. built-in defaults); without it a missing
// file keeps the last good value and is reported like an invalid one.
// Windows-safe: the parent directory is watched (an editor that saves through a temp file and a rename replaces the
// watched file, which ends a file watch); a read that fails while the file is still being written (parse error,
// EBUSY or EPERM on a file that changed less than settleMs ago) is retried, not reported.
// report({ kind, file, ok, why?, first }) is called after each applied change (ok true) and each rejection (ok false).

import { createHash } from 'node:crypto';
import { readFileSync, statSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES']);

export class DataFileError extends Error {
  constructor(message) { super(message); this.name = 'DataFileError'; }
}

/** JSON.parse with a plain-words error (line/column when the engine gives a position). */
export function parseJsonText(text) {
  const t = String(text).replace(/^﻿/, '');
  try { return JSON.parse(t); } catch (e) {
    const m = /position (\d+)/.exec(String(e.message));
    if (m) {
      const upto = t.slice(0, Number(m[1]));
      const line = upto.split('\n').length;
      throw new DataFileError(`not valid JSON (line ${line})`);
    }
    throw new DataFileError('not valid JSON');
  }
}

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function createDataSource(opts) {
  const { kind, file, parse } = opts;
  if (typeof kind !== 'string' || !kind) throw new TypeError('data source: kind required');
  if (typeof file !== 'string' || !file) throw new TypeError('data source: file required');
  if (typeof parse !== 'function') throw new TypeError('data source: parse required');
  const now = opts.now ?? Date.now;
  const minCheckMs = opts.minCheckMs ?? 0;
  const settleMs = opts.settleMs ?? 250;
  const report = typeof opts.report === 'function' ? opts.report : null;
  const base = path.basename(file);
  const subs = new Set();

  let value;
  let has = false;
  let stamp = null;       // `${mtimeMs}:${size}` of the last read (applied or rejected)
  let hash = null;        // content hash of the applied file
  let version = 0;        // applied changes (0 = first load)
  let appliedAt = null;
  let rejected = null;    // { at, why }
  let missingNow = false;
  let lastCheck = -Infinity;
  let firstDone = false;

  function tell(ok, why) {
    if (!report) return;
    try { report({ kind, file, ok, ...(why ? { why } : {}), first: !firstDone, loaded: has }); } catch { /* a notice never breaks a reload */ }
  }

  function apply(v, h, viaMissing, quiet) {
    const changed = has;
    value = v; has = true; hash = h; appliedAt = now(); rejected = null; missingNow = viaMissing;
    if (changed) {
      version++;
      if (!quiet) tell(true);
      const st = status();
      for (const fn of subs) { try { fn(v, st); } catch { /* subscriber bug */ } }
    }
  }

  function reject(why) {
    const prev = rejected?.why;
    rejected = { at: now(), why: String(why).slice(0, 200) };
    if (prev !== rejected.why || !firstDone) tell(false, rejected.why);
  }

  /** Re-reads the file when its stamp changed. Returns { changed, ok, why?, pending? }. quiet: no notice for an
   *  applied change (the owner wrote the file itself, e.g. a flag flipped on the control page). */
  function check({ force = false, quiet = false } = {}) {
    lastCheck = now();
    let st;
    try { st = statSync(file); } catch (e) {
      if (e?.code === 'ENOENT') {
        if (stamp === 'missing' && !force) return { changed: false, ok: !rejected };
        stamp = 'missing';
        if (opts.missing) {
          try { apply(opts.missing(), 'missing', true, quiet); return { changed: true, ok: true }; } catch (err) { reject(err.message); return { changed: false, ok: false, why: rejected.why }; }
        }
        reject('file missing'); // the notice adds what stays in use (createDataNotifier)
        return { changed: false, ok: false, why: rejected.why };
      }
      if (TRANSIENT.has(e?.code)) return { changed: false, ok: !rejected, pending: true };
      reject(`cannot read (${e?.code ?? 'error'})`);
      return { changed: false, ok: false, why: rejected.why };
    }
    const s = `${st.mtimeMs}:${st.size}`;
    if (s === stamp && !force) return { changed: false, ok: !rejected };
    const young = now() - st.mtimeMs < settleMs;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) {
      if (TRANSIENT.has(e?.code) || e?.code === 'ENOENT') return { changed: false, ok: !rejected, pending: true };
      stamp = s;
      reject(`cannot read (${e?.code ?? 'error'})`);
      return { changed: false, ok: false, why: rejected.why };
    }
    const h = hashOf(text);
    if (has && h === hash && !missingNow) { stamp = s; if (rejected) { rejected = null; tell(true); } return { changed: false, ok: true }; }
    let v;
    try { v = parse(text, file); } catch (e) {
      // A file written in place (not through a rename) can be read half-way: wait until it has settled.
      if (young) return { changed: false, ok: !rejected, pending: true };
      stamp = s;
      reject(e?.message ?? 'invalid');
      return { changed: false, ok: false, why: rejected.why };
    }
    stamp = s;
    apply(v, h, false, quiet);
    return { changed: true, ok: true };
  }

  function first() {
    if (firstDone) return;
    const r = check({ force: true });
    firstDone = true;
    if (!has && opts.missing && !r.ok) { /* the missing() fallback threw: nothing to serve */ }
    return r;
  }

  function get() {
    if (!firstDone) first();
    else if (now() - lastCheck >= minCheckMs) check();
    if (!has) throw new DataFileError(rejected?.why ?? `${base}: no valid version`);
    return value;
  }

  function status() {
    return { kind, file: base, ok: has && !rejected, loaded: has, version, appliedAt, hash, rejected: rejected ? { ...rejected } : null, missing: missingNow };
  }

  /** Directory watch + slow poll. debounceMs groups the burst of events one save makes. */
  function watch({ debounceMs = 200, pollMs = 2000 } = {}) {
    if (!firstDone) first();
    // Each timer owns its own ref and clears only that ref; nothing runs or is scheduled after stop().
    let stopped = false;
    let t = null;     // debounce of file-system events
    let retry = null; // one retry while the file settles
    const run = () => {
      if (stopped) return;
      const r = check();
      if (r.pending && !retry && !stopped) { retry = setTimeout(() => { retry = null; run(); }, settleMs); retry.unref?.(); }
    };
    const kick = () => {
      if (stopped) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; run(); }, debounceMs);
      t.unref?.();
    };
    let w = null;
    try {
      w = fsWatch(path.dirname(file), { persistent: false }, (_ev, name) => { if (!name || String(name) === base) kick(); });
      w.on('error', () => { try { w.close(); } catch { /* gone */ } w = null; });
    } catch { w = null; } // the directory may not exist yet: the poll still sees the file when it appears
    const poll = setInterval(() => { if (now() - lastCheck >= pollMs / 2) run(); }, pollMs);
    poll.unref?.();
    return () => {
      stopped = true;
      if (t) clearTimeout(t);
      if (retry) clearTimeout(retry);
      t = null; retry = null;
      clearInterval(poll);
      try { w?.close(); } catch { /* gone */ }
    };
  }

  return { get, check, status, watch, onApply: (fn) => { subs.add(fn); return () => subs.delete(fn); }, kind, file };
}

// ---- notices -------------------------------------------------------------------------------------------------------
// Each kind has one notice in the studio's task area (a task file <dataDir>/tasks/data-<kind>.json): failed with the
// reason while the file on disk is invalid, done ("updated") after a valid change. Plus one log line per event, at
// warn level for a rejection (a broken data file is the user's to fix; it is not a software error).

export const DATA_LABELS = Object.freeze({
  'flags-local': 'Feature switches', 'flags-definitions': 'Feature switch list', 'posting-rules': 'Auto-post rules',
  'effect-guards': 'Effect presets', 'flash-measurements': 'Effect flash measurements', 'studio-tasks': 'Task panel settings',
  'guide-tour': 'Guided tour', 'guide-hints': 'Tips', theme: 'Theme',
});

/** report() for createDataSource: log + task-area notice. writeTask: (dataDir, task) => bool (studio-ui/tasks.mjs). */
export function createDataNotifier({ dataDir = null, writeTask = null, log = (m) => console.warn(m), now = Date.now } = {}) {
  return (e) => {
    const label = DATA_LABELS[e.kind] ?? e.kind;
    const name = path.basename(e.file);
    if (e.first && e.ok) return; // the first load is not news
    try { log(e.ok ? `[data] ${e.kind}: ${name} applied` : `[data] ${e.kind}: ${name} not applied, the last good version stays: ${e.why}`); } catch { /* log sink gone */ }
    if (!dataDir || typeof writeTask !== 'function') return;
    const t = now();
    writeTask(dataDir, {
      id: `data-${e.kind}`, kind: 'data', state: e.ok ? 'done' : 'failed',
      title: e.ok ? `${label} updated` : `${label} not applied: the file has a problem`,
      // loaded false: there was never a good version (a missing or broken file at start), so none can stay in use
      note: e.ok ? `${name} was changed on disk and is now in use` : `${name}: ${e.why}. ${e.loaded === false ? 'Nothing from this file is in use until it is fixed.' : 'The last good version stays in use.'}`,
      startedAt: t, updatedAt: t,
    });
  };
}
