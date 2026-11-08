// SPDX-License-Identifier: GPL-3.0-or-later
// Alpha 0 project (alpha plan Part A, day 1): <dataDir>/projects/alpha.project.json.
//   prepareAlphaProject({ dataDir, rebuild, build }) -> { file, action: 'loaded' | 'built' | 'rebuilt', moved? }
//     An existing file is used unchanged (a user's edits are never modified). rebuild builds the new project first;
//     only when that succeeds is the old file (and its .bak) moved to <dataDir>/projects/_old/alpha-<stamp>.project.json[.bak]
//     and the new one saved (atomic save, services/project/store.mjs).
//   buildAlphaProject({ presetsDir, profile, bindings, devicesListed }) -> { project, report }
//     createProject (H 1920x1080, V 1080x1920) + the Default H preset + the Default V preset when
//     registry/presets/scene-default-v.json exists (else a warning: the V canvas stays empty). Both presets go into
//     ONE scene (the host shows one active scene on every canvas; H layers carry only H placements, V layers only V).
//     A V capture layer whose device already has an H capture layer becomes a `duplicate` of it (D60), so one
//     device is opened once. Roles come from services/project/device-roles.mjs; unbound roles stay transparent
//     placeholders (scene-preset.mjs, D112). A bound mic becomes an audio source on track 1, the bound game capture
//     layer's own audio too; monitoring off.
//   alphaBases({ profile, overlayRoot }) -> pathRef bases for project.load (profile: image files of the presets;
//     media: the user's stream assets folder, streamAssetsDir, when it exists, D241).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, newId, projectFile, saveProject, validateProject } from '../project/index.mjs';
import { loadScenePreset, ScenePresetError } from '../project/scene-preset.mjs';

export const ALPHA_ID = 'alpha';
export const H_PRESET = 'scene-default-h.json';
export const V_PRESET = 'scene-default-v.json';
const LAYER_ROLES = ['game-capture', 'facecam'];

export const alphaFile = (dataDir) => projectFile(dataDir, ALPHA_ID);
export const stampOf = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

export function readProfile(file) {
  if (!file || !existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Image layers in the presets use base "profile": paths.profile_assets from the local profile when it is an
// absolute directory, else the overlay root (legacy/: overlays/, brand/, kit/). Missing -> no base (the host then
// lists the image layers as unavailable).
export function alphaBases({ profile = {}, overlayRoot, assetsDefault } = {}) {
  const pa = profile?.paths?.profile_assets;
  const dir = typeof pa === 'string' && path.isAbsolute(pa) ? pa : overlayRoot;
  const out = dir && path.isAbsolute(dir) && existsSync(dir) ? { profile: path.resolve(dir) } : {};
  const media = streamAssetsDir(profile, assetsDefault);
  if (media) out.media = media;
  return out;
}

// The user's own stream assets (images, videos; D241): profile paths.stream_assets, else <repo>/data/stream assets
// (gitignored). null when neither is an existing folder.
export const STREAM_ASSETS_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'stream assets');
export function streamAssetsDir(profile, fallback = STREAM_ASSETS_DEFAULT) {
  const p = profile?.paths?.stream_assets;
  for (const d of [typeof p === 'string' && path.isAbsolute(p) ? p : null, fallback]) {
    try { if (d && statSync(d).isDirectory()) return path.resolve(d); } catch { /* try the next */ }
  }
  return null;
}

function mergeInto(project, hSceneId, vSceneId) {
  const out = structuredClone(project);
  const h = out.scenes.find((s) => s.id === hSceneId);
  const v = out.scenes.find((s) => s.id === vSceneId);
  const hCapture = new Map(h.layers.filter((l) => l.type === 'capture').map((l) => [l.source.device, l.id]));
  const duplicated = [];
  const movedTo = new Map(); // V capture layer id -> the H layer it now duplicates
  for (const l of v.layers) {
    if (l.type === 'capture' && hCapture.has(l.source.device)) {
      l.type = 'duplicate';
      l.source = { layer: hCapture.get(l.source.device) };
      duplicated.push(l.id);
      movedTo.set(l.id, l.source.layer);
    }
  }
  for (const l of v.layers) {
    // a V duplicate of a V capture layer (e.g. the blurred game backdrop) points at the real H layer: the host
    // refuses a duplicate of a duplicate
    if (l.type === 'duplicate' && movedTo.has(l.source.layer)) l.source = { layer: movedTo.get(l.source.layer) };
    h.layers.push(l);
  }
  out.scenes = out.scenes.filter((s) => s.id !== vSceneId);
  return { project: out, duplicated };
}

export function buildAlphaProject({ presetsDir, profile = {}, bindings = { bound: {}, unavailable: [] }, devicesListed = false, idFn = newId, flags = {} } = {}) {
  const warnings = [];
  const hFile = path.join(presetsDir, H_PRESET);
  if (!existsSync(hFile)) throw new ScenePresetError(`${H_PRESET} not found in the registry presets`);
  const base = createProject({ name: 'Alpha' });
  // Scene transitions (D239), the Meld session's values (legacy/meld session backups 2026-09-29: sceneTransition 2006 ms,
  // verticalSceneTransition 1000 ms; their stinger effects disabled, so Meld fades). Used only while flag `transitions` is on.
  for (const c of base.canvases) c.transition = { type: 'fade', durationMs: c.id === 'h' ? 2006 : 1000 };
  const emptyScene = base.scenes[0].id;
  base.origin = { importer: 'alpha', id: devicesListed ? 'devices-listed' : 'no-devices' };

  // devices for the bound roles (local file only: names and paths never leave <dataDir>)
  const deviceOf = {};
  for (const [role, b] of Object.entries(bindings.bound ?? {})) {
    const id = idFn('dev');
    const match = { name: String(b.entry.name).slice(0, 256) };
    if (b.entry.path && String(b.entry.path).length <= 512) match.deviceId = b.entry.path;
    const dev = { id, kind: b.projectKind, name: String(b.entry.name || role).slice(0, 120), match, origin: { importer: 'alpha', id: `role/${role}` } };
    if (b.format) dev.format = { ...b.format };
    base.devices.push(dev);
    deviceOf[role] = id;
  }
  const roles = Object.fromEntries(LAYER_ROLES.filter((r) => deviceOf[r]).map((r) => [r, deviceOf[r]]));

  const hPreset = JSON.parse(readFileSync(hFile, 'utf8'));
  const h = loadScenePreset(base, hPreset, { profile, roles, idFn, flags });
  let project = h.project;
  const unbound = h.unbound.map((r) => `h:${r}`);
  const missingAssets = new Set(h.missingAssets);
  let vScene = null;
  let duplicated = [];
  const vFile = path.join(presetsDir, V_PRESET);
  if (existsSync(vFile)) {
    const vPreset = JSON.parse(readFileSync(vFile, 'utf8'));
    if (vPreset?.params?.canvas !== 'v') {
      warnings.push(`${V_PRESET} is not a V canvas preset; the V canvas stays empty`);
    } else {
      const v = loadScenePreset(project, vPreset, { profile, roles, idFn, flags });
      unbound.push(...v.unbound.map((r) => `v:${r}`));
      v.missingAssets.forEach((k) => missingAssets.add(k));
      vScene = v.sceneId;
      ({ project, duplicated } = mergeInto(v.project, h.sceneId, v.sceneId));
    }
  } else {
    warnings.push(`${V_PRESET} not found (registry/presets); the project has the H scene only and the V canvas stays empty`);
  }
  // one scene: drop the empty "Scene 1" from createProject
  project.scenes = project.scenes.filter((s) => s.id !== emptyScene);
  const scene = project.scenes.find((s) => s.id === h.sceneId);
  if (vScene) scene.name = 'Default';
  project.activeScene = scene.id;

  // audio: mic device + the game capture layer's own audio, both on track 1, monitoring off (no echo)
  if (deviceOf.mic) project.audio.sources.push({ id: 'aud-mic', name: 'Mic', device: deviceOf.mic, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['track1'] });
  const game = roles['game-capture'] && h.layerIds.game;
  // Game (Meld layout: the "Track" channel is the card's "HDMI/Line In" input): the card's WASAPI audio input
  // (role game-audio) is the Game channel, CUE on, in the stream mix. It has no video, so libobs monitors it at
  // once; the capture layer's own audio then stays out of the mix (mixers 0, metered only). libobs holds back
  // monitoring of a source with video until its frame is shown, so without that input the layer audio is the Game
  // channel and its CUE is late. Mic: CUE off (no echo of your own voice).
  if (deviceOf['game-audio']) project.audio.sources.push({ id: 'aud-game', name: 'Game', device: deviceOf['game-audio'], volumeDb: 0, muted: false, monitoring: 'monitor-and-output', tracks: ['track1'] });
  else if (game) project.audio.sources.push({ id: 'aud-game', name: 'Game', layer: game, volumeDb: 0, muted: false, monitoring: 'monitor-and-output', tracks: ['track1'] });

  if (missingAssets.size) warnings.push(`profile has no file for ${[...missingAssets].sort().join(', ')}: those layers are transparent placeholders until it is set`);
  const v = validateProject(project);
  if (!v.ok) throw new ScenePresetError('alpha project does not validate', v.errors.slice(0, 10));
  return {
    project,
    report: {
      scene: scene.id,
      vPreset: Boolean(vScene),
      layers: scene.layers.length,
      duplicated: duplicated.length,
      roles: Object.fromEntries(Object.entries(bindings.bound ?? {}).map(([r, b]) => [r, { by: b.by, preset: b.preset }])),
      unavailableRoles: bindings.unavailable ?? [],
      unbound,
      rules: h.rules.length,
      warnings,
    },
  };
}

export async function prepareAlphaProject({ dataDir, rebuild = false, build, now = new Date() }) {
  const file = alphaFile(dataDir);
  if (existsSync(file) && !rebuild) return { file, action: 'loaded' };
  const project = await build(); // a failed build leaves the old file where it is
  let moved = null;
  if (existsSync(file)) {
    const oldDir = path.join(path.dirname(file), '_old');
    mkdirSync(oldDir, { recursive: true });
    moved = path.join(oldDir, `alpha-${stampOf(now)}.project.json`);
    if (existsSync(moved)) throw new Error('an old alpha project with this time stamp already exists; try again');
    renameSync(file, moved);
    if (existsSync(`${file}.bak`)) renameSync(`${file}.bak`, `${moved}.bak`);
  }
  saveProject(file, project);
  return { file, action: moved ? 'rebuilt' : 'built', moved };
}
