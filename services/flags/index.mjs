// SPDX-License-Identifier: GPL-3.0-or-later
// Feature flags (alpha plan Part B, D149). Node stdlib only.
//   defaults: data/flags.json (committed): { flags: [{ id, description, default, since }] }
//   local state: <dataDir>/flags.local.json (gitignored): { flags: { <id>: true|false } }, written atomically.
// The studio-ui server owns writes (flags.set). Other services import createFlags() and read: isOn() re-reads the local
// file when its mtime changes, so a flip made on the control page is seen without a restart. LU2 (D324): both files
// reload on change (data/flags.json checked about once a second); an invalid version of either keeps the last good
// values and is reported through opts.report (services/common/data-reload.mjs).
// An id that is not in data/flags.json is rejected on write and ignored on read.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataSource, parseJsonText } from '../common/data-reload.mjs';

export const FLAG_ID = /^[a-z][a-z0-9-]{0,47}$/;
export const DEFAULT_FLAGS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'flags.json');
export const LOCAL_NAME = 'flags.local.json';

/** The definitions as data: throws a plain-words error on a malformed document. */
export function parseDefinitions(j) {
  if (!j || !Array.isArray(j.flags)) throw new Error('flags: bad definitions file (no flags list)');
  const seen = new Set();
  return j.flags.map((f) => {
    if (!f || typeof f.id !== 'string' || !FLAG_ID.test(f.id)) throw new Error('flags: bad id');
    if (seen.has(f.id)) throw new Error(`flags: duplicate id ${f.id}`);
    seen.add(f.id);
    if (typeof f.description !== 'string' || typeof f.default !== 'boolean' || typeof f.since !== 'string') throw new Error(`flags: bad entry ${f.id}`);
    return { id: f.id, description: f.description, default: f.default, since: f.since };
  });
}

/** Loads and validates the committed defaults. Throws on a malformed file. */
export function loadDefinitions(file = DEFAULT_FLAGS_FILE) {
  let j = null;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { j = null; }
  if (!j || !Array.isArray(j.flags)) throw new Error(`flags: bad definitions file ${path.basename(file)}`);
  return parseDefinitions(j);
}

/** The local state file as data ({ <id>: bool }). A file that is not { flags: { ... } }, or that gives a known flag
 *  (isKnown(id), default: every id) a value other than true/false, is invalid as a whole (LU2: an invalid file keeps
 *  the last good values). Dropping only that value would turn a default-on feature on, even while live. Non-boolean
 *  values of unknown ids are skipped (they are ignored on read anyway). */
export function parseLocal(text, isKnown = () => true) {
  const j = parseJsonText(text);
  if (!j || typeof j !== 'object' || Array.isArray(j) || !j.flags || typeof j.flags !== 'object' || Array.isArray(j.flags)) throw new Error('needs { "flags": { "<id>": true|false } }');
  const values = {};
  for (const [k, v] of Object.entries(j.flags)) {
    if (typeof v === 'boolean') values[k] = v;
    else if (isKnown(k)) throw new Error(`${k} must be true or false, not ${JSON.stringify(v)?.slice(0, 40)}`);
  }
  return values;
}

/** opts: { dataDir, definitionsFile?, report? }. Returns { list, isOn, set, subscribe, ids, watch, dataStatus }. */
export function createFlags(opts) {
  if (typeof opts?.dataDir !== 'string' || !opts.dataDir) throw new Error('flags: dataDir required');
  const defsFile = opts.definitionsFile ?? DEFAULT_FLAGS_FILE;
  loadDefinitions(defsFile); // a malformed definitions file at start is still an error (no last good version yet)
  // LU2: both files reload when they change; an invalid version keeps the last good one (opts.report says why).
  const defsSrc = createDataSource({ kind: 'flags-definitions', file: defsFile, parse: (t) => parseDefinitions(parseJsonText(t)), minCheckMs: 1000, report: opts.report });
  let defsHash = null;
  let byId = new Map();
  const defs = () => {
    const d = defsSrc.get();
    const h = defsSrc.status().hash;
    if (h !== defsHash) { byId = new Map(d.map((x) => [x.id, x])); defsHash = h; }
    return d;
  };
  defs();
  const localFile = path.join(opts.dataDir, LOCAL_NAME);
  const subs = new Set();
  const localSrc = createDataSource({ kind: 'flags-local', file: localFile, parse: (t) => parseLocal(t, (id) => byId.has(id)), missing: () => ({}), report: opts.report });

  function local() {
    defs();
    let v;
    try { v = localSrc.get(); } catch { v = {}; }
    const out = {};
    for (const [k, x] of Object.entries(v)) if (byId.has(k)) out[k] = x;
    return out;
  }

  const isOn = (id) => {
    defs();
    const d = byId.get(id);
    if (!d) return false; // unknown flag is off
    const v = local();
    return Object.hasOwn(v, id) ? v[id] : d.default;
  };
  const list = () => defs().map((d) => ({ ...d, on: isOn(d.id) }));

  function set(id, on) {
    defs();
    if (typeof id !== 'string' || !FLAG_ID.test(id) || !byId.has(id)) throw Object.assign(new Error('unknown flag'), { code: 'UNKNOWN_FLAG' });
    if (typeof on !== 'boolean') throw Object.assign(new Error('on must be boolean'), { code: 'BAD_VALUE' });
    const values = { ...local(), [id]: on };
    mkdirSync(opts.dataDir, { recursive: true });
    const tmp = `${localFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ flags: values }, null, 2)}\n`, 'utf8');
      renameSync(tmp, localFile);
    } catch (e) {
      if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* best effort */ } }
      throw e;
    }
    localSrc.check({ force: true, quiet: true }); // our own write: applied at once, no "changed on disk" notice
    const out = list();
    for (const fn of subs) { try { fn({ id, on, flags: out }); } catch { /* a bad subscriber never blocks a flag flip */ } }
    return out;
  }

  /** fn({ id, on, flags }) runs after each set() made through this instance. Returns an unsubscribe function. */
  const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  /** LU2: watch both files, so a change applies (and a broken file is reported) even when nothing reads a flag. */
  const watch = () => { const a = defsSrc.watch(); const b = localSrc.watch(); return () => { a(); b(); }; };
  const dataStatus = () => [defsSrc.status(), localSrc.status()];
  return { list, isOn, set, subscribe, ids: () => defs().map((d) => d.id), watch, dataStatus };
}
