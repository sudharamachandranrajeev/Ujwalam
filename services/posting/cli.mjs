// SPDX-License-Identifier: GPL-3.0-or-later
// P16a packager CLI. Behind the feature flag `posting` (off by default; exit 3 while off). Local files only.
//   node services/posting/cli.mjs package --run <clip run folder> [--data-dir DIR] [--profile FILE] [--ffmpeg FILE] [--targets a,b]
// Writes <run>/posts/<clipId>/<target>/ and the ledger <data-dir>/posting/ledger.json. Prints counts only (no text).
// The data dir is --data-dir, else paths.event_core_data from data/profile.local.json (same as the studio).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { LEDGER_NAME, POSTING_FLAG, PostingError, packageRun } from './index.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXIT_FLAG_OFF = 3;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } else out._.push(a);
  }
  return out;
}

export async function main(argv, out = (s) => console.log(s), err = (s) => console.error(s)) {
  const a = parseArgs(argv);
  if (a._[0] !== 'package' || typeof a.run !== 'string') {
    err('usage: node services/posting/cli.mjs package --run <clip run folder> [--data-dir DIR] [--profile FILE] [--ffmpeg FILE] [--targets a,b]');
    return 2;
  }
  try {
    const dataDir = resolveDataDir({ dataDir: typeof a['data-dir'] === 'string' ? a['data-dir'] : undefined });
    if (!createFlags({ dataDir }).isOn(POSTING_FLAG)) { err(`posting: the '${POSTING_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
    const profileFile = typeof a.profile === 'string' ? a.profile : path.join(REPO, 'data', 'profile.local.json');
    let profile = {};
    if (existsSync(profileFile)) profile = JSON.parse(readFileSync(profileFile, 'utf8'));
    else out('posting: no local profile; {handles.x} and {links.x} placeholders stay unresolved and are flagged');
    const r = await packageRun({
      runDir: a.run, ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME), profile,
      ffmpeg: typeof a.ffmpeg === 'string' ? a.ffmpeg : undefined,
      targets: typeof a.targets === 'string' ? a.targets.split(',').filter(Boolean) : undefined,
    });
    const why = {};
    for (const s of r.skipped) why[s.reason] = (why[s.reason] ?? 0) + 1;
    const flagged = r.packaged.filter((p) => !p.limitsOk || p.unresolved.length).length;
    out(`posting: packaged ${r.packaged.length} (${flagged} flagged for review), skipped ${r.skipped.length} ${JSON.stringify(why)}`);
    return 0;
  } catch (e) {
    err(`posting: ${e instanceof PostingError ? e.message : (e?.message ?? 'error')}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
