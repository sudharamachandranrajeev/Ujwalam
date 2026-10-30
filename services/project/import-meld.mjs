// SPDX-License-Identifier: GPL-2.0-or-later
// Meld Studio session -> Ujwalam project (v1 F1). Reads the on-disk session file ({ version: 1, session: {...} },
// observed in Meld Studio 0.10.7.7 and in the legacy reference backups). Format reference only: no Meld code or
// assets are used. Pure function plus a CLI; the CLI creates a NEW project file and refuses to overwrite one.
//
// Rules: nothing is guessed. A layer kind that has no equivalent in the project model goes to report.skipped
// with a reason and its Meld id. The report never holds names; it holds ids, kinds and counts. The one place
// that holds real paths is report.bases (local use only; do not commit a report).
//
// Usage: node services/project/import-meld.mjs --in <session.json> --out <project.json> [--report <report.json>]
//        [--id <project-id>] [--name <name>] [--fps <n>]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, relPathProblem, saveProject, validateProject } from './index.mjs';

export class ImportError extends Error {
  constructor(message, details = []) { super(message); this.name = 'ImportError'; this.details = details; }
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const KIND_PREFIX = 'MeldStudio/';

// Field mapping status. VERIFIED = checked against the real session file or a legacy reference this session
// (structure and counts); UNVERIFIED = a reading of the value that has not been confirmed in Meld or in a render.
export const MAPPING = {
  'scene.name, scene.id': 'VERIFIED (present on every scene)',
  'verticalScenes[].linkedSceneId -> scenes[].id': 'VERIFIED (all resolve in the real session)',
  'layer kind from meta.sceneObjectSourceName ("MeldStudio/<Kind>")': 'VERIFIED (9 kinds seen)',
  'layer x, y, width, height (final displayed rectangle)': 'VERIFIED against implicit size x scale; UNVERIFIED in a render',
  'layer rotation, visible, opacity, isLocked': 'VERIFIED present; UNVERIFIED in a render',
  'childItems order: index 0 is the TOP layer': 'UNVERIFIED (assumed from the legacy layer map; project z-order is bottom first)',
  'Video device deviceId / displayName / videoCaptureDevices[]': 'VERIFIED present; UNVERIFIED that libobs resolves deviceId',
  'Media source mediaSource (file URL), isLoopPlayback': 'VERIFIED present',
  'Browser url, browserWidth, browserHeight': 'VERIFIED present',
  'Text text, fontFamily, pixelSize, foregroundColor (#AARRGGBB read as #RRGGBBAA)': 'UNVERIFIED (colour byte order assumed Qt style)',
  'audioTracks[].gain -> volumeDb = 20*log10(gain)': 'UNVERIFIED (gain assumed linear amplitude, 1 = 0 dB)',
  'audioTracks[].monitoring true -> monitor-only': 'UNVERIFIED (monitor-and-output not distinguishable)',
  'audioTracks[].outputTracks bitmask -> track ids': 'UNVERIFIED (bit n = track n+1 assumed)',
  'audioTracks[].uniqueId -> device match.deviceId': 'VERIFIED present; UNVERIFIED that libobs resolves it',
  'canvas fps': 'UNVERIFIED (not stored in the session; defaults to the --fps option, 60)',
};

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const mid = (prefix, meldId) => `${prefix}-${sha(meldId).slice(0, 10)}`;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => String(s).slice(0, n);
const label = (s, fallback) => (typeof s === 'string' && s.trim() ? clip(s.trim(), 120) : fallback);

function fileUrlToPath(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'file:' || url.host) return null;
    let p = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p.replace(/\\/g, '/');
  } catch { return null; }
}

// Common directory of a list of file paths (case-insensitive on the drive/segments, original case kept).
function commonDir(paths) {
  if (paths.length === 0) return null;
  const split = paths.map((p) => p.split('/').slice(0, -1));
  let n = Math.min(...split.map((a) => a.length));
  const first = split[0];
  let k = 0;
  while (k < n && split.every((a) => a[k].toLowerCase() === first[k].toLowerCase())) k++;
  return first.slice(0, k).join('/');
}

function relUnder(root, p) {
  const rl = root.split('/').filter(Boolean).length;
  return p.split('/').filter(Boolean).slice(rl).join('/');
}

export function importMeld(input, opts = {}) {
  const fps = opts.fps ?? 60;
  if (!isObj(input)) throw new ImportError('session must be a JSON object');
  if (isObj(input.items) && 'apiVersion' in input) {
    throw new ImportError('this is a Meld API dump (apiVersion/items): it has no device ids or source kinds. Use the session file ({version, session}).');
  }
  if (!isObj(input.session)) throw new ImportError('not a Meld session file: no "session" object');
  if (input.version !== 1) throw new ImportError(`unsupported Meld session version ${input.version} (only 1 has been seen)`);
  const S = input.session;
  if (!Array.isArray(S.scenes)) throw new ImportError('session.scenes is missing');
  const vScenes = Array.isArray(S.verticalScenes) ? S.verticalScenes : [];
  const vEnabled = S.verticalCanvasEnabled === true && vScenes.length > 0;

  const report = {
    importer: 'meld', sessionVersion: input.version, bases: {},
    counts: { scenes: 0, verticalScenesMerged: 0, verticalScenesOnly: 0, layersSeen: 0, layersImported: 0, layersPaired: 0, layersHOnly: 0, layersVOnly: 0, devices: 0, audioSources: 0, overlays: 0 },
    skipped: [], skippedByKind: {}, ignored: {}, warnings: [], mapping: MAPPING,
  };
  const skip = (canvas, scene, layer, kind, reason, detail) => {
    report.skipped.push(detail ? { canvas, scene, layer, kind, reason, detail } : { canvas, scene, layer, kind, reason });
    const k = `${kind}: ${reason}`;
    report.skippedByKind[k] = (report.skippedByKind[k] || 0) + 1;
  };
  const ignore = (what, n = 1) => { report.ignored[what] = (report.ignored[what] || 0) + n; };

  // ---- first pass: classify every top-level layer, collect file paths for base roots
  const mediaPaths = [];
  const overlayFilePaths = [];
  const classify = (l, canvas, sceneId) => {
    report.counts.layersSeen++;
    if (Array.isArray(l.childItems) && l.childItems.length) report.counts.layersSeen += countAll(l.childItems);
    const kind = isObj(l.meta) && typeof l.meta.sceneObjectSourceName === 'string' && l.meta.sceneObjectSourceName.startsWith(KIND_PREFIX)
      ? l.meta.sceneObjectSourceName.slice(KIND_PREFIX.length) : null;
    const id = typeof l.id === 'string' ? l.id : null;
    if (!id) { skip(canvas, sceneId, null, 'unknown', 'layer has no id'); return null; }
    if (!kind) { skip(canvas, sceneId, id, 'unknown', 'no meta.sceneObjectSourceName'); return null; }
    for (const k of ['x', 'y', 'width', 'height']) {
      if (!num(l[k])) { skip(canvas, sceneId, id, kind, `${k} missing or not a number`); return null; }
    }
    if (Math.abs(l.x) > 16384 || Math.abs(l.y) > 16384 || l.width < 0 || l.height < 0 || l.width > 16384 || l.height > 16384) {
      skip(canvas, sceneId, id, kind, 'geometry out of range'); return null;
    }
    const base = { meld: l, id, kind, canvas, sceneId };
    switch (kind) {
      case 'Video device':
        if (typeof l.deviceId !== 'string' || !l.deviceId) { skip(canvas, sceneId, id, kind, 'no deviceId'); return null; }
        return { ...base, type: 'capture', key: `capture|${l.deviceId}` };
      case 'Media source': {
        const p = typeof l.mediaSource === 'string' ? fileUrlToPath(l.mediaSource) : null;
        if (!p) { skip(canvas, sceneId, id, kind, 'media source is not a local file URL'); return null; }
        mediaPaths.push(p);
        const ext = path.extname(p).toLowerCase();
        return { ...base, type: IMAGE_EXT.has(ext) ? 'image' : 'media', filePath: p, key: `file|${p.toLowerCase()}` };
      }
      case 'Browser': {
        if (typeof l.url !== 'string') { skip(canvas, sceneId, id, kind, 'no url'); return null; }
        if (!num(l.browserWidth) || !num(l.browserHeight) || l.browserWidth < 1 || l.browserHeight < 1) { skip(canvas, sceneId, id, kind, 'no browser size'); return null; }
        let url;
        try { url = new URL(l.url); } catch { skip(canvas, sceneId, id, kind, 'unparseable url'); return null; }
        if (url.protocol === 'file:') {
          const p = fileUrlToPath(l.url);
          if (!p) { skip(canvas, sceneId, id, kind, 'file url not local'); return null; }
          overlayFilePaths.push(p);
          return { ...base, type: 'browser', overlayFile: p, query: url.search.replace(/^\?/, ''), key: `url|${l.url}` };
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') { skip(canvas, sceneId, id, kind, `unsupported url scheme ${url.protocol}`); return null; }
        const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
        const m = local && url.pathname.match(/^\/overlays\/(.+)$/);
        if (m) {
          const rel = decodeURIComponent(m[1]);
          if (relPathProblem(rel)) { skip(canvas, sceneId, id, kind, 'overlay path unsafe'); return null; }
          return { ...base, type: 'browser', overlayRel: rel, query: url.search.replace(/^\?/, ''), key: `url|${l.url}` };
        }
        return { ...base, type: 'browser', url: l.url, key: `url|${l.url}` };
      }
      case 'Text':
        if (l.isTextFromFile) { skip(canvas, sceneId, id, kind, 'text comes from a file'); return null; }
        if (typeof l.text !== 'string') { skip(canvas, sceneId, id, kind, 'no text'); return null; }
        return { ...base, type: 'text', key: `text|${l.text}` };
      case 'Widget': skip(canvas, sceneId, id, kind, 'Meld-hosted widget (no equivalent, not copied)'); return null;
      case 'Duplicator':
        if (typeof l.sourceItemId !== 'string' || !l.sourceItemId) { skip(canvas, sceneId, id, kind, 'target-skipped', 'duplicator has no source item'); return null; }
        return { ...base, type: 'duplicate', targetMeldId: l.sourceItemId, key: '' };
      case 'Game capture': skip(canvas, sceneId, id, kind, 'game capture has no device mapping'); return null;
      case 'Display capture': skip(canvas, sceneId, id, kind, 'display capture has no device mapping'); return null;
      case 'Group':
        skip(canvas, sceneId, id, kind, `group not flattened (child coordinate space unverified); ${countAll(l.childItems || [])} child layer(s) not imported`); return null;
      default: skip(canvas, sceneId, id, kind, 'unknown layer kind'); return null;
    }
  };
  const countAll = (items) => items.reduce((n, it) => n + 1 + countAll(it.childItems || []), 0);

  const sceneEntries = [];
  const scenesById = new Map(S.scenes.map((s) => [s.id, s]));
  S.scenes.forEach((sc) => {
    if (!isObj(sc) || typeof sc.id !== 'string') { report.warnings.push('a scene without id was ignored'); return; }
    sceneEntries.push({ h: sc, hLayers: (sc.childItems || []).map((l) => classify(l, 'h', sc.id)), v: null, vLayers: [] });
  });
  const byH = new Map(sceneEntries.map((e) => [e.h.id, e]));
  if (vEnabled) {
    for (const vs of vScenes) {
      if (!isObj(vs) || typeof vs.id !== 'string') { report.warnings.push('a vertical scene without id was ignored'); continue; }
      const entry = typeof vs.linkedSceneId === 'string' ? byH.get(vs.linkedSceneId) : null;
      const vLayers = (vs.childItems || []).map((l) => classify(l, 'v', vs.id));
      if (entry && !entry.v) { entry.v = vs; entry.vLayers = vLayers; report.counts.verticalScenesMerged++; }
      else {
        report.counts.verticalScenesOnly++;
        report.warnings.push('a vertical scene is not linked to a horizontal scene; it was imported as its own scene');
        sceneEntries.push({ h: null, hLayers: [], v: vs, vLayers });
      }
    }
  } else if (vScenes.length) {
    for (const vs of vScenes) for (const l of vs.childItems || []) { report.counts.layersSeen++; skip('v', vs.id, l && l.id, 'vertical-canvas', 'vertical canvas is disabled in the session'); }
  }
  void scenesById;

  // ---- duplicators: keep one only when its target was imported as a real (non-duplicate) layer
  const imported = new Map();
  for (const e of sceneEntries) for (const c of [...e.hLayers, ...e.vLayers]) if (c && c.type !== 'duplicate') imported.set(c.id, c);
  const pairKeyOf = (c) => `${c.type}|${c.key}|${c.meld.name}`;
  for (const e of sceneEntries) {
    for (const side of ['hLayers', 'vLayers']) {
      e[side] = e[side].map((c) => {
        if (!c || c.type !== 'duplicate') return c;
        const target = imported.get(c.targetMeldId);
        if (target) { c.key = `dup|${pairKeyOf(target)}`; return c; }
        const anyDup = [...sceneEntries].some((x) => [...x.hLayers, ...x.vLayers].some((y) => y && y.id === c.targetMeldId && y.type === 'duplicate'));
        skip(c.canvas, c.sceneId, c.id, c.kind, 'target-skipped', anyDup ? 'target is itself a duplicator' : 'target layer was not imported');
        return null;
      });
    }
  }

  // ---- bases: where relative paths point
  const mediaRoot = commonDir(mediaPaths);
  const overlayRoot = commonDir(overlayFilePaths);
  if (mediaRoot !== null) report.bases.media = mediaRoot;
  if (overlayRoot !== null) report.bases.overlays = overlayRoot;
  if (mediaRoot !== null && /^[A-Za-z]:?$/.test(mediaRoot)) report.warnings.push('media files have no common folder below the drive root; media base is the drive root');

  // ---- project skeleton
  const project = createProject({ id: opts.id || 'meld-import', name: opts.name || 'Imported from Meld', fps });
  project.scenes = [];
  project.activeScene = undefined;
  if (!vEnabled) project.canvases = project.canvases.filter((c) => c.id === 'h');
  project.origin = { importer: 'meld', id: 'session' };

  // ---- devices
  const devices = new Map();
  const devEntries = Array.isArray(S.videoCaptureDevices && S.videoCaptureDevices.devices) ? S.videoCaptureDevices.devices : [];
  const deviceFor = (meldDeviceId, displayName) => {
    if (devices.has(meldDeviceId)) return devices.get(meldDeviceId).id;
    const e = devEntries.find((d) => d && (d.deviceId === meldDeviceId || d.directShowDeviceId === meldDeviceId));
    const dev = {
      id: mid('dev', meldDeviceId),
      kind: 'camera',
      name: label(displayName || (e && e.displayName), 'Video device'),
      match: { deviceId: clip(meldDeviceId, 512) },
      origin: { importer: 'meld', id: clip(meldDeviceId, 128) },
    };
    if (e && typeof e.directShowDeviceId === 'string' && e.directShowDeviceId && e.directShowDeviceId !== meldDeviceId) dev.match.directShowId = clip(e.directShowDeviceId, 512);
    if (e && isObj(e.frameSize) && num(e.frameSize.width) && num(e.frameSize.height) && e.frameSize.width >= 16 && e.frameSize.height >= 16) {
      dev.format = { width: Math.round(e.frameSize.width), height: Math.round(e.frameSize.height) };
      if (num(e.frameRate) && e.frameRate >= 1) dev.format.fps = Math.round(e.frameRate);
    } else if (!e) report.warnings.push('a video device layer refers to a device that is not in videoCaptureDevices (kept by id and name only)');
    devices.set(meldDeviceId, dev);
    return dev.id;
  };

  // ---- overlays
  const overlays = new Map();
  const overlayFor = (rel) => {
    if (!overlays.has(rel)) overlays.set(rel, { id: mid('ov', rel), name: label(rel.split('/')[0], 'Overlay'), file: { base: 'overlays', rel } });
    return overlays.get(rel).id;
  };

  // ---- layer building
  const toPlacement = (c) => {
    const l = c.meld;
    const p = { visible: l.visible !== false, x: l.x, y: l.y, width: l.width, height: l.height };
    if (num(l.rotation) && l.rotation !== 0) p.rotation = Math.max(-360, Math.min(360, l.rotation));
    if (num(l.opacity) && l.opacity !== 1) p.opacity = Math.max(0, Math.min(1, l.opacity));
    if (num(l.scaleX) && num(l.scaleY) && (l.scaleX < 0 || l.scaleY < 0)) ignore('flip (negative scale)');
    if (isObj(l.radii) && Object.values(l.radii).some((r) => r)) ignore('rounded corners (radii)');
    if (Array.isArray(l.effects) && l.effects.length) ignore('effects', l.effects.length);
    if (num(l.fitmentMode) && l.fitmentMode !== 0) ignore('fitmentMode other than 0');
    return p;
  };
  const sourceFor = (c) => {
    const l = c.meld;
    switch (c.type) {
      case 'capture': return { device: deviceFor(l.deviceId, l.displayName) };
      case 'image': return { file: { base: 'media', rel: relUnder(mediaRoot, c.filePath) } };
      case 'media': return { file: { base: 'media', rel: relUnder(mediaRoot, c.filePath) }, loop: l.isLoopPlayback === true };
      case 'browser': {
        const s = { width: Math.round(l.browserWidth), height: Math.round(l.browserHeight) };
        if (c.url) s.url = c.url;
        else {
          const rel = c.overlayRel ?? relUnder(overlayRoot, c.overlayFile);
          s.overlay = overlayFor(rel);
          if (c.query) s.query = clip(c.query, 1024);
        }
        return s;
      }
      case 'duplicate': return { layer: null }; // filled in once every layer id is known
      case 'text': {
        const s = { text: clip(l.text, 2000) };
        if (typeof l.fontFamily === 'string' && l.fontFamily) s.font = clip(l.fontFamily, 120);
        if (num(l.pixelSize) && l.pixelSize >= 1 && l.pixelSize <= 2000) s.size = l.pixelSize;
        const m = typeof l.foregroundColor === 'string' && l.foregroundColor.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{6})$/);
        if (m) s.color = `#${m[2]}${m[1]}`.toLowerCase();
        return s;
      }
      default: throw new Error('unreachable');
    }
  };

  const layerAudio = []; // { layerId, track, meldLayerId }
  const layerOfMeld = new Map(); // Meld layer id -> project layer id (both H and V ids of a pair)
  const buildScene = (entry) => {
    const hItems = entry.hLayers.filter(Boolean);
    const vItems = entry.vLayers.filter(Boolean);
    // Meld childItems index 0 is taken as the top layer; project order is bottom first.
    const hBottom = [...hItems].reverse();
    const vBottom = [...vItems].reverse();
    // pair H and V layers: n-th occurrence of the same key pairs with the n-th occurrence
    const pairKey = (c) => `${c.type}|${c.key}|${c.meld.name}`;
    const vPool = new Map();
    for (const v of vBottom) { const k = pairKey(v); if (!vPool.has(k)) vPool.set(k, []); vPool.get(k).push(v); }
    const merged = [];
    const vToMerged = new Map();
    for (const h of hBottom) {
      const q = vPool.get(pairKey(h));
      const v = q && q.length ? q.shift() : null;
      const m = { h, v, order: merged.length };
      merged.push(m);
      if (v) vToMerged.set(v, m);
    }
    // V-only layers go right after the nearest earlier V layer already merged, else at the bottom
    for (let i = 0; i < vBottom.length; i++) {
      const v = vBottom[i];
      if (vToMerged.has(v)) continue;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const prev = vToMerged.get(vBottom[j]);
        if (prev) { at = merged.indexOf(prev) + 1; break; }
      }
      const m = { h: null, v };
      merged.splice(at, 0, m);
      vToMerged.set(v, m);
    }
    // order conflict: paired layers whose relative order differs between H and V
    const pairs = merged.filter((m) => m.h && m.v);
    const hPos = new Map(hBottom.map((c, i) => [c, i]));
    const vPos = new Map(vBottom.map((c, i) => [c, i]));
    let conflicts = 0;
    for (let a = 0; a < pairs.length; a++) for (let b = a + 1; b < pairs.length; b++) {
      if ((hPos.get(pairs[a].h) - hPos.get(pairs[b].h)) * (vPos.get(pairs[a].v) - vPos.get(pairs[b].v)) < 0) conflicts++;
    }
    if (conflicts) report.warnings.push(`${conflicts} layer pair(s) have a different stacking order on V; H order was kept`);

    const layers = [];
    for (const m of merged) {
      const primary = m.h || m.v;
      const placements = {};
      if (m.h) placements.h = toPlacement(m.h);
      if (m.v) placements.v = toPlacement(m.v);
      const layer = {
        id: mid('layer', primary.id),
        type: primary.type,
        name: label(primary.meld.name, 'Layer'),
        source: sourceFor(primary),
        placements,
        origin: { importer: 'meld', id: clip(m.h && m.v ? `${m.h.id}+${m.v.id}` : primary.id, 128) },
      };
      if ((m.h && m.h.meld.isLocked) || (m.v && m.v.meld.isLocked)) layer.locked = true;
      layers.push(layer);
      for (const c of [m.h, m.v]) if (c) layerOfMeld.set(c.id, layer.id);
      report.counts.layersImported += (m.h ? 1 : 0) + (m.v ? 1 : 0);
      if (m.h && m.v) report.counts.layersPaired++; else if (m.h) report.counts.layersHOnly++; else report.counts.layersVOnly++;
      for (const c of [m.h, m.v]) {
        const at = c && c.meld.audioTrack;
        if (at && at.enabled === true && c.type === 'duplicate') ignore('duplicate layer audio (same source)');
        else if (at && at.enabled === true) layerAudio.push({ layerId: layer.id, at, meldId: c.id, canvas: c.canvas });
      }
    }
    return layers;
  };

  const usedSceneIds = new Set();
  for (const entry of sceneEntries) {
    const primary = entry.h || entry.v;
    let id = mid('scene', primary.id);
    if (usedSceneIds.has(id)) id = mid('scene', `${primary.id}#${usedSceneIds.size}`);
    usedSceneIds.add(id);
    const layers = buildScene(entry);
    const scene = { id, name: label(primary.name, 'Scene'), layers, origin: { importer: 'meld', id: clip(entry.h && entry.v ? `${entry.h.id}+${entry.v.id}` : primary.id, 128) } };
    entry.projectId = id;
    project.scenes.push(scene);
    report.counts.scenes++;
  }
  project.activeScene = (sceneEntries.find((e) => e.h && e.h.id === S.currentScene) || sceneEntries[0] || {}).projectId;
  if (project.activeScene === undefined) delete project.activeScene;
  if (project.scenes.length === 0) project.scenes.push({ id: mid('scene', 'empty'), name: 'Scene 1', layers: [] });
  if (project.activeScene === undefined) project.activeScene = project.scenes[0].id;

  // duplicate layers point at the project layer of their Meld target
  const targetOf = new Map();
  for (const e of sceneEntries) for (const c of [...e.hLayers, ...e.vLayers]) if (c && c.type === 'duplicate') targetOf.set(c.id, c.targetMeldId);
  for (const sc of project.scenes) {
    for (const l of sc.layers) {
      if (l.type !== 'duplicate') continue;
      const metaIds = String(l.origin.id).split('+');
      const ts = [...new Set(metaIds.map((id) => layerOfMeld.get(targetOf.get(id))).filter(Boolean))];
      if (ts.length > 1) report.warnings.push('a duplicate layer has different targets on H and V; the H target was kept for both');
      l.source = { layer: ts[0] };
    }
  }

  // ---- audio
  const toDb = (g) => (g > 0 ? Math.max(-100, Math.min(12, 20 * Math.log10(g))) : -100);
  const usedTracks = new Set();
  const maskTracks = (mask) => {
    const out = [];
    if (!Number.isInteger(mask) || mask < 0) return out;
    for (let b = 0; b < 6; b++) if (mask & (1 << b)) out.push(`track${b + 1}`);
    return out;
  };
  const sources = [];
  for (const t of Array.isArray(S.audioTracks) ? S.audioTracks : []) {
    if (!isObj(t) || typeof t.id !== 'string') continue;
    if (t.type !== 1 || typeof t.deviceName !== 'string' || typeof t.uniqueId !== 'string') {
      skip('audio', null, t.id, 'audio track', 'not a device audio track (application or unknown audio has no device mapping)');
      continue;
    }
    const devId = mid('dev', `audio|${t.uniqueId}`);
    if (!devices.has(`audio|${t.uniqueId}`)) {
      devices.set(`audio|${t.uniqueId}`, {
        id: devId, kind: t.isInputDevice ? 'microphone' : 'audio-output', name: label(t.deviceName, 'Audio device'),
        match: { deviceId: clip(t.uniqueId, 512), name: clip(t.deviceName, 256) }, origin: { importer: 'meld', id: clip(t.id, 128) },
      });
    }
    const tracks = maskTracks(t.outputTracks);
    tracks.forEach((x) => usedTracks.add(x));
    sources.push({
      id: mid('aud', t.id), name: label(t.name, 'Audio'), device: devId, volumeDb: num(t.gain) ? toDb(t.gain) : 0,
      muted: t.muted === true, monitoring: t.monitoring === true ? 'monitor-only' : 'off', tracks,
      origin: { importer: 'meld', id: clip(t.id, 128) },
    });
  }
  const seenLayerAudio = new Set();
  for (const la of layerAudio) {
    if (seenLayerAudio.has(la.layerId)) continue; // paired H/V layers carry equal audio; first one wins
    seenLayerAudio.add(la.layerId);
    const tracks = maskTracks(la.at.outputTracks);
    tracks.forEach((x) => usedTracks.add(x));
    sources.push({
      id: mid('aud', la.at.id || la.meldId), name: 'Layer audio', layer: la.layerId, volumeDb: num(la.at.gain) ? toDb(la.at.gain) : 0,
      muted: la.at.muted === true, monitoring: la.at.monitoring === true ? 'monitor-only' : 'off', tracks,
      origin: { importer: 'meld', id: clip(la.meldId, 128) },
    });
  }
  const ids = new Set();
  project.audio.sources = sources.filter((s) => (ids.has(s.id) ? false : (ids.add(s.id), true)));
  const maxTrack = Math.max(1, ...[...usedTracks].map((x) => Number(x.slice(5))));
  project.audio.tracks = Array.from({ length: maxTrack }, (_, i) => ({ id: `track${i + 1}`, name: `Track ${i + 1}` }));
  report.counts.audioSources = project.audio.sources.length;

  project.devices = [...devices.values()];
  project.overlays = [...overlays.values()];
  report.counts.devices = project.devices.length;
  report.counts.overlays = project.overlays.length;

  const v = validateProject(project);
  if (!v.ok) throw new ImportError(`imported project failed validation (${v.errors.length} error(s))`, v.errors);
  return { project, report };
}

// ---- CLI
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const k = a.slice(2);
    if (!['in', 'out', 'report', 'id', 'name', 'fps'].includes(k)) throw new Error(`unknown option: ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    o[k] = argv[++i];
  }
  return o;
}

export function runCli(argv, io = { log: console.log, err: console.error }) {
  let o;
  try { o = parseArgs(argv); } catch (e) { io.err(`import-meld: ${e.message}`); return 2; }
  if (!o.in || !o.out) { io.err('usage: import-meld --in <session.json> --out <project.json> [--report <report.json>] [--id <id>] [--name <name>] [--fps <n>]'); return 2; }
  for (const f of [o.out, o.report].filter(Boolean)) {
    if (fs.existsSync(f)) { io.err('import-meld: refusing to overwrite an existing file (choose a new path)'); return 1; }
  }
  let session;
  try { session = JSON.parse(fs.readFileSync(o.in, 'utf8')); } catch (e) { io.err(`import-meld: cannot read the session: ${e.code || e.message}`); return 1; }
  let r;
  try {
    r = importMeld(session, { id: o.id, name: o.name, fps: o.fps ? Number(o.fps) : undefined });
  } catch (e) {
    io.err(`import-meld: ${e.message}`);
    for (const d of (e.details || []).slice(0, 10)) io.err(`  ${d.path}: ${d.message}`);
    return 1;
  }
  saveProject(o.out, r.project);
  if (o.report) fs.writeFileSync(o.report, JSON.stringify(r.report, null, 2) + '\n', { flag: 'wx' });
  const c = r.report.counts;
  io.log(`import-meld: ${c.scenes} scene(s), ${c.layersImported} layer placement(s) imported (${c.layersPaired} H+V pairs), ${r.report.skipped.length} skipped, ${c.devices} device(s), ${c.audioSources} audio source(s), ${c.overlays} overlay(s)`);
  for (const [k, n] of Object.entries(r.report.skippedByKind)) io.log(`  skipped ${n} x ${k}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
