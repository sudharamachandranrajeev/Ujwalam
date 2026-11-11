// SPDX-License-Identifier: GPL-3.0-or-later
// LU3 launcher wiring (D337): the service-swap flag exists and is off by default; swap requests come only over the
// launcher's IPC channel and are checked before any slot runs (host and overlay server refused, unknown services and
// roots without the entry file refused, results passed back).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serveSwaps, SERVICE_SWAP_FLAG } from '../services/studio-ui/launch.mjs';
import { killChildTree } from '../services/common/kill-tree.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeProc() {
  const p = new EventEmitter();
  p.sent = [];
  p.connected = true;
  p.send = (m) => { p.sent.push(m); };
  return p;
}
const ask = async (p, m) => { const n = p.sent.length; p.emit('message', { t: 'ujwalam-swap', ...m }); for (let i = 0; i < 100 && p.sent.length === n; i++) await new Promise((r) => setTimeout(r, 5)); return p.sent.at(-1); };

test('the service-swap flag is declared and off by default', () => {
  const f = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags.find((x) => x.id === SERVICE_SWAP_FLAG);
  assert.ok(f);
  assert.equal(f.default, false);
});

test('serveSwaps: refuses the host, the overlay server, unknown services and bad roots; runs a slot and passes its result back', async () => {
  assert.equal(serveSwaps({ slots: {}, log: () => {}, proc: new EventEmitter() }), false, 'no IPC parent: nothing listens');
  const p = fakeProc();
  const calls = [];
  const slot = { swap: async (root) => { calls.push(root); return { result: 'swapped', ms: 12, history: [{ ok: true }] }; } };
  serveSwaps({ slots: { 'event-core': slot, 'studio-ui': null }, log: () => {}, proc: p });
  assert.match((await ask(p, { id: 1, service: 'host', root: REPO })).reason, /LU5/);
  assert.match((await ask(p, { id: 2, service: 'overlay-server', root: REPO })).reason, /child of the host/);
  assert.match((await ask(p, { id: 3, service: '__proto__', root: REPO })).reason, /unknown service/);
  assert.match((await ask(p, { id: 4, service: 'live-clipper', root: REPO })).reason, /not wired/);
  assert.match((await ask(p, { id: 5, service: 'event-core', root: 'relative/path' })).reason, /absolute folder/);
  assert.match((await ask(p, { id: 6, service: 'event-core', root: path.join(REPO, 'docs') })).reason, /entry file/);
  const ok = await ask(p, { id: 7, service: 'event-core', root: REPO });
  assert.deepEqual({ id: ok.id, result: ok.result, ms: ok.ms }, { id: 7, result: 'swapped', ms: 12 });
  assert.deepEqual(calls, [REPO]);
  p.emit('message', { t: 'other', id: 8 });
  p.emit('message', { t: 'ujwalam-swap', id: 'x', service: 'event-core', root: REPO });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1, 'other messages and bad ids are ignored');
});

test('launcher with the flag on: the event core and the UI server swap over IPC behind unchanged ports; the host is refused', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lu3-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'core');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { [SERVICE_SWAP_FLAG]: true } }));
  const child = spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--mock', '--fake-host', '--no-open', '--stop-on-stdin', '--data-dir', dataDir,
    '--feedback-dir', path.join(root, 'feedback'), '--profile', path.join(REPO, 'tests', 'fixtures', 'project', 'profile.fixture.json')], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_HOST_EXE: path.join(root, 'no-host.exe'), UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host') },
  });
  t.after(() => killChildTree(child));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 600 && !/UI at http:\/\/127\.0\.0\.1:\d+\//.test(out); i++) await sleep(50);
  const uiPort = Number(/UI at http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)?.[1]);
  const corePort = Number(/event core is reached through port (\d+)/.exec(out)?.[1]);
  assert.ok(uiPort && corePort, out.slice(-2000));
  let id = 0;
  const swap = (service) => new Promise((resolve) => {
    const my = ++id;
    const on = (m) => { if (m?.t === 'ujwalam-swap' && m.id === my) { child.off('message', on); resolve(m); } };
    child.on('message', on);
    child.send({ t: 'ujwalam-swap', id: my, service, root: REPO });
  });
  const results = [];
  for (let i = 0; i < 3; i++) { results.push((await swap('event-core')).result); results.push((await swap('studio-ui')).result); }
  const host = await swap('host');
  const api = JSON.parse(readFileSync(path.join(dataDir, 'api.json'), 'utf8'));
  const page = await new Promise((resolve) => { http.get({ host: '127.0.0.1', port: uiPort, path: '/', agent: false }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0)); });
  child.stdin.end();
  const code = await new Promise((r) => child.once('exit', r));
  assert.deepEqual(results, Array(6).fill('swapped'), out.slice(-3000));
  assert.equal(host.result, 'refused');
  assert.equal(api.port, corePort, 'clients discover the front port, never a process port');
  assert.ok(page > 0 && page < 500, `UI answers on its port after the swaps (${page})`);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /stopping Ujwalam|did not start/);
});
