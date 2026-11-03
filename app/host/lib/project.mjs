// SPDX-License-Identifier: GPL-2.0-or-later
// Project v1 into the host. services/project/validate.mjs is the authority: an invalid document is refused here and
// never reaches the host. The host then re-checks what it consumes (app/host/src/model.cpp) and lists what it
// cannot build (devices, browser, missing files) instead of guessing.
//   loadIntoHost(client, project, { bases, skipUnavailable })  -> project.load result
//   planInHost(client, project, { bases })                      -> project.plan result (dry run, creates nothing)
//   loadFileIntoHost(client, file, opts)                        -> reads, migrates and validates with
//                                                                  services/project/store.mjs, then loads
// bases: { data, media, overlays, profile } -> absolute directories that pathRefs resolve against. Callers pass
// them (from config or the profile); nothing here builds a path from the environment.
// Overlay browser layers (source.overlay): when the project has any, the host's overlay server ports are read with
// overlay.status and each layer gets http://127.0.0.1:<static>/overlays/<rel>?<layer query>&<feedQuery(feed, scope)>
// (services/overlay-server). Scope is display for the folders in data/overlays/feed-scopes.json (D72), else effects;
// the host adds one relay page (relayScope: display if any layer needs it). No token is ever part of a URL.
// overlays: false skips this (overlay layers are then listed as unavailable by the host).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { feedQuery } from '../../../services/overlay-server/index.mjs';
import { validateProject } from '../../../services/project/validate.mjs';
import { loadProject } from '../../../services/project/store.mjs';
import { REPO_ROOT } from './config.mjs';

export const FEED_SCOPES_FILE = path.join(REPO_ROOT, 'data', 'overlays', 'feed-scopes.json');

export class ProjectRefused extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ProjectRefused';
    this.errors = errors;
  }
}

function checkBases(bases) {
  if (bases == null) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(bases)) {
    if (!['data', 'media', 'overlays', 'profile'].includes(k)) throw new TypeError(`unknown pathRef base "${k}"`);
    if (typeof v !== 'string' || !path.isAbsolute(v)) throw new TypeError(`base "${k}" must be an absolute directory`);
    out[k] = path.resolve(v);
  }
  return out;
}

export function validateOrThrow(project) {
  const v = validateProject(project);
  if (!v.ok) throw new ProjectRefused(`project failed validation (${v.errors.length} error(s)); not sent to the host`, v.errors);
  return project;
}

function overlayLayers(project) {
  const out = [];
  for (const sc of project.scenes ?? []) {
    for (const l of sc.layers ?? []) if (l.type === 'browser' && typeof l.source?.overlay === 'string') out.push(l);
  }
  return out;
}

/** Page URLs for the project's overlay layers on the host's overlay server.
 *  ports: { staticPort, feedPort } (overlay.status). Returns { browserUrls: { layerId: url }, relayScope }. */
export function overlayUrls(project, ports, { scopesFile = FEED_SCOPES_FILE } = {}) {
  const { staticPort, feedPort } = ports ?? {};
  if (!Number.isInteger(staticPort) || staticPort < 1 || staticPort > 65535) throw new RangeError('bad overlay static port');
  const scopes = JSON.parse(readFileSync(scopesFile, 'utf8'));
  const display = new Set(scopes.display ?? []);
  const effectPages = scopes.effectPages ?? {}; // folder -> effect name: chat-fired plays pass the guards (D204)
  const byId = new Map((project.overlays ?? []).map((o) => [o.id, o]));
  const browserUrls = {};
  let relayScope = '';
  for (const l of overlayLayers(project)) {
    const ov = byId.get(l.source.overlay);
    if (!ov || ov.file?.base !== 'overlays' || typeof ov.file.rel !== 'string') continue; // the host lists it
    const segs = ov.file.rel.split(/[\/]/);
    const scope = display.has(segs[0]) ? 'display' : 'effects';
    if (scope === 'display' || !relayScope) relayScope = scope;
    const q = typeof l.source.query === 'string' && l.source.query ? l.source.query + '&' : '';
    browserUrls[l.id] = `http://127.0.0.1:${staticPort}/overlays/${segs.map(encodeURIComponent).join('/')}?${q}${feedQuery(feedPort, scope, scope === 'effects' && Object.hasOwn(effectPages, segs[0]) ? effectPages[segs[0]] : '')}`;
  }
  return { browserUrls, relayScope };
}

async function params(client, project, opts = {}) {
  const p = { project: validateOrThrow(project) };
  const bases = checkBases(opts.bases);
  if (bases) p.bases = bases;
  if (opts.skipUnavailable) p.skipUnavailable = true;
  if (opts.overlays !== false && overlayLayers(project).length) {
    const st = await client.call('overlay.status');
    if (st.staticPort && st.feedPort) {
      const { browserUrls, relayScope } = overlayUrls(project, st, opts);
      p.browserUrls = browserUrls;
      if (relayScope) p.relayScope = relayScope;
    }
  }
  return p;
}

export async function loadIntoHost(client, project, opts = {}) {
  return client.call('project.load', await params(client, project, opts));
}

export async function planInHost(client, project, opts = {}) {
  return client.call('project.plan', await params(client, project, opts));
}

export async function loadFileIntoHost(client, file, opts = {}) {
  const { project } = loadProject(file); // migrate + validate (throws ProjectError with the validator's errors)
  return loadIntoHost(client, project, opts);
}
