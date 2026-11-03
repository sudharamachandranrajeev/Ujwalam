// SPDX-License-Identifier: GPL-2.0-or-later
// Project model entry point (v1 F1/F2). Schema: data/schemas/project.schema.json.

import { randomBytes } from 'node:crypto';

export { PROJECT_VERSION, ID_RE, validateProject, relPathProblem } from './validate.mjs';
export { MIGRATIONS, migrate } from './migrate.mjs';
export { ProjectError, projectFile, parseProject, loadProject, saveProject, cleanTemps, resolvePathRef } from './store.mjs';

// Stable id: <prefix>-<8 hex>. The prefix must start with a lowercase letter.
/** File extensions loaded as still images; any other local file is a media (video) layer. */
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

export function newId(prefix) {
  const p = String(prefix).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  if (!/^[a-z]/.test(p)) throw new TypeError('prefix must start with a lowercase letter');
  return `${p}-${randomBytes(4).toString('hex')}`;
}

// A valid empty project: H 1920x1080 and V 1080x1920 at the given fps, one scene, one audio track.
export function createProject({ name = 'Untitled', fps = 60, id } = {}) {
  const sceneId = newId('scene');
  return {
    version: 1,
    id: id || newId('project'),
    name,
    activeScene: sceneId,
    canvases: [
      { id: 'h', width: 1920, height: 1080, fps },
      { id: 'v', width: 1080, height: 1920, fps },
    ],
    devices: [],
    scenes: [{ id: sceneId, name: 'Scene 1', layers: [] }],
    audio: { tracks: [{ id: 'track1', name: 'Track 1' }], sources: [] },
    outputs: [],
    overlays: [],
  };
}
