// SPDX-License-Identifier: GPL-3.0-or-later
// Starts ujwalam-host as a child process and waits for its discovery file.
// By default the api token is passed by environment (UJWALAM_HOST_TOKEN), never on the command line, so the
// discovery file carries token: null (the UI launcher's way). tokenByEnv: false lets the host generate it into the
// owner-only discovery file instead (manual sessions, so hostctl can read it). Device sources stay off: this
// launcher never passes --allow-devices.
// overlay: true starts the host with --allow-browser and the overlay server child (cfg.overlayRoot, this Node as
// --node); an object adds { port, feedPort } (never 8093). No event feed: --overlay-events-url is not passed.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { HostClient } from './client.mjs';
import { overlayRootProblem, resolveConfig } from './config.mjs';

export async function launchHost({
  dataDir, project, outputs, preview, port = 0, extraArgs = [], env = {}, stdio = 'pipe', timeoutMs = 30000, cfg: cfgIn, tokenByEnv = true,
  overlay
} = {}) {
  const cfg = cfgIn ?? resolveConfig({ dataDir });
  if (!cfg.runtime) throw new Error('OBS runtime not set: UJWALAM_OBS_RUNTIME or app/host/host.local.json "obsRuntime"');
  if (!existsSync(cfg.exe)) throw new Error(`host exe not found: ${cfg.exe} (build it: node app/host/tools/build.mjs)`);
  const dd = dataDir ?? cfg.dataDir;
  mkdirSync(dd, { recursive: true });
  const discovery = path.join(dd, 'host.json');
  if (existsSync(discovery)) rmSync(discovery); // a stale file from a killed run
  const envToken = tokenByEnv ? randomBytes(32).toString('hex') : undefined;
  const args = ['--runtime', cfg.runtime, '--data-dir', dd, '--discovery', discovery, '--port', String(port)];
  if (project) args.push('--project', project);
  if (outputs) args.push('--outputs', outputs);
  if (preview) args.push('--preview', preview);
  if (overlay) {
    const bad = overlayRootProblem(cfg.overlayRoot);
    if (bad) throw new Error(bad);
    args.push('--allow-browser', '--overlay-root', cfg.overlayRoot, '--overlay-script', cfg.overlayScript, '--node', process.execPath);
    if (overlay.port) args.push('--overlay-port', String(overlay.port));
    if (overlay.feedPort) args.push('--overlay-feed-port', String(overlay.feedPort));
  }
  args.push(...extraArgs);
  const child = spawn(cfg.exe, args, {
    env: { ...process.env, ...env, ...(envToken ? { UJWALAM_HOST_TOKEN: envToken } : {}) },
    stdio: stdio === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true // the host is a console program: no console window; previews are its own windows (D191)
  });
  const log = [];
  if (child.stdout) {
    child.stdout.on('data', (d) => log.push(d.toString()));
    child.stderr.on('data', (d) => log.push(d.toString()));
  }
  let exited = null;
  const exit = new Promise((resolve) => child.on('exit', (code) => { exited = code; resolve(code); }));
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (exited !== null) throw new Error(`host exited with ${exited} before it was ready\n${log.join('').slice(-2000)}`);
    if (existsSync(discovery)) {
      try {
        const d = JSON.parse(readFileSync(discovery, 'utf8'));
        if (d.pid === child.pid) {
          const token = envToken ?? d.token;
          const client = new HostClient({ port: d.port, token });
          return { child, client, discovery, discoveryJson: d, token, dataDir: dd, log, exit, cfg };
        }
      } catch { /* partially visible: retry */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('host did not become ready in time');
}

export async function stopHost(h, timeoutMs = 20000) {
  try { await h.client.call('host.shutdown'); } catch { /* already gone */ }
  const code = await Promise.race([h.exit, new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))]);
  if (code === 'timeout') {
    h.child.kill();
    return { code: null, timedOut: true };
  }
  return { code, timedOut: false };
}
