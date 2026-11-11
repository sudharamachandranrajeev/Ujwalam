// SPDX-License-Identifier: GPL-3.0-or-later
// LU1 update kinds (D343): each packaged file belongs to one part; release.json carries a hash per part, so the update
// queue (services/supervisor/updates.mjs) can tell what a new release changes. Node stdlib only.
//
//   partOf(rel)           -> 'host' | 'studio-window' | 'services' | 'overlay' | 'data' | 'meta'  (package-relative, '/')
//   releaseParts(files)   -> { host: { files, sha256 }, ... } for [{ rel, abs }] (meta files are not a part)
//   changedParts(a, b)    -> part names whose hash differs between two release.json `parts` objects (missing = changed)
//
// host: the host exe, the OBS runtime and the overlay server child (a child of the host, updated with it), plus the
// test-card project the host loads at start. studio-window: the Qt shell and its start stub and icon. services: Node
// services, the control page (ui/, served by the UI server), the tools and host libraries they import. overlay: overlay
// pages, if a release ships any. data: data/ and registry/ (presets, themes, rules, flags).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PART_NAMES = Object.freeze(['host', 'studio-window', 'services', 'overlay', 'data']);

const RULES = [
  [/^(bin|obs)\//, 'host'],
  [/^app\/host\/(overlay|projects)\//, 'host'],
  [/^studio\//, 'studio-window'],
  [/^(ujwalam-start\.exe|ujwalam\.ico)$/, 'studio-window'],
  [/(^|\/)overlays\//, 'overlay'],
  [/^(data|registry)\//, 'data'],
  [/^(services|ui|tools)\//, 'services'],
  [/^app\/(host\/lib|studio\/tools)\//, 'services'],
];

export function partOf(rel) {
  const r = String(rel).replace(/\\/g, '/');
  for (const [re, part] of RULES) if (re.test(r)) return part;
  return 'meta';
}

export function releaseParts(files, read = (abs) => readFileSync(abs)) {
  const by = new Map(PART_NAMES.map((p) => [p, []]));
  for (const f of files) {
    const part = partOf(f.rel);
    if (part === 'meta') continue;
    by.get(part).push(`${f.rel.replace(/\\/g, '/')}\0${createHash('sha256').update(read(f.abs)).digest('hex')}`);
  }
  const out = {};
  for (const [part, lines] of by) {
    lines.sort();
    out[part] = { files: lines.length, sha256: createHash('sha256').update(lines.join('\n')).digest('hex') };
  }
  return out;
}

export function changedParts(a, b) {
  return PART_NAMES.filter((p) => !a?.[p]?.sha256 || a[p].sha256 !== b?.[p]?.sha256);
}
