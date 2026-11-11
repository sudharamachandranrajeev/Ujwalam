// SPDX-License-Identifier: GPL-3.0-or-later
// LU6 live install (D349): the plan of what a new release hands over, the install channel (owner-only named pipe +
// token, one request line, one reply line), the local swap asker (the same serveSwaps checks as the parent's IPC), and
// Install-Ujwalam.ps1 while a program runs from the install folder (found by path): side by side, no running file
// replaced, the running version never reinstalled. Temp folders only; nothing under %LOCALAPPDATA%\Ujwalam is read or
// written. No window (windowsHide), no device, no stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstallChannel, INSTALL_CHANNEL_FILE, installPlan, resultText } from '../services/supervisor/install-channel.mjs';
import { localSwapAsker } from '../services/studio-ui/launch.mjs';
import { createUpdates } from '../services/supervisor/updates.mjs';
import { killChildTree } from '../services/common/kill-tree.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const H = (c) => c.repeat(64);
const tmp = (n) => mkdtempSync(path.join(os.tmpdir(), `ujw-lu6-${n}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parts = (o = {}) => ({
  host: { files: 3, sha256: H('a') }, 'studio-window': { files: 2, sha256: H('b') }, services: { files: 9, sha256: H('c') },
  overlay: { files: 0, sha256: H('d') }, data: { files: 4, sha256: H('e') }, ...o,
});
const svc = (p) => ({ services: p.services, data: p.data, overlay: p.overlay });

test('installPlan: unknown running parts (a dev checkout) hand over every part, in the order event core, UI server, studio window, host', () => {
  const r = installPlan({ running: {}, parts: parts() });
  assert.deepEqual(r.plan.map((p) => p.service), ['event-core', 'studio-ui', 'studio', 'host']);
  assert.deepEqual(r.skipped, []);
});

test('installPlan: unchanged parts are skipped; a data change alone swaps both services (they run the data of their copy)', () => {
  const p = parts();
  const running = { host: H('a'), 'event-core': svc(p), 'studio-ui': svc(p), 'studio-window': H('b') };
  assert.deepEqual(installPlan({ running, parts: p }).plan, []);
  const r = installPlan({ running, parts: parts({ data: { files: 4, sha256: H('f') } }) });
  assert.deepEqual(r.plan.map((x) => x.service), ['event-core', 'studio-ui']);
  assert.deepEqual(r.skipped.map((x) => [x.service, x.why]), [['studio', 'unchanged'], ['host', 'unchanged']]);
  const h = installPlan({ running, parts: parts({ host: { files: 3, sha256: H('9') } }) });
  assert.deepEqual(h.plan.map((x) => x.service), ['host']);
});

test('installPlan: a studio window that is not running (browser page) or a part the release does not carry is skipped', () => {
  const r = installPlan({ running: {}, parts: parts({ 'studio-window': { files: 2, sha256: H('7') } }), has: (s) => s !== 'studio' });
  assert.deepEqual(r.plan.map((x) => x.service), ['event-core', 'studio-ui', 'host']);
  assert.deepEqual(r.skipped.map((x) => [x.service, x.why]), [['studio', 'not running']]);
  const e = installPlan({ running: {}, parts: parts({ host: { files: 0, sha256: H('1') }, 'studio-window': undefined }) });
  assert.deepEqual(e.skipped.map((x) => [x.service, x.why]), [['studio', 'not in this release'], ['host', 'not in this release']]);
});

test('resultText: plain words for each queue answer; waiting names the click, staged names the stop', () => {
  assert.match(resultText('event-core', { result: 'waiting' }), /^Event core: ready\. .*one click on Apply now/);
  assert.match(resultText('host', { result: 'staged' }), /^Video engine \(host\): staged\. .*stopped/);
  assert.match(resultText('studio-ui', { result: 'swapped' }), /updated now/);
  assert.match(resultText('studio-ui', { result: 'refused', reason: 'x' }), /not updated now: x\. The new version runs from the next start/);
  assert.match(resultText('host', null), /no answer/);
});

/** A release folder with release.json (n, parts) and the two service entry files. */
function release(dir, n, p = parts()) {
  for (const s of ['event-core', 'studio-ui']) { mkdirSync(path.join(dir, 'services', s), { recursive: true }); writeFileSync(path.join(dir, 'services', s, 'cli.mjs'), '// stand-in\n'); }
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: `0.1.0-alpha.${n}`, n, parts: p }));
  return dir;
}

function pipeAsk(pipe, line) {
  return new Promise((resolve, reject) => {
    const s = net.connect(`\\\\.\\pipe\\${pipe}`);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => { buf += d; });
    s.on('end', () => { try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(new Error(`${e.message}: ${buf}`)); } });
    s.on('error', reject);
    s.write(`${line}\n`);
  });
}

test('install channel: owner-only file with a random pipe and token; wrong token, bad JSON and bad roots refused; a good request asks each part in order and answers in one line; close removes the file', { skip: process.platform !== 'win32' && 'named pipes: Windows' }, async (t) => {
  const root = tmp('chan');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'core');
  const asked = [];
  const ch = await createInstallChannel({ dataDir, ask: async (s, r) => { asked.push([s, r]); return { result: s === 'host' ? 'staged' : 'waiting' }; }, has: (s) => s !== 'studio' });
  try {
    const f = JSON.parse(readFileSync(path.join(dataDir, 'live', INSTALL_CHANNEL_FILE), 'utf8'));
    assert.match(f.pipe, /^ujwalam-install-[0-9a-f]{32}$/);
    assert.match(f.token, /^[0-9a-f]{64}$/);
    assert.equal(f.pid, process.pid);
    const rel = release(path.join(root, 'rel'), 7);
    const bad = await pipeAsk(f.pipe, JSON.stringify({ t: 'ujwalam-install', token: H('0'), root: rel }));
    assert.deepEqual([bad.ok, bad.reason], [false, 'not allowed']);
    assert.equal((await pipeAsk(f.pipe, '{nope')).reason, 'bad request');
    assert.match((await pipeAsk(f.pipe, JSON.stringify({ t: 'ujwalam-install', token: f.token, root: 'rel' }))).reason, /absolute/);
    assert.match((await pipeAsk(f.pipe, JSON.stringify({ t: 'ujwalam-install', token: f.token, root: path.join(root, 'none') }))).reason, /does not exist/);
    mkdirSync(path.join(root, 'empty'));
    assert.match((await pipeAsk(f.pipe, JSON.stringify({ t: 'ujwalam-install', token: f.token, root: path.join(root, 'empty') }))).reason, /release\.json/);
    assert.deepEqual(asked, [], 'nothing asked for a refused request');
    const ok = await pipeAsk(f.pipe, JSON.stringify({ t: 'ujwalam-install', token: f.token, root: rel }));
    assert.equal(ok.ok, true);
    assert.equal(ok.version, '0.1.0-alpha.7');
    assert.deepEqual(asked, [['event-core', rel], ['studio-ui', rel], ['host', rel]]);
    assert.deepEqual(ok.results.map((r) => [r.service, r.result]), [['event-core', 'waiting'], ['studio-ui', 'waiting'], ['host', 'staged']]);
    assert.deepEqual(ok.skipped.map((s) => s.service), ['studio']);
    assert.doesNotMatch(JSON.stringify(ok), new RegExp(f.token), 'the token is never sent back');
  } finally { ch.close(); }
  assert.ok(!existsSync(path.join(dataDir, 'live', INSTALL_CHANNEL_FILE)), 'removed at close');
});

test('localSwapAsker: install requests take the serveSwaps checks and then the update queue (a service waits for a click while live, the host is refused without a running host)', async (t) => {
  const root = tmp('asker');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'core');
  const rel = path.join(root, 'rel');
  for (const s of ['event-core', 'studio-ui']) { mkdirSync(path.join(rel, 'services', s), { recursive: true }); writeFileSync(path.join(rel, 'services', s, 'cli.mjs'), `// ${s}\n`); }
  const { folderFiles, releaseParts } = await import('../services/supervisor/parts.mjs');
  writeFileSync(path.join(rel, 'release.json'), JSON.stringify({ version: '0.1.0-alpha.5', n: 5, parts: releaseParts(folderFiles(rel).filter((f) => f.rel !== 'release.json')) }));
  const swaps = [];
  const updates = createUpdates({ dataDir, session: 'a'.repeat(32), outputs: async () => ({ sinks: [{ kind: 'stream', state: 'live' }] }), swapService: async (s, r) => { swaps.push([s, r]); return { result: 'swapped' }; } });
  const ask = localSwapAsker({ 'event-core': {}, 'studio-ui': {}, studio: null }, () => {}, updates);
  const ec = await ask('event-core', rel);
  assert.equal(ec.result, 'waiting', JSON.stringify(ec));
  assert.match(ec.item, /^u\d+$/);
  assert.equal((await ask('studio', rel)).result, 'refused', 'no studio slot');
  assert.equal((await ask('host', rel)).result, 'refused', 'no host is running');
  assert.equal((await ask('event-core', path.join(root, 'nowhere'))).result, 'refused');
  assert.deepEqual(swaps, [], 'nothing swapped while live without a click');
  assert.ok(updates.runningParts()['event-core'] === null, 'a dev checkout: unknown');
  assert.equal((await updates.apply(ec.item)).result, 'swapped');
  assert.deepEqual(Object.keys(updates.runningParts()['event-core']).sort(), ['data', 'overlay', 'services'], 'after the click the queue knows what runs');
  updates.close();
});

test('server: a click on the control page server\'s own update is answered first (202 started) and applied after the answer went out; other parts answer with the result', async (t) => {
  const { createStudioServer } = await import('../services/studio-ui/server.mjs');
  const { createFakeHost } = await import('../services/studio-ui/backends.mjs');
  const http = await import('node:http');
  const dataDir = tmp('srv');
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const fake = createFakeHost();
  const KEY = 'k'.repeat(48);
  const state = { accepting: true, parts: [], waiting: [{ id: 'u1', part: 'studio-ui', version: '0.1.0-alpha.2', click: true, text: 'ready' }, { id: 'u2', part: 'event-core', version: '0.1.0-alpha.2', click: true, text: 'ready' }], recent: [] };
  const events = [];
  const srv = createStudioServer({ uiRoot: path.join(REPO, 'ui'), core: { describe: () => ({ available: false }), call: async () => null, confirm: async () => null },
    host: { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) }, launchKey: KEY, dataDir, limits: { statusPollMs: 1000 }, log: () => {},
    updatesStatus: () => state, // u1 never finishes (as a swap of this server waits for the click's own request): the click is still answered.
    updates: { apply: (id) => { events.push(`apply ${id}`); return id === 'u1' ? new Promise(() => {}) : Promise.resolve({ result: 'swapped' }); } } });
  const { port } = await srv.listen();
  const origin = `http://127.0.0.1:${port}`;
  const req = (method, u, { cookie, body, csrf } = {}) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: u, method, agent: false, headers: { ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin } : {}), ...(csrf ? { 'x-ujwalam-csrf': csrf } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { events.push(`answer ${res.statusCode}`); resolve({ status: res.statusCode, headers: res.headers, body: b ? JSON.parse(b) : null }); }); });
    if (data) r.write(data);
    r.end();
  });
  try {
    const cookie = (await req('GET', `/login?k=${KEY}`)).headers['set-cookie'][0].split(';')[0];
    const { csrf } = (await req('GET', '/ui/api/session', { cookie })).body;
    events.length = 0;
    const self = await req('POST', '/ui/api/updates/apply', { cookie, csrf, body: { id: 'u1' } });
    assert.deepEqual([self.status, self.body.result], [202, 'started']);
    await sleep(50);
    assert.deepEqual(events.sort(), ['answer 202', 'apply u1'], 'answered without waiting for the swap, which starts after the answer');
    events.length = 0;
    const other = await req('POST', '/ui/api/updates/apply', { cookie, csrf, body: { id: 'u2' } });
    assert.deepEqual([other.status, other.body.result], [200, 'swapped']);
    assert.deepEqual(events, ['apply u2', 'answer 200']);
  } finally { await srv.close(); }
});

// ---- Install-Ujwalam.ps1 while a program runs from the install folder ----

const START_EXE = path.join(REPO, 'out', 'studio', 'build', 'ujwalam-start.exe');
function fakePackage(root, version, { start = 'stand-in\n' } = {}) {
  const pkg = path.join(root, `pkg-${version}`);
  mkdirSync(path.join(pkg, 'tools', 'package'), { recursive: true });
  copyFileSync(path.join(REPO, 'tools', 'package', 'Install-Ujwalam.ps1'), path.join(pkg, 'Install-Ujwalam.ps1'));
  copyFileSync(path.join(REPO, 'tools', 'package', 'Ujwalam.cmd'), path.join(pkg, 'Ujwalam.cmd'));
  if (start !== null) writeFileSync(path.join(pkg, 'ujwalam-start.exe'), start); // null: a broken build without it
  writeFileSync(path.join(pkg, 'release.json'), JSON.stringify({ version, nodeMin: '22.13.0' }));
  writeFileSync(path.join(pkg, 'tools', 'package', 'run-installed.mjs'), `// ${version}\nconsole.log('fake ${version}');\n`);
  const rels = ['Install-Ujwalam.ps1', 'Ujwalam.cmd', ...(start !== null ? ['ujwalam-start.exe'] : []), 'release.json', 'tools/package/run-installed.mjs'];
  writeFileSync(path.join(pkg, 'SHA256SUMS.txt'), rels.map((r) => `${sha(readFileSync(path.join(pkg, r)))}  ${r}\n`).join(''));
  return pkg;
}
function install(pkg, root, ...extra) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(pkg, 'Install-Ujwalam.ps1'),
    '-InstallRoot', path.join(root, 'Ujwalam'), '-NoShortcuts', ...extra], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
/** A stand-in "running Ujwalam": a Node process that idles and names paths under the install on its command line. */
function runningUnder(t, ...paths) {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...paths], { stdio: 'ignore', windowsHide: true });
  t.after(() => killChildTree(c));
  return c;
}
function treeHash(dir) {
  const out = [];
  const walk = (d, rel) => { for (const n of readdirSync(d).sort()) { const a = path.join(d, n); if (statSync(a).isDirectory()) walk(a, `${rel}${n}/`); else out.push(`${rel}${n} ${sha(readFileSync(a))} ${statSync(a).mtimeMs}`); } };
  walk(dir, '');
  return out.join('\n');
}

test('Install-Ujwalam.ps1 while Ujwalam runs from the install (found by path): side by side, the start exe in use is kept, the running version is untouched, no hand-over without a channel', { skip: process.platform !== 'win32' && 'Windows only', timeout: 120_000 }, async (t) => {
  const root = tmp('live-ps');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const ir = path.join(root, 'Ujwalam');
  let r = install(fakePackage(root, '0.1.0-alpha.1', { start: 'start v1\n' }), root);
  if (r.code === 6) { t.skip(`prerequisites missing on this machine: ${r.out}`); return; }
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /live install/, 'nothing runs: a normal install');
  // The running copy: started from alpha.1 through the top-level start exe, its data folder under the install.
  const v1 = path.join(ir, '0.1.0-alpha.1');
  runningUnder(t, path.join(ir, 'ujwalam-start.exe'), path.join(v1, 'tools', 'package', 'run-installed.mjs'), '--data-dir', path.join(ir, 'data', 'core'));
  await sleep(300);
  const before = treeHash(v1);
  const startBefore = readFileSync(path.join(ir, 'ujwalam-start.exe'), 'utf8');
  r = install(fakePackage(root, '0.1.0-alpha.2', { start: 'start v2\n' }), root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Ujwalam is running from .* live install/);
  assert.match(r.out, /kept ujwalam-start\.exe/);
  assert.match(r.out, /does not take live updates .* runs from the next start/);
  assert.equal(readFileSync(path.join(ir, 'ujwalam-start.exe'), 'utf8'), startBefore, 'the start exe in use is not replaced');
  assert.equal(treeHash(v1), before, 'no file of the running version changed');
  assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), '0.1.0-alpha.2', 'the next start runs the new version');
  assert.equal(readFileSync(path.join(ir, 'previous.txt'), 'utf8').trim(), '0.1.0-alpha.1');
  assert.ok(existsSync(path.join(ir, '0.1.0-alpha.2', 'release.json')));
  // Reinstalling the running version is refused, even with -Force; nothing is renamed.
  r = install(fakePackage(root, '0.1.0-alpha.1', { start: 'start v1\n' }), root, '-Force');
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /is the version that is running now/);
  assert.equal(treeHash(v1), before);
  assert.deepEqual(readdirSync(ir).filter((n) => n.includes('replaced')), []);
});

test('Install-Ujwalam.ps1: a program under another folder with a similar name does not count as running (path, not name)', { skip: process.platform !== 'win32' && 'Windows only', timeout: 60_000 }, async (t) => {
  const root = tmp('notlive');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  runningUnder(t, path.join(root, 'Ujwalam-dev', 'ujwalam-start.exe'), path.join(root, 'Ujwalam.old', 'x'));
  await sleep(300);
  const r = install(fakePackage(root, '0.1.0-alpha.3'), root);
  if (r.code === 6) { t.skip('prerequisites missing'); return; }
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /live install/);
});

// ---- Codex review of D349 ----

test('Codex review: a launcher named with forward slashes and other letter case still counts as running; its folder is never renamed by -Force', { skip: process.platform !== 'win32' && 'Windows only', timeout: 120_000 }, async (t) => {
  const root = tmp('slash');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const ir = path.join(root, 'Ujwalam');
  let r = install(fakePackage(root, '0.1.0-alpha.1'), root);
  if (r.code === 6) { t.skip(`prerequisites missing on this machine: ${r.out}`); return; }
  assert.equal(r.code, 0, r.out);
  const v1 = path.join(ir, '0.1.0-alpha.1');
  // C:/USERS/.../UJWALAM/0.1.0-ALPHA.1/services/studio-ui/launch.mjs: no backslash, other case.
  runningUnder(t, path.join(v1, 'services', 'studio-ui', 'launch.mjs').split(path.sep).join('/').toUpperCase());
  await sleep(300);
  const before = treeHash(v1);
  r = install(fakePackage(root, '0.1.0-alpha.1'), root, '-Force');
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /live install/);
  assert.match(r.out, /is the version that is running now/);
  assert.equal(treeHash(v1), before);
  assert.deepEqual(readdirSync(ir).filter((n) => n.includes('replaced')), [], 'no rename of the running folder');
});

test('Codex review: a top-level file another program holds open (sharing violation, not named on any command line) is kept; the install goes on', { skip: process.platform !== 'win32' && 'Windows only', timeout: 120_000 }, async (t) => {
  const root = tmp('share');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const ir = path.join(root, 'Ujwalam');
  let r = install(fakePackage(root, '0.1.0-alpha.1', { start: 'start v1\n' }), root);
  if (r.code === 6) { t.skip(`prerequisites missing on this machine: ${r.out}`); return; }
  assert.equal(r.code, 0, r.out);
  runningUnder(t, '--data-dir', path.join(ir, 'data', 'core'));
  // The holder gets the path from the environment, so only Windows' sharing check can tell that the file is in use.
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f = [System.IO.File]::Open($env:UJW_HOLD, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 60; $f.Dispose()"],
  { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, UJW_HOLD: path.join(ir, 'ujwalam-start.exe') } });
  t.after(() => killChildTree(holder));
  let held = '';
  holder.stdout.on('data', (d) => { held += d; });
  for (let i = 0; i < 200 && !held.includes('held'); i++) await sleep(50);
  assert.ok(held.includes('held'));
  r = install(fakePackage(root, '0.1.0-alpha.2', { start: 'start v2\n' }), root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /live install/);
  assert.match(r.out, /kept ujwalam-start\.exe/);
  killChildTree(holder);
  await sleep(300);
  assert.equal(readFileSync(path.join(ir, 'ujwalam-start.exe'), 'utf8'), 'start v1\n');
  assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), '0.1.0-alpha.2');
  assert.deepEqual(readdirSync(ir).filter((n) => n.endsWith('.new')), [], 'no temp file left');
});

test('Codex review: any other failure to replace a top-level file, or a build without its start exe, stops with an error and leaves current.txt on the version that worked', { skip: process.platform !== 'win32' && 'Windows only', timeout: 120_000 }, async (t) => {
  const root = tmp('fail');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const ir = path.join(root, 'Ujwalam');
  let r = install(fakePackage(root, '0.1.0-alpha.1', { start: 'start v1\n' }), root);
  if (r.code === 6) { t.skip(`prerequisites missing on this machine: ${r.out}`); return; }
  assert.equal(r.code, 0, r.out);
  runningUnder(t, '--data-dir', path.join(ir, 'data', 'core')); // live: such a failure used to be taken for "in use"
  await sleep(300);
  // Not a sharing violation: a folder where the start exe should be.
  rmSync(path.join(ir, 'ujwalam-start.exe'));
  mkdirSync(path.join(ir, 'ujwalam-start.exe'));
  r = install(fakePackage(root, '0.1.0-alpha.2', { start: 'start v2\n' }), root);
  assert.equal(r.code, 10, r.out);
  assert.match(r.out, /live install/);
  assert.match(r.out, /could not replace .*ujwalam-start\.exe.*current\.txt was not changed/);
  assert.doesNotMatch(r.out, /kept ujwalam-start\.exe/);
  assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), '0.1.0-alpha.1');
  assert.ok(!existsSync(path.join(ir, 'previous.txt')));
  assert.deepEqual(readdirSync(ir).filter((n) => n.endsWith('.new')), [], 'no temp file left');
  rmSync(path.join(ir, 'ujwalam-start.exe'), { recursive: true });
  writeFileSync(path.join(ir, 'ujwalam-start.exe'), 'start v1\n');
  // A build without its start exe.
  r = install(fakePackage(root, '0.1.0-alpha.3', { start: null }), root);
  assert.equal(r.code, 10, r.out);
  assert.match(r.out, /ujwalam-start\.exe is missing from the unzipped build; current\.txt was not changed/);
  assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), '0.1.0-alpha.1');
});
