// SPDX-License-Identifier: GPL-3.0-or-later
// P16a packager CLI. Behind the feature flag `posting` (off by default; exit 3 while off). Local files only.
//   node services/posting/cli.mjs package --run <clip run folder> [--data-dir DIR] [--profile FILE] [--ffmpeg FILE] [--targets a,b]
// Writes <run>/posts/<clipId>/<target>/ and the ledger <data-dir>/posting/ledger.json. Prints counts only (no text).
// The data dir is --data-dir, else paths.event_core_data from data/profile.local.json (same as the studio).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDirNote, resolveCliDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { LEDGER_NAME, POSTING_FLAG, PostingError, createPostStore, packageRun } from './index.mjs';
import { createYoutubeAuth } from './oauth.mjs';
import { uploadPost, UploadError } from './youtube.mjs';
import { streamOnly } from './auto-chain.mjs';
import { AUTO_FLAG, AUTO_LOG_NAME, AutoPostError, createAutoLog, describeMode, loadRules, planAuto, runAuto } from './auto-post.mjs';
import { formatPreview, previewRules } from './preview.mjs';
import { HostClient } from '../../app/host/lib/client.mjs';
import { resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXIT_FLAG_OFF = 3;

/** Opens a URL in the system's default browser. Windows only (this project targets Windows). No shell: `cmd /c start`
 *  split the URL at its first '&', so Google got only client_id and refused the sign-in ("Required parameter is
 *  missing: response_type", 2026-11-09). rundll32's URL handler takes the whole URL as one argument. The URL is
 *  also printed, so it can be pasted into a browser by hand. It comes from authUrl() (our own query-string
 *  builder), never from user-typed text. */
export function defaultBrowserOpen(url, { spawnImpl = spawn, log = (s) => console.log(s) } = {}) {
  log(`If no browser opens, paste this into the browser signed in to the channel's Google account:\n${url}`);
  return new Promise((resolve, reject) => {
    const p = spawnImpl('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`could not open a browser (exit ${code})`))));
  });
}

/** Discovery files a running host may have written: the studio's (<event-core data dir>/host.json, where
 *  services/studio-ui/launch.mjs puts it) and the host config's own (app/host/lib/config.mjs, standalone host). */
export function hostDiscoveryCandidates(dataDir, hostCfg = resolveHostConfig({})) {
  const out = [];
  for (const f of [typeof dataDir === 'string' && dataDir ? path.join(dataDir, 'host.json') : null, hostCfg?.discovery]) {
    if (f && !out.some((x) => path.resolve(x).toLowerCase() === path.resolve(f).toLowerCase())) out.push(f);
  }
  return out;
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unknown: treat as running (fail closed)
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Live-refusal check for `youtube upload` and `auto --run`: asks every running host if any sink is active.
 *  No discovery file, or only stale ones (their pid is gone), means no host runs: nothing is live. A running host
 *  whose state cannot be read (no host token in this shell, host not answering) throws, so the caller refuses: an
 *  upload must never proceed on a guess about whether a stream is live. (2026-11-06 stream-day mock run: this used
 *  to look only at the standalone host's discovery file, so a studio session's live outputs read as "nothing live".) */
export function outputsStatusFor(dataDir, { hostCfg, token = process.env.UJWALAM_HOST_TOKEN, alive = pidAlive } = {}) {
  return async () => {
    const sinks = [];
    for (const f of hostDiscoveryCandidates(dataDir, hostCfg ?? resolveHostConfig({}))) {
      if (!existsSync(f)) continue;
      let d;
      try { d = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error('host discovery file unreadable'); }
      if (!alive(d?.pid)) continue;
      const client = HostClient.fromDiscovery(f, token || undefined);
      const st = await client.call('outputs.status');
      sinks.push(...(Array.isArray(st?.sinks) ? st.sinks : [null]));
    }
    return { sinks };
  };
}


function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } else out._.push(a);
  }
  return out;
}

/** The data dir for this run (--data-dir, else the installed app's, else the profile's); says which one it used. */
function cliDataDir(a, out) {
  const r = resolveCliDataDir({ dataDir: typeof a['data-dir'] === 'string' ? a['data-dir'] : undefined });
  if (r.source !== 'option') out(`posting: ${dataDirNote(r)}`); // an explicit --data-dir needs no echo
  return r.dir;
}

export async function main(argv, out = (s) => console.log(s), err = (s) => console.error(s), deps = {}) {
  const a = parseArgs(argv);
  if (a._[0] === 'youtube') return youtubeMain(a, out, err, deps);
  if (a._[0] === 'auto') return autoMain(a, out, err, deps);
  if (a._[0] !== 'package' || typeof a.run !== 'string') {
    err('usage: node services/posting/cli.mjs package --run <clip run folder> [--data-dir DIR] [--profile FILE] [--ffmpeg FILE] [--targets a,b]\n       node services/posting/cli.mjs youtube signin|status|signout\n       node services/posting/cli.mjs youtube upload --id <post id> [--data-dir DIR]\n       node services/posting/cli.mjs auto [--run | --preview [--json]] [--data-dir DIR] [--rules FILE]');
    return 2;
  }
  try {
    const dataDir = cliDataDir(a, out);
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

/** `auto` (dry-run listing, read-only) and `auto --run` (post-stream; needs flags `posting` and `auto-post`).
 *  Review-first stays the default: with no rules, or a flag off, nothing happens. */
async function autoMain(a, out, err, deps) {
  try {
    const dataDir = cliDataDir(a, out);
    const flags = createFlags({ dataDir });
    const flagOn = flags.isOn(POSTING_FLAG) && flags.isOn(AUTO_FLAG);
    const rules = deps.rules ?? loadRules(typeof a.rules === 'string' ? a.rules : undefined);
    const store = createPostStore({ ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME) });
    const logFile = path.join(dataDir, 'posting', AUTO_LOG_NAME);
    const mode = describeMode({ flagOn, rules });
    if (a.preview === true) {
      // Read-only: never opens a browser or auth, never uploads. Live state is read from the local host only (127.0.0.1).
      const profileFile = typeof a.profile === 'string' ? a.profile : path.join(REPO, 'data', 'profile.local.json');
      let profile = {};
      try { if (existsSync(profileFile)) profile = JSON.parse(readFileSync(profileFile, 'utf8')); } catch { /* placeholders stay unresolved and are shown */ }
      const r = await previewRules({
        dataDir, rules, profile, flagOn, log: createAutoLog(logFile).list(), now: deps.now,
        outputsStatus: streamOnly(deps.outputsStatus ?? outputsStatusFor(dataDir)),
      });
      out(a.json === true ? JSON.stringify(r, null, 2) : formatPreview(r));
      return 0;
    }
    if (a.run !== true) {
      const plan = planAuto({ posts: store.list(), rules: rules.rules, autoUpload: rules.autoUpload, log: createAutoLog(logFile).list(), now: (deps.now ?? (() => new Date()))() });
      out(`auto-post (dry run): ${mode.enabled ? 'on' : 'off'} (flags posting+auto-post: ${flagOn}), ${mode.ruleCount} rule(s), autoUpload ${mode.autoUpload}, privacy private`);
      for (const s of plan) out(`  ${s.action} ${s.id} rule ${s.ruleId}: ${s.reason}`);
      return 0;
    }
    if (!flagOn) { err(`auto-post: the '${POSTING_FLAG}' and '${AUTO_FLAG}' feature flags must both be on`); return EXIT_FLAG_OFF; }
    if (!rules.rules.length) { out('auto-post: no rules; nothing to do'); return 0; }
    const auth = rules.autoUpload ? (deps.createYoutubeAuth ?? createYoutubeAuth)({ browserOpen: deps.browserOpen ?? defaultBrowserOpen }) : null;
    // D300: only stream sinks block (a local recording does not); an unreadable state still refuses.
    const outputsStatus = streamOnly(deps.outputsStatus ?? outputsStatusFor(dataDir));
    const r = await runAuto({
      store, rules, outputsStatus, logFile, now: deps.now,
      upload: auth ? (id) => (deps.upload ?? uploadPost)({ id, store, auth, outputsStatus, fetchImpl: deps.fetchImpl }) : undefined,
    });
    if (r.refused) { err(`auto-post: refused (${r.refused}); nothing approved or uploaded`); return 1; }
    const n = {}; for (const e of r.done) n[e.action] = (n[e.action] ?? 0) + 1;
    out(`auto-post: ${JSON.stringify(n)}`);
    return 0;
  } catch (e) {
    err(`auto-post: ${e instanceof AutoPostError || e instanceof PostingError ? e.message : (e?.message ?? 'error')}`);
    return 1;
  }
}

/** `youtube signin|status|signout|upload`. Always behind the posting flag -- same gate as `package`. */
async function youtubeMain(a, out, err, deps) {
  const dataDir = cliDataDir(a, out);
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
      const r = await uploadPost({ id: a.id, store, auth, outputsStatus: deps.outputsStatus ?? outputsStatusFor(dataDir), fetchImpl: deps.fetchImpl });
      const cover = r.hasCover;
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
