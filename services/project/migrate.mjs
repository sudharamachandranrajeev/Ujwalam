// SPDX-License-Identifier: GPL-3.0-or-later
// Project migrations keyed on the document version. MIGRATIONS[n] turns a version n document into n+1 and must
// not mutate its input. Version 0 is the pre-release shape (one shared transform per layer, one canvas);
// it is kept so the migration hook has a tested path before the format ever changes in the wild.

import { PROJECT_VERSION } from './validate.mjs';

export const MIGRATIONS = {
  // v0 -> v1: layer.transform + layer.hidden become per-canvas placements; scene.sources become layers;
  // a single `canvas` becomes the H and V canvases; audio gets one default track.
  0(doc) {
    const base = doc.canvas || { width: 1920, height: 1080, fps: 60 };
    const canvases = [
      { id: 'h', width: base.width, height: base.height, fps: base.fps },
      { id: 'v', width: base.height, height: base.width, fps: base.fps },
    ];
    const scenes = (doc.scenes || []).map((s) => ({
      id: s.id,
      name: s.name,
      layers: (s.sources || s.layers || []).map((l) => {
        const t = l.transform || { x: 0, y: 0, width: base.width, height: base.height };
        const placement = { visible: !l.hidden, x: t.x, y: t.y, width: t.width, height: t.height };
        return { id: l.id, type: l.type, name: l.name, source: l.source, placements: { h: placement } };
      }),
    }));
    return {
      version: 1,
      id: doc.id,
      name: doc.name,
      canvases,
      devices: doc.devices || [],
      scenes,
      audio: doc.audio || { tracks: [{ id: 'track1', name: 'Track 1' }], sources: [] },
      outputs: doc.outputs || [],
      overlays: doc.overlays || [],
    };
  },
};

// Returns { doc, migrated: [from versions] }. Throws RangeError for a missing, future or unknown version.
export function migrate(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new RangeError('project must be an object');
  let doc = input;
  const migrated = [];
  if (!Number.isInteger(doc.version) || doc.version < 0) throw new RangeError('project has no valid version');
  if (doc.version > PROJECT_VERSION) throw new RangeError(`project version ${doc.version} is newer than this build (${PROJECT_VERSION})`);
  while (doc.version < PROJECT_VERSION) {
    const step = MIGRATIONS[doc.version];
    if (!step) throw new RangeError(`no migration from version ${doc.version}`);
    const from = doc.version;
    doc = step(structuredClone(doc));
    if (doc.version !== from + 1) throw new RangeError(`migration ${from} did not advance the version`);
    migrated.push(from);
  }
  return { doc, migrated };
}
