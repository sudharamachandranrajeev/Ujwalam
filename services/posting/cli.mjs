// SPDX-License-Identifier: GPL-3.0-or-later
// P16a packager CLI. Behind the feature flag `posting` (off by default; exit 3 while off). Local files only.
//   node services/posting/cli.mjs package --run <clip run folder> [--data-dir DIR] [--profile FILE] [--ffmpeg FILE] [--targets a,b]
// Writes <run>/posts/<clipId>/<target>/ and the ledger <data-dir>/posting/ledger.json. Prints counts only (no text).
// The data dir is --data-dir, else paths.event_core_data from data/profile.local.json (same as the studio).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { LEDGER_NAME, POSTING_FLAG, PostingError, createLedger, createPostStore, loadLimits, packageRun } from './index.mjs';
import { createYoutubeAuth } from './oauth.mjs';
import { uploadVideo, UploadError } from './youtube.mjs';
import { HostClient } from '../../app/host/lib/client.mjs';
import { resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXIT_FLAG_OFF = 3;

/** Opens a URL in the system's default browser. Windows only (this project targets Windows); 'start' with an
 *  empty title arg avoids cmd treating a URL with '&' as its own title. No shell injection risk: the URL comes
 *  from authUrl() (our own query-string builder), never from user-typed text. */
function defaultBrowserOpen(url) {
  return new Promise((resolve, reject) => {
    const p = spawn('cmd', ['/c', 'start', '', url], { windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`could not open a browser (exit ${code})`))));
  });
}

/** Live-refusal check for `youtube upload`: asks the running host if any stream sink is active. No discovery
 *  file (host not running) means nothing is live -- safe to upload. Any other failure is NOT swallowed: an
 *  upload must never proceed on a guess about whether a stream is live. */
async function defaultOutputsStatus() {
  const cfg = resolveHostConfig({});
  if (!existsSync(cfg.discovery)) return { sinks: [] };
  const client = HostClient.fromDiscovery(cfg.discovery, process.env.UJWALAM_HOST_TOKEN || undefined);
  return client.call('outputs.status');
}


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
  if (a._[0] === 'youtube') return youtubeMain(a, out, err, deps);
  if (a._[0] !== 'package' || typeof a.run !== 'string') {
    err('usage: node services/posting/cli.mjs package --run <clip run folder> [--data-dir DIR] [--profile FILE] [--ffmpeg FILE] [--targets a,b]\n       node services/posting/cli.mjs youtube signin|status|signout\n       node services/posting/cli.mjs youtube upload --id <post id> [--data-dir DIR]');
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

/** `youtube signin|status|signout|upload`. Always behind the posting flag -- same gate as `package`. */
async function youtubeMain(a, out, err, deps) {
  const dataDir = resolveDataDir({ dataDir: typeof a['data-dir'] === 'string' ? a['data-dir'] : undefined });
  if (!createFlags({ dataDir }).isOn(POSTING_FLAG)) { err(`posting: the '${POSTING_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
  const auth = (deps.createYoutubeAuth ?? createYoutubeAuth)({ browserOpen: deps.browserOpen ?? defaultBrowserOpen });
  const sub = a._[1];
  try {
    if (sub === 'signin') { const r = await auth.signIn(); out(`youtube: signed in (scope: ${r.scope})`); return 0; }
    if (sub === 'status') { const s = await auth.status(); out(`youtube: signed in: ${s.signedIn}, OAuth client set: ${s.hasClient}`); return 0; }
    if (sub === 'signout') { await auth.signOut(); out('youtube: signed out'); return 0; }
    if (sub === 'upload') {
      if (typeof a.id !== 'string') { err('usage: node services/posting/cli.mjs youtube upload --id <post id> [--data-dir DIR]'); return 2; }
      const ledgerFile = path.join(dataDir, 'posting', LEDGER_NAME);
      const store = createPostStore({ ledgerFile });
      const dir = store.dir(a.id);
      if (!dir) { err(`youtube: unknown post id ${a.id}`); return 1; }
      const post = JSON.parse(readFileSync(path.join(dir, 'post.json'), 'utf8'));
      const video = store.media(a.id, 'video');
      if (!video) { err('youtube: the video file is missing or was tampered with'); return 1; }
      const cover = store.media(a.id, 'cover');
      const accessToken = await auth.accessToken();
      const r = await uploadVideo({
        post, sha256: post.source.sha256, videoPath: video.file, coverPath: cover?.file, accessToken,
        ledger: createLedger(ledgerFile), limits: loadLimits(),
        outputsStatus: deps.outputsStatus ?? defaultOutputsStatus,
        fetchImpl: deps.fetchImpl,
      });
      out(`youtube: uploaded ${a.id} as ${r.videoId}${cover ? ` (cover: ${r.thumbnailOk ? 'ok' : 'failed, video is still up'})` : ''}`);
      return 0;
    }
    err('usage: node services/posting/cli.mjs youtube signin|status|signout|upload --id <post id>');
    return 2;
  } catch (e) {
    if (e?.code === 'oauth-no-client') { err('youtube: no OAuth client set yet (see docs/plan/2026-11-03-p16b-youtube-private-upload-plan.md: "Needs from the user")'); return 1; }
    if (e?.code === 'oauth-reauth-needed') { err('youtube: not signed in (or sign-in expired) -- run: node services/posting/cli.mjs youtube signin'); return 1; }
    if (e instanceof UploadError) { err(`youtube: ${e.message}`); return 1; }
    err(`youtube: ${e?.message ?? 'error'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
