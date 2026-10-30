// SPDX-License-Identifier: GPL-2.0-or-later
// One-command launcher: event core, libobs host (when present) and the studio UI server, then the browser.
// Usage: node services/studio-ui/launch.mjs [--data-dir DIR] [--mock] [--no-open] [--host-exe PATH] [--fake-host] [--allow-devices] [--outputs PLAN.json] [--stop-on-stdin] [--ui-port N]
//
// Tokens: the launcher makes the event-core api/system tokens and a host token, passes them to the children by
// environment (never argv, never printed). The UI server gets only the api token, never the system token. The browser
// is opened on /login?k=<one-time launch key>; the key is not printed.
// Process priority: children inherit Normal (nothing here lowers it); the event core also sets itself to Normal.
// Host: started when its exe and OBS runtime resolve (app/host/lib/config.mjs) and --fake-host is not given. The host
// token goes by environment to the host and the UI server only; the discovery file is <event-core data dir>/host.json.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';
import { resolveDataDir } from '../event-core/config.mjs';
import { rpc } from './backends.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hex = (n) => randomBytes(n).toString('hex');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); out[k] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; }
  }
  return out;
}

// UJWALAM_BROWSER (an executable) and UJWALAM_BROWSER_ARGS (space separated flags) pick the browser; used by the UI tests.
function openBrowser(url) {
  const opts = { stdio: 'ignore', detached: true, windowsHide: true };
  if (process.env.UJWALAM_BROWSER) {
    spawn(process.env.UJWALAM_BROWSER, [...(process.env.UJWALAM_BROWSER_ARGS ?? '').split(' ').filter(Boolean), url], opts).unref();
    return;
  }
  if (process.platform === 'win32') spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'start', '""', url], opts).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts).unref();
}

// Starts a child whose stdout is scanned for a "listening" line; resolves the port from the first capture group.
function portFrom(child, re) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: child.stdout });
    const t = setTimeout(() => resolve(null), 20_000);
    rl.on('line', (l) => { console.log(l); const m = re.exec(l); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.once('exit', () => { clearTimeout(t); resolve(null); });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let dataDir;
  try { dataDir = resolveDataDir({ dataDir: typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined }); } catch (e) { console.log(`[studio] ${e.message}`); return 1; }
  const children = [];
  let hostChild = null;
  let hostDiscoveryFile = null;
  // Ask the host to exit cleanly first (it closes previews and removes its discovery file), then kill what is left.
  const stopAll = async () => {
    if (hostChild && hostChild.exitCode === null && hostDiscoveryFile) {
      try {
        const d = JSON.parse(readFileSync(hostDiscoveryFile, 'utf8'));
        await rpc({ port: d.port, token: hostToken, method: 'host.shutdown', params: {}, timeoutMs: 2000 }); // node:http: the host refuses fetch (it sends Sec-Fetch headers)
        await new Promise((r) => { hostChild.once('exit', r); setTimeout(r, 8000); });
      } catch { /* fall through to kill */ }
    }
    for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  };
  process.once('SIGINT', () => { stopAll().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { stopAll().then(() => process.exit(0)); });

  const hostToken = hex(32);
  const coreTokens = { api: hex(32), system: hex(32) };
    const launchKey = hex(32);

  // 1. event core (port 0; its own log line reports the port)
  const core = spawn(process.execPath, [path.join(REPO, 'services', 'event-core', 'cli.mjs'), 'serve', '--data-dir', dataDir, ...(args.mock === true ? ['--mock'] : [])], {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
    env: { ...process.env, UJWALAM_EVENT_CORE_API_TOKEN: coreTokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: coreTokens.system },
  });
  children.push(core);
  const corePort = await portFrom(core, /api on 127\.0\.0\.1:(\d+)/);
  if (!corePort) { console.log('[studio] event core did not start; stopping'); await stopAll(); return 1; }

  // 2. host (optional). Config (exe, OBS runtime, data) comes from app/host/lib/config.mjs (env or host.local.json).
  // Devices stay off unless --allow-devices is given here; this launcher never opens a device by itself.
  let hostCfg = null;
  try { hostCfg = resolveHostConfig(typeof args['host-exe'] === 'string' ? { exe: args['host-exe'] } : {}); } catch { hostCfg = null; }
  // The day-2 host build lives in out/host/build-c while another host may hold out/host/build: use the newer exe
  // unless the user chose one (--host-exe, UJWALAM_HOST_EXE or UJWALAM_HOST_BUILD).
  if (hostCfg && typeof args['host-exe'] !== 'string' && !process.env.UJWALAM_HOST_EXE && !process.env.UJWALAM_HOST_BUILD) {
    const alt = path.join(REPO, 'out', 'host', 'build-c', 'ujwalam-host.exe');
    try { if (existsSync(alt) && (!existsSync(hostCfg.exe) || statSync(alt).mtimeMs > statSync(hostCfg.exe).mtimeMs)) hostCfg.exe = alt; } catch { /* keep the default */ }
  }
  const hostExe = hostCfg?.exe;
  const hostDiscovery = path.join(dataDir, 'host.json');
  if (args['fake-host'] !== true && hostExe && existsSync(hostExe) && hostCfg.runtime) {
    const hostArgs = ['--runtime', hostCfg.runtime, '--data-dir', hostCfg.dataDir, '--discovery', hostDiscovery, '--recordings', hostCfg.recordings,
      '--project', path.join(REPO, 'app', 'host', 'projects', 'test-card.project.json')];
    if (args['allow-devices'] === true) hostArgs.push('--allow-devices');
    if (typeof args.outputs === 'string') {
      // An O1 plan file (app/host/outputs/*.json): validated against data/platforms, configured at host start, nothing started.
      const { planFile } = await import('../../app/host/lib/outputs-plan.mjs');
      const { params, report } = planFile(path.resolve(args.outputs));
      for (const w of report.warnings) console.log(`[studio] outputs plan warning: ${w.code}`);
      const f = path.join(hostCfg.dataDir, 'outputs-params.json');
      mkdirSync(hostCfg.dataDir, { recursive: true });
      writeFileSync(f, JSON.stringify(params, null, 2));
      hostArgs.push('--outputs', f);
    }
    hostChild = spawn(hostExe, hostArgs, {
      stdio: 'ignore',
      env: { ...process.env, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_HOST_DISCOVERY: hostDiscovery },
    });
    children.push(hostChild);
    hostDiscoveryFile = hostDiscovery;
    // The UI server and the browser start only after the host has written its discovery file (up to 60 s), so the page never meets the fake backend first.
    for (let i = 0; i < 240 && !existsSync(hostDiscovery); i++) await new Promise((r) => setTimeout(r, 250));
    console.log(`[studio] libobs host started${args['allow-devices'] === true ? ' (devices ALLOWED)' : ' (devices off)'}`);
  } else {
    console.log('[studio] BLOCKED-ON-HOST: no libobs host executable (build it with node app/host/tools/build.mjs, or set UJWALAM_HOST_EXE / --host-exe); the UI uses its fake backend');
  }

  // 3. UI server
  const uiArgs = [path.join(REPO, 'services', 'studio-ui', 'cli.mjs'), 'serve', '--data-dir', dataDir];
  if (typeof args['ui-port'] === 'string') uiArgs.push('--port', args['ui-port']);
  if (args['fake-host'] === true) uiArgs.push('--fake-host');
  const ui = spawn(process.execPath, uiArgs, {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
    env: { ...process.env, UJWALAM_UI_LAUNCH_KEY: launchKey, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_EVENT_CORE_PORT: String(corePort), UJWALAM_EVENT_CORE_API_TOKEN: coreTokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: '' },
  });
  children.push(ui);
  const uiPort = await portFrom(ui, /listening on http:\/\/127\.0\.0\.1:(\d+)\//);
  if (!uiPort) { console.log('[studio] UI server did not start; stopping'); await stopAll(); return 1; }

  console.log(`[studio] UI at http://127.0.0.1:${uiPort}/ (the login key is one-time and not printed). Ctrl-C stops everything.`);
  if (args['no-open'] !== true) openBrowser(`http://127.0.0.1:${uiPort}/login?k=${launchKey}`);
  if (args['stop-on-stdin'] === true) {
    // Clean stop for scripts and tests: closing stdin (or any input) ends the session; Ctrl-C does not reach a child on Windows.
    process.stdin.resume();
    process.stdin.once('data', () => { stopAll().then(() => process.exit(0)); });
    process.stdin.once('end', () => { stopAll().then(() => process.exit(0)); });
  }
  await new Promise((resolve) => { core.once('exit', resolve); ui.once('exit', resolve); });
  await stopAll();
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('launch.mjs') && process.argv[1].includes('studio-ui')) process.exit(await main());
