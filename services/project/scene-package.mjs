// SPDX-License-Identifier: GPL-3.0-or-later
// Scene package import (build plan 4.7 "Isolated import", D341). A package (data/schemas/scene-package.schema.json)
// holds one scene-layout-preset per canvas; the import adds them as ONE new namespaced scene (H layers carry H
// placements, V layers V placements, as the host shows one active scene on every canvas) through the existing preset
// loader (scene-preset.mjs). It never changes an existing scene, layer, device, overlay entry or setting:
//   - devices are linked by reference (bindings.roles: role -> existing device id) and existing layers through
//     `link` layers (bindings.links: role -> existing layer id, shown as a duplicate); nothing is created for them;
//   - a binding whose id is not in the project becomes a transparent placeholder and is listed, never re-guessed;
//   - before/after hash: the existing state (the whole input project) must hash the same as the result with the new
//     scene and the overlay entries it added taken out; the input object itself must be unchanged too;
//   - dry run by default; applying is a guarded transaction (applyScenePackageFile below): refused while the host or
//     event core of the project's data folder runs, compare-and-swap against the exact bytes loaded, temp file +
//     rename, an after-save check, and a restore of those loaded bytes only while the file is still ours.
//
//   planScenePackage(project, pkg, opts) -> { project, diff }        pure, the dry run
//   applyScenePackageFile(file, pkg, { dryRun = true }) -> { diff, saved }

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { loadProject, newId, parseProject, validateProject } from './index.mjs';
import { loadScenePreset, mergeCanvasScenes } from './scene-preset.mjs';

export const PACKAGE_FORMAT = 'ujwalam-scene-package';
export const PACKAGE_VERSION = 1;
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const IMPORTER = 'scene-package';

export class ScenePackageError extends Error {
  constructor(message, details) { super(message); this.name = 'ScenePackageError'; if (details) this.details = details; }
}

/** Problems with a package's shape (plain words; [] when it can be imported). */
export function packageProblems(pkg) {
  const p = [];
  if (!pkg || typeof pkg !== 'object') return ['package must be an object'];
  if (pkg.format !== PACKAGE_FORMAT) p.push(`format must be "${PACKAGE_FORMAT}"`);
  if (pkg.version !== PACKAGE_VERSION) p.push(`version must be ${PACKAGE_VERSION}`);
  if (typeof pkg.id !== 'string' || !ID_RE.test(pkg.id)) p.push('id must be a short lowercase id');
  if (typeof pkg.name !== 'string' || !pkg.name.trim() || pkg.name.length > 100) p.push('name must be 1..100 characters');
  if (!Array.isArray(pkg.presets) || pkg.presets.length < 1 || pkg.presets.length > 2) p.push('presets must hold one or two scene presets');
  else {
    const canvases = pkg.presets.map((x) => x?.params?.canvas);
    if (pkg.presets.some((x) => x?.function !== 'scene-layout-preset')) p.push('every preset must be a scene-layout-preset');
    if (canvases.some((c) => c !== 'h' && c !== 'v') || new Set(canvases).size !== canvases.length) p.push('one preset per canvas (h, v)');
  }
  const b = pkg.bindings;
  if (!b || typeof b !== 'object' || typeof b.links !== 'object' || typeof b.roles !== 'object' || !b.links || !b.roles) p.push('bindings must hold links and roles');
  return p;
}

const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v));
/** sha256 of a project's canonical JSON (key order does not matter, array order does). */
export const stateHash = (project) => createHash('sha256').update(canon(project)).digest('hex');

/** The existing state inside a result: the result minus the scenes and overlay entries the import added. */
export function withoutAdded(project, { scenes = [], overlays = [] }) {
  const out = structuredClone(project);
  out.scenes = out.scenes.filter((s) => !scenes.includes(s.id));
  out.overlays = out.overlays.filter((o) => !overlays.includes(o.id));
  return out;
}

function uniqueName(project, name) {
  const used = new Set(project.scenes.map((s) => s.name));
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) if (!used.has(`${name} (${n})`)) return `${name} (${n})`;
}

/** The dry run: the project with the package's scene added, and the diff the user sees before anything is written. */
export function planScenePackage(project, pkg, { idFn = newId, flags = {} } = {}) {
  const bad = packageProblems(pkg);
  if (bad.length) throw new ScenePackageError(`not an importable scene package: ${bad[0]}`, bad);
  const v0 = validateProject(project);
  if (!v0.ok) throw new ScenePackageError('the project does not validate; nothing was imported', v0.errors.slice(0, 10));
  const before = stateHash(project);

  // bindings by reference only: an id that is not in the project is dropped here, so its layers become placeholders
  const layerIds = new Set(project.scenes.flatMap((s) => s.layers.map((l) => l.id)));
  const deviceIds = new Set(project.devices.map((d) => d.id));
  const links = {}, roles = {}, lost = [];
  for (const [role, id] of Object.entries(pkg.bindings.links)) { if (layerIds.has(id)) links[role] = id; else lost.push({ role, id, what: 'layer' }); }
  for (const [role, id] of Object.entries(pkg.bindings.roles)) { if (deviceIds.has(id)) roles[role] = id; else lost.push({ role, id, what: 'device' }); }

  const name = uniqueName(project, pkg.name);
  let out = project;
  const sceneOf = {};
  const unbound = [];
  const addedOverlays = [];
  const layerKeys = {};
  for (const preset of [...pkg.presets].sort((a, b) => a.params.canvas.localeCompare(b.params.canvas))) {
    const r = loadScenePreset(out, preset, { roles, links, idFn, flags, sceneName: name });
    out = r.project;
    sceneOf[preset.params.canvas] = r.sceneId;
    unbound.push(...r.unbound.map((role) => `${preset.params.canvas}:${role}`));
    addedOverlays.push(...r.addedOverlays);
    layerKeys[preset.params.canvas] = r.layerIds;
  }
  let sceneId = sceneOf.h ?? sceneOf.v;
  if (sceneOf.h && sceneOf.v) out = mergeCanvasScenes(out, sceneOf.h, sceneOf.v).project;
  const scene = out.scenes.find((s) => s.id === sceneId);
  scene.origin = { importer: IMPORTER, id: pkg.id };

  const v = validateProject(out);
  if (!v.ok) throw new ScenePackageError('the result does not validate; nothing was imported', v.errors.slice(0, 10));
  const after = stateHash(withoutAdded(out, { scenes: [sceneId], overlays: addedOverlays }));
  const untouched = stateHash(project);
  if (after !== before || untouched !== before) throw new ScenePackageError('the import would change existing state; nothing was imported');

  const byId = new Map(project.scenes.flatMap((s) => s.layers.map((l) => [l.id, l])));
  const keyOf = new Map(Object.entries(layerKeys).flatMap(([c, m]) => Object.entries(m).map(([k, id]) => [id, `${c}:${k}`])));
  const presetLayer = new Map(pkg.presets.flatMap((pr) => pr.params.layers.map((l) => [`${pr.params.canvas}:${l.key}`, l])));
  const layers = scene.layers.map((l) => {
    const canvas = Object.keys(l.placements)[0];
    const pl = l.placements[canvas];
    const key = keyOf.get(l.id);
    const src = presetLayer.get(key) ?? {};
    const row = { canvas, key: key?.split(':')[1] ?? l.id, id: l.id, type: l.type, name: l.name, rect: { x: pl.x, y: pl.y, width: pl.width, height: pl.height } };
    if (pl.crop) row.crop = pl.crop;
    if (l.type === 'duplicate') { const t = byId.get(l.source.layer); row.shows = t ? { layer: t.id, name: t.name, existing: true } : { layer: l.source.layer, existing: false }; }
    if (l.type === 'capture') row.shows = { device: l.source.device, existing: deviceIds.has(l.source.device) };
    if (l.type === 'browser') row.shows = { overlay: l.source.overlay, existing: !addedOverlays.includes(l.source.overlay) };
    if (src.slot) row.slot = src.slot;
    if (l.type === 'color' && /00$/i.test(l.source.color)) row.placeholder = src.placeholder ?? 'its source is not in the project';
    return row;
  });
  const placeholders = [
    ...(pkg.placeholders ?? []),
    ...lost.map((x) => ({ role: x.role, reason: `the bound ${x.what} ${x.id} is not in this project` })),
  ];
  return {
    project: out,
    diff: {
      package: { id: pkg.id, name: pkg.name },
      adds: {
        scenes: [{ id: sceneId, name, canvases: Object.keys(sceneOf).sort(), layers: scene.layers.length }],
        layers,
        overlays: out.overlays.filter((o) => addedOverlays.includes(o.id)).map((o) => ({ id: o.id, rel: o.file.rel })),
      },
      changes: [],
      removes: [],
      devicesCreated: 0,
      placeholders,
      unbound,
      notCarried: pkg.notCarried ?? [],
      warnings: pkg.warnings ?? [],
      existingState: { before, after, unchanged: after === before },
    },
  };
}

/** Plain-text diff for a terminal. */
export function diffText(diff, { dryRun = true } = {}) {
  const lines = [];
  const s = diff.adds.scenes[0];
  lines.push(`${dryRun ? 'Dry run: nothing written.' : 'Applied.'} Adds 1 scene "${s.name}" (${s.canvases.join(' + ').toUpperCase()}, ${s.layers} layers). Changes 0, removes 0, new devices 0.`);
  for (const l of diff.adds.layers) {
    const r = l.rect, at = `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    const what = l.placeholder ? `PLACEHOLDER (${l.placeholder})`
      : l.shows?.layer ? `shows existing layer "${l.shows.name ?? l.shows.layer}"`
        : l.shows?.device ? `existing device ${l.shows.device}`
          : l.shows?.overlay ? `overlay ${l.shows.overlay}${l.shows.existing ? ' (existing)' : ' (new entry)'}` : l.type;
    lines.push(`  + ${l.canvas.toUpperCase()} ${l.key.padEnd(11)} ${at.padEnd(22)} ${what}${l.slot ? `  [${l.slot.from}, c ${l.slot.confidence}]` : ''}`);
  }
  for (const o of diff.adds.overlays) lines.push(`  + overlay entry ${o.id} (${o.rel})`);
  for (const p of diff.placeholders) lines.push(`  ! placeholder ${p.canvas ? `${p.canvas.toUpperCase()} ` : ''}${p.role}: ${p.reason}`);
  for (const n of diff.notCarried) lines.push(`  - not carried to ${n.canvas.toUpperCase()}: ${n.count} ${n.role} (${n.reason})`);
  for (const w of diff.warnings) lines.push(`  ! ${w}`);
  lines.push(`  existing state ${diff.existingState.unchanged ? 'unchanged' : 'CHANGED'} (sha256 ${diff.existingState.before.slice(0, 16)})`);
  return lines.join('\n');
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Markers of a running studio: the launcher's host discovery file and the event core's api.json, both
// <dataDir>/<name> with { pid }, where the project is <dataDir>/projects/<id>.project.json (studio-ui/launch.mjs,
// event-core/api/discovery.mjs). The project store has no lock of its own. A marker whose pid is gone is stale.
export const OPEN_MARKERS = ['host.json', 'api.json'];
const pidRuns = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function openBy(file, isRunning = pidRuns) {
  const dataDir = path.dirname(path.dirname(path.resolve(file)));
  for (const name of OPEN_MARKERS) {
    let pid;
    try { pid = JSON.parse(readFileSync(path.join(dataDir, name), 'utf8')).pid; } catch { continue; }
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) return { marker: name, pid };
  }
  return null;
}

// Temp file in the same folder (fsynced), then rename over the target. The temp name starts with
// "<file>.tmp-" so store.mjs cleanTemps() removes a leftover.
function writeAtomic(file, bytes, beforeRename) {
  const tmp = `${file}.tmp-sb-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx');
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    beforeRename?.();
    renameSync(tmp, file);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Dry run (default) or apply to a project file, as one guarded transaction:
 *   1. refused while the studio has the project's data folder open (openBy: a live pid in host.json or api.json);
 *      apply needs the studio closed, a dry run does not;
 *   2. the exact bytes are read once; the plan is made from them (a file that loads only from its .bak, or needs a
 *      migration, is refused);
 *   3. compare-and-swap: right before the rename the file on disk must still hash as those bytes, so a studio save
 *      in between is never overwritten (the import is refused instead); the previous bytes go to <file>.bak first,
 *      as store.mjs does;
 *   4. after-save check (reload, existing-state hash, the new scene there); a throw counts as a failure;
 *   5. on a failure the loaded bytes are put back through temp + rename, but only while the file still holds the
 *      bytes this import wrote; a file someone else wrote since is left as it is.
 *  opts.isRunning(pid) and opts.hooks.afterWrite(file) exist for tests. */
export function applyScenePackageFile(file, pkg, { dryRun = true, idFn = newId, flags = {}, isRunning = pidRuns, hooks = {} } = {}) {
  let loadedBytes;
  try { loadedBytes = readFileSync(file); } catch (e) { throw new ScenePackageError(`cannot read the project file: ${e.code || e.message}`); }
  let loaded;
  try { loaded = parseProject(loadedBytes.toString('utf8')); } catch (e) {
    let bak = false;
    try { bak = Boolean(loadProject(file).recoveredFrom); } catch { /* neither loads */ }
    if (bak) throw new ScenePackageError('the project loaded only from its backup; fix it before importing');
    throw new ScenePackageError(`the project file does not load: ${e.message}`);
  }
  if (loaded.migrated.length) throw new ScenePackageError('the project file needs a migration first (open it in the studio once); nothing was imported');
  if (!dryRun) {
    const open = openBy(file, isRunning);
    if (open) throw new ScenePackageError(`the studio has this project open (${open.marker}, pid ${open.pid}); close the studio, then apply again (a dry run works while it runs)`);
  }
  const { project, diff } = planScenePackage(loaded.project, pkg, { idFn, flags });
  if (dryRun) return { diff, saved: false };
  const v = validateProject(project);
  if (!v.ok) throw new ScenePackageError('refusing to save an invalid project', v.errors.slice(0, 10));
  const loadedHash = sha(loadedBytes);
  const written = Buffer.from(`${JSON.stringify(project, null, 2)}
`, 'utf8');
  writeAtomic(file, written, () => {
    let now;
    try { now = readFileSync(file); } catch (e) { throw new ScenePackageError(`cannot re-read the project file: ${e.code || e.message}`); }
    if (sha(now) !== loadedHash) throw new ScenePackageError('the project file changed on disk since it was loaded (a studio save?); nothing was imported, run the import again');
    copyFileSync(file, `${file}.bak`);
  });

  const sceneId = diff.adds.scenes[0].id;
  let ok = false;
  try {
    hooks.afterWrite?.(file);
    const check = parseProject(readFileSync(file, 'utf8')).project;
    ok = stateHash(withoutAdded(check, { scenes: [sceneId], overlays: diff.adds.overlays.map((o) => o.id) })) === diff.existingState.before
      && check.scenes.some((s) => s.id === sceneId);
  } catch { ok = false; }
  if (ok) return { diff, saved: true };
  let restored = false;
  try {
    if (sha(readFileSync(file)) === sha(written)) {
      writeAtomic(file, loadedBytes, () => { if (sha(readFileSync(file)) !== sha(written)) throw new Error('changed'); });
      restored = true;
    }
  } catch { restored = false; }
  if (restored) throw new ScenePackageError('the saved project did not pass the after-save check; the previous file was put back');
  throw new ScenePackageError('the saved project did not pass the after-save check, and the file was changed by another writer; it was left as it is');
}
