// SPDX-License-Identifier: GPL-3.0-or-later
// legacy/ integrity check against legacy.manifest.sha256.
// Usage: node tools/legacy-verify.mjs [--write] [legacyDir] [manifestPath]
//   legacyDir     default "legacy"
//   manifestPath  default "legacy.manifest.sha256"
//   --write       regenerate the manifest (only after a user-approved change)
// Manifest line: "<sha256>  <size>  <path>", path relative to legacyDir with forward slashes.
// legacy/README.md is explicitly skipped (never hashed, never reported as drift): it is
// Ujwalam-authored metadata (rename notes, zip snapshot SHA-256), not reference content.
// Exit code 1 on any added, missing or changed file.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED = new Set(['README.md']);

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

export function buildManifest(legacyDir) {
  return listFiles(legacyDir)
    .filter((rel) => !EXCLUDED.has(rel))
    .sort()
    .map((rel) => {
      const data = readFileSync(path.join(legacyDir, rel));
      return { rel, size: data.length, sha: createHash('sha256').update(data).digest('hex') };
    });
}

export function formatManifest(entries) {
  return entries.map((e) => `${e.sha}  ${e.size}  ${e.rel}`).join('\n') + '\n';
}

export function parseManifest(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) {2}(\d+) {2}(.+)$/.exec(line);
    if (!m) throw new Error(`bad manifest line: ${line}`);
    map.set(m[3], { sha: m[1], size: Number(m[2]) });
  }
  return map;
}

export function verify(legacyDir, manifestPath) {
  const errors = [];
  if (!existsSync(legacyDir)) return [`missing legacy folder: ${legacyDir}`];
  if (!existsSync(manifestPath)) return [`missing manifest: ${manifestPath}`];
  const expected = parseManifest(readFileSync(manifestPath, 'utf8'));
  const actual = new Map(buildManifest(legacyDir).map((e) => [e.rel, e]));
  for (const [rel, exp] of expected) {
    const act = actual.get(rel);
    if (!act) errors.push(`missing: ${rel}`);
    else if (act.sha !== exp.sha || act.size !== exp.size) errors.push(`changed: ${rel}`);
  }
  for (const rel of actual.keys()) if (!expected.has(rel)) errors.push(`added: ${rel}`);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const [legacyDir = 'legacy', manifestPath = 'legacy.manifest.sha256'] = args.filter((a) => a !== '--write');
  if (write) {
    const entries = buildManifest(legacyDir);
    writeFileSync(manifestPath, formatManifest(entries));
    console.log(`wrote ${manifestPath}: ${entries.length} files`);
  } else {
    const errors = verify(legacyDir, manifestPath);
    if (errors.length) {
      for (const e of errors) console.error(`FAIL ${e}`);
      process.exit(1);
    }
    console.log(`OK: legacy matches ${manifestPath}`);
  }
}
