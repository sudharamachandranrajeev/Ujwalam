// SPDX-License-Identifier: GPL-3.0-or-later
// RP5 / AN2 self-learning CLI (D364, D373; flag self-learning). Writes only <data>/learning/mix.json and mix-log.jsonl.
//   node services/learning/mix-cli.mjs show [--json] [--data-dir <dir>]   the mix in effect, cold-start reason, numbers
//   node services/learning/mix-cli.mjs step [--data-dir <dir>]            the weekly change (at most once per week)
//   node services/learning/mix-cli.mjs undo [--data-dir <dir>]            undo the newest change still in effect
//   node services/learning/mix-cli.mjs report [--data-dir <dir>]          the weekly report in plain English
// The numbers come from services/analytics (run `node services/analytics/cli.mjs fetch` first; flag growth).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirNote, resolveCliDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { MIX_FLAG, loadConfig, step, undo, view, weeklyReport } from './mix.mjs';

export const EXIT_FLAG_OFF = 3;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } else out._.push(a);
  }
  return out;
}

export async function main(argv, out = (s) => console.log(s), err = (s) => console.error(s), deps = {}) {
  const a = parseArgs(argv);
  const r = resolveCliDataDir({ dataDir: typeof a['data-dir'] === 'string' ? a['data-dir'] : undefined });
  if (r.source !== 'option') out(`learning: ${dataDirNote(r)}`);
  const dataDir = r.dir;
  if (!(deps.flags ?? createFlags({ dataDir })).isOn(MIX_FLAG)) { err(`learning: the '${MIX_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
  const cfg = deps.cfg ?? loadConfig();
  const io = { dataDir, cfg, rows: deps.rows, posts: deps.posts, now: deps.now ?? Date.now(), hourOf: deps.hourOf };
  try {
    const sub = a._[0];
    if (sub === 'show') {
      const v = await view(io);
      if (a.json === true) { out(JSON.stringify(v, null, 2)); return 0; }
      out(`learning: ${v.status}${v.reason ? ` (${v.reason})` : ''}; in use: ${v.applied ? 'yes' : 'no'}`);
      for (const d of cfg.dimensions) out(`  ${d.label}: ${d.arms.map((x) => `${x} ${Math.round(v.shares[d.id][x] * 100)} %`).join(', ')}`);
      return 0;
    }
    if (sub === 'step') {
      const s = await step({ ...io, seed: typeof a.seed === 'string' ? a.seed : undefined });
      if (s.changed) out('learning: the mix changed (see: report)');
      else if (s.reason === 'too-soon') out(`learning: changed less than a week ago; next change from ${s.nextAt}`);
      else out(`learning: no change: ${s.detail ?? s.reason}`);
      return 0;
    }
    if (sub === 'undo') {
      const u = undo(io);
      out(u.undone ? `learning: undone (the change of ${u.entry.undoes.slice(2)}); the mix is back to what it was before it` : 'learning: nothing to undo');
      return 0;
    }
    if (sub === 'report') { out(weeklyReport(await view(io), cfg)); return 0; }
    err('usage: node services/learning/mix-cli.mjs show [--json] | step | undo | report');
    return 2;
  } catch (e) {
    err(`learning: ${e?.message ?? 'error'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
