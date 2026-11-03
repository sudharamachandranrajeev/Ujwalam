// SPDX-License-Identifier: GPL-2.0-or-later
// Feature flags (alpha plan Part B, D149). Node stdlib only.
//   defaults: data/flags.json (committed): { flags: [{ id, description, default, since }] }
//   local state: <dataDir>/flags.local.json (gitignored): { flags: { <id>: true|false } }, written atomically.
// The studio-ui server owns writes (flags.set). Other services import createFlags() and read: isOn() re-reads the local
// file when its mtime changes, so a flip made on the control page is seen without a restart.
// An id that is not in data/flags.json is rejected on write and ignored on read.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLAG_ID = /^[a-z][a-z0-9-]{0,47}$/;
export const DEFAULT_FLAGS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'flags.json');
export const LOCAL_NAME = 'flags.local.json';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Loads and validates the committed defaults. Throws on a malformed file. */
export function loadDefinitions(file = DEFAULT_FLAGS_FILE) {
  const j = readJson(file);
  if (!j || !Array.isArray(j.flags)) throw new Error(`flags: bad definitions file ${path.basename(file)}`);
  const seen = new Set();
  return j.flags.map((f) => {
    if (!f || typeof f.id !== 'string' || !FLAG_ID.test(f.id)) throw new Error('flags: bad id');
    if (seen.has(f.id)) throw new Error(`flags: duplicate id ${f.id}`);
    seen.add(f.id);
    if (typeof f.description !== 'string' || typeof f.default !== 'boolean' || typeof f.since !== 'string') throw new Error(`flags: bad entry ${f.id}`);
    return { id: f.id, description: f.description, default: f.default, since: f.since };
  });
}

/** opts: { dataDir, definitionsFile? }. Returns { list, isOn, set, subscribe, ids }. */
export function createFlags(opts) {
  if (typeof opts?.dataDir !== 'string' || !opts.dataDir) throw new Error('flags: dataDir required');
  const defs = loadDefinitions(opts.definitionsFile);
  const byId = new Map(defs.map((d) => [d.id, d]));
  const localFile = path.join(opts.dataDir, LOCAL_NAME);
  const subs = new Set();
  let cache = { mtime: -1, size: -1, values: {} };

  function local() {
    let st;
    try { st = statSync(localFile); } catch { cache = { mtime: -1, size: -1, values: {} }; return cache.values; }
    if (st.mtimeMs === cache.mtime && st.size === cache.size) return cache.values;
    const j = readJson(localFile);
    const values = {};
    if (j && j.flags && typeof j.flags === 'object' && !Array.isArray(j.flags)) {
      for (const [k, v] of Object.entries(j.flags)) if (byId.has(k) && typeof v === 'boolean') values[k] = v;
    }
    cache = { mtime: st.mtimeMs, size: st.size, values };
    return values;
  }

  const isOn = (id) => {
    const d = byId.get(id);
    if (!d) return false; // unknown flag is off
    const v = local();
    return Object.hasOwn(v, id) ? v[id] : d.default;
  };
  const list = () => defs.map((d) => ({ ...d, on: isOn(d.id) }));

  function set(id, on) {
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
    cache = { mtime: -1, size: -1, values: {} };
    const out = list();
    for (const fn of subs) { try { fn({ id, on, flags: out }); } catch { /* a bad subscriber never blocks a flag flip */ } }
    return out;
  }

  /** fn({ id, on, flags }) runs after each set() made through this instance. Returns an unsubscribe function. */
  const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  return { list, isOn, set, subscribe, ids: () => defs.map((d) => d.id) };
}
