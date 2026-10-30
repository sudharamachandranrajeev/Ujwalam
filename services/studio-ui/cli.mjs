// SPDX-License-Identifier: GPL-2.0-or-later
// Studio UI server entry. Usage: node services/studio-ui/cli.mjs serve [--port N] [--data-dir DIR] [--fake-host]
// The launch key comes from UJWALAM_UI_LAUNCH_KEY (set by launch.mjs); without it a random one is made and the UI
// cannot be logged into (useful only for tests). Backend tokens come from the environment or the data dir files; they
// are never printed and never sent to the page.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../event-core/config.mjs';
import { createCoreClient, createHostRouter } from './backends.mjs';
import { createStudioServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI_ROOT = path.resolve(HERE, '..', '..', 'ui');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); out[k] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } else out._.push(a);
  }
  return out;
}

export async function serve(args, env = process.env, out = (s) => console.log(s)) {
  let dataDir = null;
  try { dataDir = resolveDataDir({ dataDir: typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined }); } catch (e) { out(`[studio-ui] no data dir (${e.message}); event core and host discovery files are not available`); }
  const core = createCoreClient({ dataDir, env });
  const host = createHostRouter({ dataDir, env, forceFake: args['fake-host'] === true });
  const launchKey = env.UJWALAM_UI_LAUNCH_KEY && env.UJWALAM_UI_LAUNCH_KEY.length >= 32 ? env.UJWALAM_UI_LAUNCH_KEY : randomBytes(32).toString('hex');
  const srv = createStudioServer({ uiRoot: UI_ROOT, core, host, launchKey, dataDir, port: args.port === undefined ? 0 : Number(args.port) });
  const { port } = await srv.listen();
  out(`[studio-ui] listening on http://127.0.0.1:${port}/ (no token printed)`);
  if (host.describe().kind === 'fake') out('[studio-ui] BLOCKED-ON-HOST: no libobs host found, using the in-memory fake backend');
  await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  await srv.close();
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('cli.mjs') && process.argv[1].includes('studio-ui')) {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] === 'serve') process.exit(await serve(args));
  else { console.log('usage: node services/studio-ui/cli.mjs serve [--port N] [--data-dir DIR] [--fake-host]'); process.exit(2); }
}
