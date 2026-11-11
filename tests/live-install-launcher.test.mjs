// SPDX-License-Identifier: GPL-3.0-or-later
// LU6 end to end (D349): the real launcher runs from a temp install (its data folder under the install root, flag
// service-swap on) with the fake host recording ("live"). The real Install-Ujwalam.ps1 installs alpha.N+1 from a fake
// package built from the files the alpha package ships (tools/package/manifest.mjs) plus a stand-in host. It finds
// the running copy by path, installs side by side and hands the new version over the install channel: the event core
// and the UI server wait for one click each, the host is staged. The clicks (logged-in page, CSRF) swap both services
// while the recording runs: the host is never touched and the recording never stops. After the user's stop the host
// update is applied. No window (UJWALAM_HEADLESS=1, windowsHide), no device, no stream, nothing outside temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChildTree } from '../services/common/kill-tree.mjs';
import { folderFiles, releaseParts } from '../services/supervisor/parts.mjs';
import { repoFiles } from '../tools/package/manifest.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'tests', 'fixtures');
const FAKE_HOST = path.join(FIX, 'studio-ui', 'fake-host.mjs');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30_000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return v; await sleep(50); } }

/** An unzipped alpha.N build: the shipped repo files, a stand-in host, the installer files, release.json, SHA256SUMS. */
function fakePackage(dir, n) {
  for (const rel of repoFiles(REPO)) { const to = path.join(dir, ...rel.split('/')); mkdirSync(path.dirname(to), { recursive: true }); cpSync(path.join(REPO, ...rel.split('/')), to); }
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  copyFileSync(FAKE_HOST, path.join(dir, 'bin', 'ujwalam-host.mjs'));
  copyFileSync(path.join(REPO, 'tools', 'package', 'Install-Ujwalam.ps1'), path.join(dir, 'Install-Ujwalam.ps1'));
  copyFileSync(path.join(REPO, 'tools', 'package', 'Ujwalam.cmd'), path.join(dir, 'Ujwalam.cmd'));
  writeFileSync(path.join(dir, 'ujwalam-start.exe'), 'stand-in\n');
  const files = folderFiles(dir);
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: `0.1.0-alpha.${n}`, n, nodeMin: '22.13.0',
    hostExeSha256: sha(readFileSync(path.join(dir, 'bin', 'ujwalam-host.mjs'))), parts: releaseParts(files) }));
  const sums = folderFiles(dir).map((f) => `${sha(readFileSync(f.abs))}  ${f.rel}`);
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  return dir;
}

function runInstaller(pkg, ir) {
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(pkg, 'Install-Ujwalam.ps1'),
      '-InstallRoot', ir, '-NoShortcuts'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
}

test('LU6 E2E: install alpha.N+1 while recording: side by side, both services updated on their clicks, the host staged and applied only after the stop, the recording unbroken', { skip: process.platform !== 'win32' && 'Windows only', timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ujw-lu6-e2e-'));
  const children = [];
  t.after(() => { for (const c of children) killChildTree(c); try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp folder */ } });
  const ir = path.join(root, 'Ujwalam');
  const dataDir = path.join(ir, 'data', 'core');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'service-swap': true } }));
  const rec = path.join(root, 'record.json');
  const stopFile = path.join(root, 'stop');
  const catcher = path.join(root, 'catch-url.mjs');
  const urlFile = path.join(root, 'url.txt');
  writeFileSync(catcher, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], process.argv.at(-1));\n");
  const env = {
    ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), UJWALAM_OVERLAY_ROOT: path.join(root, 'no-overlays'),
    UJWALAM_FAKE_HOST_RECORD: rec, UJWALAM_FAKE_HOST_RUNS: path.join(root, 'runs.txt'), UJWALAM_FAKE_HOST_RECORDING: '1', UJWALAM_FAKE_HOST_STOP_ON: stopFile,
    UJWALAM_HOST_WATCH_MS: '200', UJWALAM_UPDATE_POLL_MS: '200', UJWALAM_HOST_UPDATE_READY_MS: '8000', UJWALAM_HOST_EXE: '', UJWALAM_HOST_BUILD: '',
    UJWALAM_BROWSER: process.execPath, UJWALAM_BROWSER_ARGS: `${catcher} ${urlFile}`,
  };
  // The running copy: its data folder lies under the install root, so the installer finds it by path.
  const l = spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--mock', '--shell', 'browser', '--stop-on-stdin', '--data-dir', dataDir,
    '--host-exe', FAKE_HOST, '--profile', path.join(FIX, 'project', 'profile.fixture.json'), '--feedback-dir', path.join(root, 'feedback')],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(l);
  let out = '';
  l.stdout.on('data', (d) => { out += d; });
  l.stderr.on('data', (d) => { out += d; });
  assert.ok(await until(() => /live install: an install while Ujwalam runs is handed/.test(out), 90_000), out.slice(-3000));
  let url = '';
  assert.ok(await until(() => { try { url = readFileSync(urlFile, 'utf8'); } catch { url = ''; } return /login\?k=/.test(url); }), out.slice(-2000));
  const u = new URL(url);
  const port = Number(u.port);
  const origin = `http://127.0.0.1:${port}`;
  const req = (method, p, { cookie, body, csrf } = {}) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin } : {}), ...(csrf ? { 'x-ujwalam-csrf': csrf } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: (() => { try { return JSON.parse(b); } catch { return b; } })() })); });
    r.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
  const calls = () => { try { return readFileSync(`${rec}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };
  const live = (n) => { try { return JSON.parse(readFileSync(path.join(dataDir, 'live', n), 'utf8')); } catch { return null; } };

  const cookie = (await req('GET', `${u.pathname}${u.search}`)).headers['set-cookie']?.[0]?.split(';')[0];
  assert.ok(cookie, 'logged in');
  const { csrf } = (await req('GET', '/ui/api/session', { cookie })).body;

  // The install, while the recording runs.
  const pkg = fakePackage(path.join(root, 'pkg'), 2);
  const inst = await runInstaller(pkg, ir);
  if (inst.code === 6) { t.skip(`prerequisites missing on this machine: ${inst.out}`); return; }
  assert.equal(inst.code, 0, `${inst.out}\n---\n${out.slice(-3000)}`);
  assert.match(inst.out, /Ujwalam is running from .* live install/);
  assert.match(inst.out, /Event core: ready\. Something is live, so it waits for one click/);
  assert.match(inst.out, /Control page server: ready\. Something is live, so it waits for one click/);
  assert.match(inst.out, /Video engine \(host\): staged\. It is applied when every stream and recording has stopped/);
  assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), '0.1.0-alpha.2', 'side by side: the next start runs it');
  const waiting = live('updates.json').waiting;
  assert.deepEqual(waiting.map((w) => [w.part, w.version, w.click]).sort(), [['event-core', '0.1.0-alpha.2', true], ['host', '0.1.0-alpha.2', false], ['studio-ui', '0.1.0-alpha.2', true]]);

  // One click each (the user's Apply now), while the recording runs. The event core's click answers with the result;
  // the control page server's own update is answered first (202, started), then swapped (its hand-over waits for the
  // requests in flight, the click included).
  const ec = await req('POST', '/ui/api/updates/apply', { cookie, csrf, body: { id: waiting.find((w) => w.part === 'event-core').id } });
  assert.deepEqual([ec.status, ec.body?.result], [200, 'swapped'], `event-core: ${JSON.stringify(ec.body)}\n${out.slice(-3000)}`);
  const ui = await req('POST', '/ui/api/updates/apply', { cookie, csrf, body: { id: waiting.find((w) => w.part === 'studio-ui').id } });
  assert.deepEqual([ui.status, ui.body?.result], [202, 'started'], `studio-ui: ${JSON.stringify(ui.body)}`);
  assert.ok(await until(() => /Control page server updated to 0\.1\.0-alpha\.2/.test(out)), out.slice(-3000));
  const after = live('updates.json');
  const ver = (p) => after.parts.find((x) => x.part === p).version;
  assert.deepEqual(['event-core', 'studio-ui', 'host'].map(ver), ['0.1.0-alpha.2', '0.1.0-alpha.2', 'dev'], 'every part except the host updated');
  assert.deepEqual(after.waiting.map((w) => w.part), ['host']);
  assert.deepEqual(calls().filter((c) => c.event === 'start').map((c) => c.run), [1], 'the host was never restarted while live');
  assert.equal(calls().filter((c) => c.event === 'stopped-by-user').length, 0, 'the recording never stopped');
  assert.doesNotMatch(out, /HOST EXITED UNEXPECTEDLY|HOST CRASHED|stopping Ujwalam/);

  // The user's stop: the staged host is applied from its checked copy.
  writeFileSync(stopFile, 'stop');
  assert.ok(await until(() => live('updates.json')?.parts.find((x) => x.part === 'host')?.version === '0.1.0-alpha.2'), out.slice(-3000));
  const starts = calls().filter((c) => c.event === 'start');
  assert.equal(starts.length, 2);
  assert.ok(starts[1].dir.startsWith(path.join(dataDir, 'live', 'releases')), 'the new host runs from the checked copy');
  l.stdin.end();
  const code = await new Promise((r) => l.once('exit', r));
  assert.equal(code, 0, out.slice(-3000));
  assert.doesNotMatch(out, /[0-9a-f]{64}/, 'no token-shaped value printed');
  assert.doesNotMatch(inst.out, /[0-9a-f]{64}/, 'the installer prints no token');
});
