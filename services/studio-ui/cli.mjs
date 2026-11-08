// SPDX-License-Identifier: GPL-3.0-or-later
// Studio UI server entry. Usage: node services/studio-ui/cli.mjs serve [--port N] [--data-dir DIR] [--fake-host] [--feedback-dir DIR] [--project FILE]
// The launch key comes from UJWALAM_UI_LAUNCH_KEY (set by launch.mjs); without it a random one is made and the UI
// cannot be logged into (useful only for tests). Backend tokens come from the environment or the data dir files; they
// are never printed and never sent to the page.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../event-core/config.mjs';
import { createCoreClient, createFakeBots, createHostRouter } from './backends.mjs';
import { createProjectSync } from './project-sync.mjs';
import { readProfile, streamAssetsDir } from './alpha.mjs';
import { createStudioServer } from './server.mjs';
import { PARENT_PIPE_ENV, watchParent } from '../common/parent-pipe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI_ROOT = path.resolve(HERE, '..', '..', 'ui');

/** A control line from the launcher on this server's stdin pipe (pure; tested). Only one exists: `rearm <64 hex>`, a new
 *  one-time login key for a studio window the launcher reopens after a crash (2026-11-08). Anything else: null. */
export function controlLine(line) {
  const m = /^rearm ([0-9a-f]{64})$/.exec(String(line).trim());
  return m ? { rearm: m[1] } : null;
}

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
  // --feedback-dir: the folder the host's feedback hotkey writes (launch.mjs passes the same one); default <repo>/feedback.
  const feedbackDir = typeof args['feedback-dir'] === 'string' ? path.resolve(args['feedback-dir']) : undefined;
  // --profile / --release: for the Report button only (links.issues_url, version). launch.mjs passes the same files as the diag bundle.
  const profileFile = typeof args.profile === 'string' ? path.resolve(args.profile) : undefined;
  const releaseFile = typeof args.release === 'string' ? path.resolve(args.release) : undefined;
  // --project: the project file the host loaded; layer edits are autosaved into it (P5b, project-sync.mjs).
  const projectSync = typeof args.project === 'string' ? createProjectSync({ file: path.resolve(args.project), log: (m) => out(`[studio-ui] ${m}`) }) : null;
  // D241: the stream assets folder for image/video layers (the same one launch.mjs gives the host as base "media").
  const assetsDir = projectSync ? streamAssetsDir(profileFile ? readProfile(profileFile) : {}) : null;
  const srv = createStudioServer({ uiRoot: UI_ROOT, core, host, launchKey, dataDir, feedbackDir, profileFile, releaseFile, projectSync, assetsDir, ...(args['fake-host'] === true ? { bots: createFakeBots() } : {}), port: args.port === undefined ? 0 : Number(args.port) });
  const { port } = await srv.listen();
  out(`[studio-ui] listening on http://127.0.0.1:${port}/ (no token printed)`);
  if (host.describe().kind === 'fake') out('[studio-ui] BLOCKED-ON-HOST: no libobs host found, using the in-memory fake backend');
  if (env[PARENT_PIPE_ENV] === '1') {
    // The parent pipe (D234) also carries the launcher's control lines; nobody else can write to it.
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const c = controlLine(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (c?.rearm && srv.rearmLaunchKey(c.rearm)) out('[studio-ui] new one-time login key armed (studio window reopened)');
      }
      if (buf.length > 4096) buf = '';
    });
  }
  // watchParent: the launcher died (even by a hard kill): stop like on Ctrl-C (D234)
  await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); watchParent(resolve); });
  await srv.close();
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('cli.mjs') && process.argv[1].includes('studio-ui')) {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] === 'serve') process.exit(await serve(args));
  else { console.log('usage: node services/studio-ui/cli.mjs serve [--port N] [--data-dir DIR] [--fake-host] [--feedback-dir DIR] [--profile FILE] [--release FILE] [--project FILE]'); process.exit(2); }
}
