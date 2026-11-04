// SPDX-License-Identifier: GPL-3.0-or-later
// Feature registry validator.
// Usage: node tools/registry-validate.mjs [registryRoot] [repoRoot]
//   registryRoot  default "registry"; contains schema/, categories.json, tags.json, functions/, presets/, pools/
//   repoRoot      default cwd; legacySource paths resolve against it
// Exit code 1 on any error; each error is printed with its file path.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

// ---- semver (exact, ^, ~, >=) -------------------------------------------------

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function satisfies(version, range) {
  const v = parseSemver(version);
  const m = /^(\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(range);
  if (!v || !m) return false;
  const base = parseSemver(m[2]);
  const op = m[1] ?? '';
  if (op === '') return cmp(v, base) === 0;
  if (op === '>=') return cmp(v, base) >= 0;
  if (cmp(v, base) < 0) return false;
  let upper;
  if (op === '~') upper = [base[0], base[1] + 1, 0];
  else if (base[0] > 0) upper = [base[0] + 1, 0, 0];
  else if (base[1] > 0) upper = [0, base[1] + 1, 0];
  else upper = [0, 0, base[2] + 1];
  return cmp(v, upper) < 0;
}

// ---- helpers --------------------------------------------------------------------

function readJson(file, errors, rel) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push({ file: rel, message: `cannot parse JSON: ${e.message}` });
    return undefined;
  }
}

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
}

// ---- main -----------------------------------------------------------------------

export function validateRegistry(registryRoot, repoRoot = process.cwd()) {
  const errors = [];
  const rel = (f) => path.relative(process.cwd(), f).split(path.sep).join('/');
  const err = (file, message) => errors.push({ file: rel(file), message });

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schemaDir = path.join(registryRoot, 'schema');
  const schemaFiles = listJson(schemaDir);
  if (schemaFiles.length === 0) {
    err(schemaDir, 'no schema files found');
    return errors;
  }
  const byName = {};
  for (const f of schemaFiles) {
    const s = readJson(f, errors, rel(f));
    if (!s) continue;
    try {
      ajv.addSchema(s);
      byName[path.basename(f).replace('.schema.json', '')] = s.$id;
    } catch (e) {
      err(f, `invalid schema: ${e.message}`);
    }
  }
  if (errors.length) return errors;

  const check = (name, data, file) => {
    const validate = ajv.getSchema(byName[name]);
    if (!validate) return err(file, `missing schema "${name}"`), false;
    if (!validate(data)) {
      for (const e of validate.errors) err(file, `schema(${name}) ${e.instancePath || '/'} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
      return false;
    }
    return true;
  };

  // categories
  const categories = new Map();
  const catFile = path.join(registryRoot, 'categories.json');
  if (!existsSync(catFile)) err(catFile, 'missing categories.json');
  else {
    const list = readJson(catFile, errors, rel(catFile));
    if (list !== undefined && !Array.isArray(list)) err(catFile, 'categories.json must be an array');
    else if (list) for (const c of list) {
      if (!check('category', c, catFile)) continue;
      if (categories.has(c.id)) err(catFile, `duplicate category id "${c.id}"`);
      categories.set(c.id, c);
    }
  }

  // tags
  let vocab;
  const tagFile = path.join(registryRoot, 'tags.json');
  if (!existsSync(tagFile)) err(tagFile, 'missing tags.json');
  else {
    const t = readJson(tagFile, errors, rel(tagFile));
    if (t && check('tags', t, tagFile)) vocab = t.tags;
  }

  // functions
  const functions = new Map();
  for (const f of listJson(path.join(registryRoot, 'functions'))) {
    const fn = readJson(f, errors, rel(f));
    if (!fn || !check('function', fn, f)) continue;
    if (functions.has(fn.id)) err(f, `duplicate function id "${fn.id}"`);
    if (path.basename(f) !== `${fn.id}.json`) err(f, `file name must be ${fn.id}.json`);
    if (fn.flashesPerSec > 3) err(f, `flashesPerSec ${fn.flashesPerSec} exceeds limit of 3`);
    if (!categories.has(fn.category)) err(f, `category "${fn.category}" does not exist`);
    functions.set(fn.id, fn);
  }

  // presets
  const presets = new Map();
  for (const f of listJson(path.join(registryRoot, 'presets'))) {
    const p = readJson(f, errors, rel(f));
    if (!p || !check('preset', p, f)) continue;
    if (presets.has(p.id)) err(f, `duplicate preset id "${p.id}"`);
    if (path.basename(f) !== `${p.id}.json`) err(f, `file name must be ${p.id}.json`);
    presets.set(p.id, { p, f });
    const fn = functions.get(p.function);
    if (!fn) err(f, `function "${p.function}" does not exist`);
    else {
      if (!satisfies(fn.version, p.functionVersion)) err(f, `functionVersion "${p.functionVersion}" is not satisfied by function ${fn.id}@${fn.version}`);
      for (const c of p.canvases) if (!fn.canvases.includes(c)) err(f, `preset canvas "${c}" not in function canvases [${fn.canvases.join(',')}]`);
    }
    if (vocab) for (const [k, v] of Object.entries(p.tags)) {
      if (!vocab[k]?.includes(v)) err(f, `tag ${k}="${v}" is not in the tag vocabulary`);
    }
    if (p.legacySource !== undefined) {
      const full = path.resolve(repoRoot, p.legacySource);
      const legacyRoot = path.resolve(repoRoot, 'legacy') + path.sep;
      if (!full.startsWith(legacyRoot)) err(f, `legacySource "${p.legacySource}" is outside legacy/`);
      else if (!existsSync(full)) err(f, `legacySource "${p.legacySource}" does not exist on disk`);
    }
  }
  for (const { p, f } of presets.values()) {
    for (const s of p.similar ?? []) if (!presets.has(s)) err(f, `similar preset "${s}" does not exist`);
  }

  // pools
  const pools = new Set();
  for (const f of listJson(path.join(registryRoot, 'pools'))) {
    const pool = readJson(f, errors, rel(f));
    if (!pool || !check('pool', pool, f)) continue;
    if (pools.has(pool.id)) err(f, `duplicate pool id "${pool.id}"`);
    pools.add(pool.id);
    for (const e of pool.presets) {
      if (!presets.has(e.preset)) err(f, `pool preset "${e.preset}" does not exist`);
      if (!(e.weight > 0)) err(f, `pool weight for "${e.preset}" must be > 0`);
    }
  }
  return errors;
}

// ---- CLI ------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const registryRoot = path.resolve(process.argv[2] ?? 'registry');
  const repoRoot = path.resolve(process.argv[3] ?? process.cwd());
  if (!existsSync(registryRoot) || !statSync(registryRoot).isDirectory()) {
    console.error(`registry root not found: ${registryRoot}`);
    process.exit(1);
  }
  const errors = validateRegistry(registryRoot, repoRoot);
  if (errors.length) {
    for (const e of errors) console.error(`${e.file}: ${e.message}`);
    console.error(`FAIL: ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log('OK: registry valid');
}
