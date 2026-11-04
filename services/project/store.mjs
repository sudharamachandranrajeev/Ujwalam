// SPDX-License-Identifier: GPL-3.0-or-later
// Project load and save. Atomic save: write <file>.tmp-<pid>, fsync, copy the current file to <file>.bak, rename
// the temp over the file. A kill at any point leaves the original (or the .bak) intact; a leftover temp is
// ignored by load. No path is built from the environment: callers pass the file or the data dir.

import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrate.mjs';
import { validateProject } from './validate.mjs';

export class ProjectError extends Error {
  constructor(message, errors = []) { super(message); this.name = 'ProjectError'; this.errors = errors; }
}

export function projectFile(dataDir, id) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new TypeError('invalid project id');
  return path.join(dataDir, 'projects', `${id}.project.json`);
}

// Parse text, migrate, validate. Throws ProjectError with the validator's errors.
export function parseProject(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new ProjectError(`invalid JSON: ${e.message}`); }
  let m;
  try { m = migrate(raw); } catch (e) { throw new ProjectError(e.message); }
  const v = validateProject(m.doc);
  if (!v.ok) throw new ProjectError(`project failed validation (${v.errors.length} error(s))`, v.errors);
  return { project: m.doc, migrated: m.migrated };
}

// loadProject(file) -> { project, migrated, recoveredFrom }. If the file is missing or corrupt and a .bak is
// valid, the .bak is used and recoveredFrom is 'bak'. The file on disk is not rewritten here.
export function loadProject(file) {
  const read = (f) => {
    try { return fs.readFileSync(f, 'utf8'); } catch (e) { throw new ProjectError(`cannot read project file: ${e.code || e.message}`); }
  };
  let firstError;
  try {
    return { ...parseProject(read(file)), recoveredFrom: null };
  } catch (e) {
    firstError = e;
  }
  try {
    return { ...parseProject(read(`${file}.bak`)), recoveredFrom: 'bak' };
  } catch {
    throw firstError;
  }
}

// saveProject(file, project, { hooks }) validates first and refuses an invalid project. hooks.afterTemp and
// hooks.afterBackup exist for crash tests only.
export function saveProject(file, project, opts = {}) {
  const v = validateProject(project);
  if (!v.ok) throw new ProjectError(`refusing to save an invalid project (${v.errors.length} error(s))`, v.errors);
  const hooks = opts.hooks || {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(project, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (hooks.afterTemp) hooks.afterTemp(tmp);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  if (hooks.afterBackup) hooks.afterBackup(tmp);
  fs.renameSync(tmp, file);
  return { file, bytes: fs.statSync(file).size };
}

// Remove leftover temp files from killed saves of this project. Returns the names removed.
export function cleanTemps(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.tmp-`;
  const removed = [];
  if (!fs.existsSync(dir)) return removed;
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith(prefix)) { fs.rmSync(path.join(dir, n), { force: true }); removed.push(n); }
  }
  return removed;
}

// Resolve a { base, rel } reference against caller-supplied base directories. Throws if the result escapes.
export function resolvePathRef(ref, bases) {
  const root = bases && bases[ref.base];
  if (typeof root !== 'string' || !root) throw new ProjectError(`no directory configured for base "${ref.base}"`);
  const full = path.resolve(root, ref.rel);
  const rel = path.relative(path.resolve(root), full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ProjectError('path escapes its base');
  return full;
}
