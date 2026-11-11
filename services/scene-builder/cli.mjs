// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder command line (SB1 + SB2, D339). The entry point the later SB3 (build scenes) and SB4 (restyle the
// studio) call, besides the readReference() function in read.mjs.
//
//   node services/scene-builder/cli.mjs read <image-or-video> [--frames N] [--long-side PX] [--data-dir DIR]
//
// Prints the typed read (data/schemas/reference-read.schema.json) as JSON on stdout. Reads the file only; it writes
// nothing and never changes a scene. Behind the feature flag `scene-builder` (off by default): with the flag off it
// says so and exits 2. --data-dir picks the folder whose flags.local.json is read (the usual CLI order otherwise).
// Exit codes: 0 done, 1 bad arguments or the file could not be read, 2 the flag is off.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { readReference } from './read.mjs';

export const FLAG = 'scene-builder';
const USAGE = 'usage: cli.mjs read <image-or-video> [--frames N] [--long-side PX] [--data-dir DIR]';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--frames' || a === '--long-side' || a === '--data-dir') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

/** Returns the exit code. deps: { flagsOn?(dataDir) -> bool } for tests. */
export async function main(argv, out = (s) => process.stdout.write(`${s}\n`), err = (s) => console.error(s), deps = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { err(`scene-builder: ${e.message}\n${USAGE}`); return 1; }
  if (args._[0] !== 'read' || args._.length !== 2) { err(USAGE); return 1; }
  const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
  const frames = num('frames', 8), longSide = num('long-side', 960);
  if (!Number.isInteger(frames) || !Number.isInteger(longSide)) { err('scene-builder: --frames and --long-side must be whole numbers'); return 1; }
  let on;
  try {
    const dir = resolveCliDataDir({ dataDir: args['data-dir'] }).dir;
    on = deps.flagsOn ? deps.flagsOn(dir) : createFlags({ dataDir: dir }).isOn(FLAG);
  } catch (e) { err(`scene-builder: ${e.message}`); return 1; }
  if (!on) { err(`scene-builder: the ${FLAG} feature flag is off (switch it on in Settings > Advanced or the control page)`); return 2; }
  try {
    const r = await readReference(args._[1], { frames, longSide });
    out(JSON.stringify(r, null, 2));
    return 0;
  } catch (e) { err(`scene-builder: ${e.message}`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
