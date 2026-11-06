// SPDX-License-Identifier: GPL-3.0-or-later
// Device role binding for scene builds (Alpha 0). Pure: no device is listed, opened or created here.
//   matchRoles({ list, presets, overrides, roles }) -> { bound: { role: binding }, unavailable: [{ role, reason }] }
// list      the host's devices.list result ({ devices: [{ kind, name, path, obsId }] }); the caller lists only with
//           --allow-devices (D38).
// presets   registry device presets (registry/presets/device-*.json); each may carry params.match =
//           { roles: [role], projectKind, listKind, nameContains }. nameContains is a case-insensitive substring
//           of the devices.list name (UNVERIFIED until seen in a real devices.list run).
// overrides profile devices.roles ({ role: { path } | { name } }, data/profile.local.json; schema
//           data/profile.schema.json). An override replaces the preset match for that role.
// Never guesses: no match, more than one match, or a device already taken by another role leaves the role
// unbound with a reason. An "<angle-bracket>" placeholder override counts as not set.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ROLES = Object.freeze({
  'game-capture': { listKinds: ['video'], projectKinds: ['capture-card', 'camera'], defaultProjectKind: 'capture-card' },
  facecam: { listKinds: ['video'], projectKinds: ['camera'], defaultProjectKind: 'camera' },
  mic: { listKinds: ['audio-input'], projectKinds: ['microphone'], defaultProjectKind: 'microphone' },
});

const isPlaceholder = (s) => typeof s === 'string' && /^<[^<>]*>$/.test(s);
const lower = (s) => String(s ?? '').toLowerCase();

/** Device presets with match data, from a registry presets dir (device-*.json). */
export function loadDevicePresets(dir) {
  const out = [];
  for (const n of readdirSync(dir).filter((f) => /^device-.*\.json$/.test(f)).sort()) {
    const p = JSON.parse(readFileSync(path.join(dir, n), 'utf8'));
    if (p.function === 'capture-devices' && p.params?.match) out.push(p);
  }
  return out;
}

/** Checks the shape of profile.devices.roles (same rules as data/profile.schema.json). Returns problems. */
export function overrideProblems(overrides) {
  if (overrides == null) return [];
  if (typeof overrides !== 'object' || Array.isArray(overrides)) return ['devices.roles must be an object'];
  const out = [];
  for (const [role, b] of Object.entries(overrides)) {
    if (!Object.hasOwn(ROLES, role)) { out.push(`devices.roles: unknown role "${role}"`); continue; }
    const keys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : null;
    if (!keys || keys.length !== 1 || !['path', 'name'].includes(keys[0]) || typeof b[keys[0]] !== 'string' || !b[keys[0]]) {
      out.push(`devices.roles.${role} must be { "path": "..." } or { "name": "..." }`);
    }
  }
  return out;
}

export function matchRoles({ list, presets = [], overrides = {}, roles = Object.keys(ROLES) } = {}) {
  const entries = Array.isArray(list?.devices) ? list.devices : [];
  const bound = {};
  const unavailable = [];
  const taken = new Map(); // entry -> role
  for (const role of roles) {
    const spec = ROLES[role];
    if (!spec) { unavailable.push({ role, reason: 'unknown role' }); continue; }
    const fits = entries.filter((e) => spec.listKinds.includes(e.kind));
    const ov = overrides?.[role];
    const ovKey = ov && (typeof ov.path === 'string' ? 'path' : typeof ov.name === 'string' ? 'name' : null);
    let hits; // [{ entry, preset|null, by }]
    if (ovKey && !isPlaceholder(ov[ovKey])) {
      const want = ov[ovKey];
      const m = ovKey === 'path' ? fits.filter((e) => lower(e.path) === lower(want) || lower(e.obsId) === lower(want)) : fits.filter((e) => e.name === want);
      hits = m.map((entry) => ({ entry, preset: null, by: `override-${ovKey}` }));
      if (!hits.length) { unavailable.push({ role, reason: `the ${ovKey} override in data/profile.local.json matches no connected device` }); continue; }
      if (hits.length > 1) { unavailable.push({ role, reason: `the ${ovKey} override matches ${hits.length} connected devices; use the path` }); continue; }
    } else {
      hits = [];
      for (const p of presets) {
        const m = p.params.match;
        if (!Array.isArray(m.roles) || !m.roles.includes(role) || typeof m.nameContains !== 'string' || !m.nameContains) continue;
        if (m.listKind && !spec.listKinds.includes(m.listKind)) continue;
        for (const e of fits) if ((!m.listKind || e.kind === m.listKind) && lower(e.name).includes(lower(m.nameContains))) hits.push({ entry: e, preset: p, by: 'preset' });
      }
      if (!hits.length) { unavailable.push({ role, reason: `no connected device matches the registry device presets for "${role}"` }); continue; }
      if (hits.length > 1) {
        unavailable.push({ role, reason: `${hits.length} connected devices match "${role}"; set devices.roles.${role} in data/profile.local.json` });
        continue;
      }
    }
    const h = hits[0];
    if (taken.has(h.entry)) { unavailable.push({ role, reason: `the matching device is already bound to "${taken.get(h.entry)}"` }); continue; }
    taken.set(h.entry, role);
    const pk = h.preset?.params.match.projectKind;
    bound[role] = {
      entry: h.entry,
      preset: h.preset?.id ?? null,
      by: h.by,
      projectKind: spec.projectKinds.includes(pk) ? pk : spec.defaultProjectKind,
      // Capture format the preset asks for (params.format { width, height, fps }); null = device default.
      // Layer crops are in source pixels, so a device that opens at another size would show a stretched picture.
      format: formatOf(h.preset?.params?.format),
    };
  }
  return { bound, unavailable };
}

/** A preset's params.format, or null when absent or out of range (same limits as the project schema). */
export function formatOf(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const ok = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!ok(f.width, 16, 8192) || !ok(f.height, 16, 8192) || (f.fps !== undefined && !ok(f.fps, 1, 240))) return null;
  return f.fps === undefined ? { width: f.width, height: f.height } : { width: f.width, height: f.height, fps: f.fps };
}
