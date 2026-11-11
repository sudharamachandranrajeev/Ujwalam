// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder command line (SB1 + SB2, D339; SB3, D341). Besides readReference() in read.mjs and buildPackage() in
// build.mjs, the entry point for the studio's later scene builder UI and SB4 (restyle the studio).
//
//   node services/scene-builder/cli.mjs read <image-or-video> [--frames N] [--long-side PX] [--data-dir DIR]
//   node services/scene-builder/cli.mjs build <image-or-video> --project FILE [--bind ROLE=ID]... [--theme ID]
//        [--out PACKAGE.json] [--apply] [--json] [--frames N] [--long-side PX] [--data-dir DIR]
//   node services/scene-builder/cli.mjs import <PACKAGE.json> --project FILE [--apply] [--json] [--data-dir DIR]
//
// read prints the typed read (data/schemas/reference-read.schema.json) as JSON on stdout. It writes nothing.
// build reads the reference, builds a scene package (data/schemas/scene-package.schema.json) for that project and
// prints the dry-run diff: the one new namespaced scene (H + V), each layer, what it links to in the project, every
// placeholder and why, and the existing-state hash. Nothing is written unless --apply is given; --out saves the
// package (it never overwrites a file). import applies (or dry-runs) a saved package the same way.
// --bind ROLE=ID picks the project layer or device for game, camera, chat or alerts when the rules cannot tell.
// --theme ID passes ?theme=ID to the overlays (brand theme tokens); without it the brand's current theme is used.
// --apply adds the scene to the project file (atomic save, .bak kept); existing scenes, layers, devices and settings
// are never changed. A running studio shows the new scene after the project is loaded again.
// Behind the feature flag `scene-builder` (off by default): with the flag off it says so and exits 2. --data-dir
// picks the folder whose flags.local.json is read (the usual CLI order otherwise).
// Exit codes: 0 done, 1 bad arguments or the work failed, 2 the flag is off.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { applyScenePackageFile, diffText, packageProblems } from '../project/scene-package.mjs';
import { loadProject } from '../project/index.mjs';
import { buildPackage } from './build.mjs';
import { readReference } from './read.mjs';

export const FLAG = 'scene-builder';
const USAGE = [
  'usage: cli.mjs read <image-or-video> [--frames N] [--long-side PX] [--data-dir DIR]',
  '       cli.mjs build <image-or-video> --project FILE [--bind ROLE=ID]... [--theme ID] [--out PACKAGE.json] [--apply] [--json]',
  '       cli.mjs import <PACKAGE.json> --project FILE [--apply] [--json]',
].join('\n');
const VALUE = new Set(['--frames', '--long-side', '--data-dir', '--project', '--theme', '--out']);
const SWITCH = new Set(['--apply', '--json']);
const BIND_ROLES = new Set(['game', 'camera', 'chat', 'alerts']);

export function parseArgs(argv) {
  const out = { _: [], bind: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE.has(a) || a === '--bind') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--bind') {
        const m = /^([a-z]+)=([a-z][a-z0-9_-]{0,63})$/.exec(v);
        if (!m || !BIND_ROLES.has(m[1])) throw new Error('--bind needs ROLE=ID with ROLE one of game, camera, chat, alerts');
        out.bind[m[1]] = m[2];
      } else out[a.slice(2)] = v;
    } else if (SWITCH.has(a)) out[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

/** Returns the exit code. deps: { flagsOn?(dataDir) -> bool } for tests. */
export async function main(argv, out = (s) => process.stdout.write(`${s}\n`), err = (s) => console.error(s), deps = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { err(`scene-builder: ${e.message}\n${USAGE}`); return 1; }
  const cmd = args._[0];
  if (!['read', 'build', 'import'].includes(cmd) || args._.length !== 2) { err(USAGE); return 1; }
  if (cmd !== 'read' && !args.project) { err(`scene-builder: ${cmd} needs --project FILE\n${USAGE}`); return 1; }
  if (cmd === 'read' && (args.project || args.apply || args.out || args.theme || args.json || Object.keys(args.bind).length)) { err(`scene-builder: read takes no project options\n${USAGE}`); return 1; }
  if (cmd === 'import' && (args.out || args.theme || args.frames || args['long-side'] || Object.keys(args.bind).length)) { err(`scene-builder: import takes the package as it is\n${USAGE}`); return 1; }
  const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
  const frames = num('frames', 8), longSide = num('long-side', 960);
  if (!Number.isInteger(frames) || !Number.isInteger(longSide)) { err('scene-builder: --frames and --long-side must be whole numbers'); return 1; }
  if (args.out && existsSync(args.out)) { err('scene-builder: --out file already exists; choose a new name'); return 1; }
  let on;
  try {
    const dir = resolveCliDataDir({ dataDir: args['data-dir'] }).dir;
    on = deps.flagsOn ? deps.flagsOn(dir) : createFlags({ dataDir: dir }).isOn(FLAG);
  } catch (e) { err(`scene-builder: ${e.message}`); return 1; }
  if (!on) { err(`scene-builder: the ${FLAG} feature flag is off (switch it on in Settings > Advanced or the control page)`); return 2; }
  try {
    if (cmd === 'read') {
      out(JSON.stringify(await readReference(args._[1], { frames, longSide }), null, 2));
      return 0;
    }
    let pkg;
    if (cmd === 'build') {
      const read = await readReference(args._[1], { frames, longSide });
      const { project } = loadProject(args.project);
      pkg = buildPackage(read, project, { bind: args.bind, theme: args.theme ?? null });
      if (args.out) writeFileSync(args.out, `${JSON.stringify(pkg, null, 2)}\n`, { flag: 'wx' });
    } else {
      pkg = JSON.parse(readFileSync(args._[1], 'utf8'));
      const bad = packageProblems(pkg);
      if (bad.length) { err(`scene-builder: not a scene package: ${bad.join('; ')}`); return 1; }
    }
    const dryRun = !args.apply;
    const { diff } = applyScenePackageFile(args.project, pkg, { dryRun });
    out(args.json ? JSON.stringify({ dryRun, diff }, null, 2) : diffText(diff, { dryRun }));
    return 0;
  } catch (e) { err(`scene-builder: ${e.message}`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
