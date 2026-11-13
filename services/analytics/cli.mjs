// SPDX-License-Identifier: GPL-3.0-or-later
// AN1 Growth data CLI (D371, flag growth). Read only towards YouTube; writes only <data>/analytics/analytics.db.
//   node services/analytics/cli.mjs fetch [--force] [--data-dir <dir>]   read the numbers of every posted video
//   node services/analytics/cli.mjs show [--json] [--data-dir <dir>]     list them (latest, at 24 h, at 7 d)
// Sign-in (with the statistics permission) is `node services/posting/cli.mjs youtube signin` with the growth flag on.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirNote, resolveCliDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { createYoutubeAuth } from '../posting/oauth.mjs';
import { DB_NAME, GROWTH_FLAG, collect, openStore, summary } from './index.mjs';

export const EXIT_FLAG_OFF = 3;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } else out._.push(a);
  }
  return out;
}

const fmt = (s, k) => (s?.analytics?.[k] ?? s?.data?.[k] ?? '-');
const line = (label, s) => (s ? `${label} views ${fmt(s, 'views')}, avg viewed ${s.analytics?.averageViewPercentage ?? '-'} %, likes ${fmt(s, 'likes')}, shares ${s.analytics?.shares ?? '-'}, subs +${s.analytics?.subscribersGained ?? '-'}` : `${label} -`);

export async function main(argv, out = (s) => console.log(s), err = (s) => console.error(s), deps = {}) {
  const a = parseArgs(argv);
  const r = resolveCliDataDir({ dataDir: typeof a['data-dir'] === 'string' ? a['data-dir'] : undefined });
  if (r.source !== 'option') out(`growth: ${dataDirNote(r)}`);
  const dataDir = r.dir;
  if (!createFlags({ dataDir }).isOn(GROWTH_FLAG)) { err(`growth: the '${GROWTH_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
  const sub = a._[0];
  try {
    if (sub === 'fetch') {
      const auth = (deps.createYoutubeAuth ?? createYoutubeAuth)({ browserOpen: async () => { throw new Error('sign-in runs from: node services/posting/cli.mjs youtube signin'); } });
      const res = await collect({ dataDir, auth, fetchImpl: deps.fetchImpl ?? fetch, now: deps.now, force: a.force === true });
      if (res.skipped) { out(`growth: fetched less than an hour ago (${res.lastFetchAt}); use --force to read again`); return 0; }
      out(`growth: ${res.videos} posted video(s), ${res.public} public, ${res.snapshots} snapshot(s) stored` +
        (res.analyticsMissing ? `, ${res.analyticsMissing} without statistics yet (YouTube fills them a day or two late)` : ''));
      return 0;
    }
    if (sub === 'show') {
      const store = openStore(path.join(dataDir, DB_NAME));
      try {
        const rows = summary(store);
        if (a.json === true) { out(JSON.stringify(rows, null, 2)); return 0; }
        if (!rows.length) { out('growth: no posted videos stored yet (run: node services/analytics/cli.mjs fetch)'); return 0; }
        for (const v of rows) {
          out(`${v.videoId} ${v.kind ?? '-'} ${v.privacy ?? '-'}${v.publicAt ? ` since ${v.publicAt}` : ''}`);
          out(`  ${line('24 h:', v.at24h)}`);
          out(`  ${line('7 d: ', v.at7d)}`);
          out(`  ${line('now: ', v.latest)}`);
        }
        return 0;
      } finally { store.close(); }
    }
    err('usage: node services/analytics/cli.mjs fetch [--force] | show [--json]');
    return 2;
  } catch (e) {
    if (e?.code === 'analytics-scope-missing') { err('growth: reading statistics is not allowed yet -- with the growth flag on run: node services/posting/cli.mjs youtube signin'); return 1; }
    if (e?.code === 'oauth-no-client') { err('growth: no YouTube OAuth client set yet (see docs/plan/2026-11-12-growth-setup-notes.md)'); return 1; }
    if (e?.code === 'oauth-reauth-needed') { err('growth: not signed in -- run: node services/posting/cli.mjs youtube signin'); return 1; }
    err(`growth: ${e?.message ?? 'error'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
