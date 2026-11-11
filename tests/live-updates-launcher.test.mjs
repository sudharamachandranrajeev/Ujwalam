// SPDX-License-Identifier: GPL-3.0-or-later
// LU5 host staging with the real launcher (D343): the fake host (tests/fixtures/studio-ui/fake-host.mjs) records while
// "live"; a host update from a staged fixture release (temp folder) arrives over the launcher's IPC channel, is staged
// and applied only after the user's stop (a fresh outputs.status with everything stopped). A service update while live
// waits for a click. Closing with a staged host update starts the next session from it. A broken host update is rolled
// back to the previous host. No window (UJWALAM_HEADLESS=1, windowsHide), no device, nothing outside temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChildTree } from '../services/common/kill-tree.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'tests', 'fixtures');
const FAKE_HOST = path.join(FIX, 'studio-ui', 'fake-host.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return v; await sleep(50); } }

function setup(t, name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `ujw-lu5-${name}-`));
  const children = [];
  // One hook, children first: a launcher left running would keep the test process alive.
  t.after(() => { for (const c of children) killChildTree(c); try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp folder */ } });
  const dataDir = path.join(root, 'core');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'service-swap': true } }));
  const rec = path.join(root, 'record.json');
  const env = {
    ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), UJWALAM_OVERLAY_ROOT: path.join(root, 'no-overlays'),
    UJWALAM_FAKE_HOST_RECORD: rec, UJWALAM_FAKE_HOST_RUNS: path.join(root, 'runs.txt'), UJWALAM_HOST_WATCH_MS: '200', UJWALAM_UPDATE_POLL_MS: '200',
    UJWALAM_HOST_UPDATE_READY_MS: '8000', UJWALAM_HOST_EXE: '', UJWALAM_HOST_BUILD: '',
  };
  const args = [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--mock', '--no-open', '--stop-on-stdin', '--data-dir', dataDir, '--host-exe', FAKE_HOST,
    '--profile', path.join(FIX, 'project', 'profile.fixture.json'), '--feedback-dir', path.join(root, 'feedback')];
  const calls = () => { try { return readFileSync(`${rec}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const live = (n) => { try { return JSON.parse(readFileSync(path.join(dataDir, 'live', n), 'utf8')); } catch { return null; } };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k]; // the launcher is not a test-runner child
  return { root, dataDir, env, args, calls, live, children };
}

function stagedRelease(dir, { n = 99, broken = false } = {}) {
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const exe = path.join(dir, 'bin', 'ujwalam-host.mjs');
  if (broken) writeFileSync(exe, 'process.exit(3);\n'); else copyFileSync(FAKE_HOST, exe);
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: `0.1.0-alpha.${n}`, n, hostExeSha256: createHash('sha256').update(readFileSync(exe)).digest('hex') }));
  return dir;
}

async function launch(t, s, extraEnv = {}) {
  const child = spawn(process.execPath, s.args, { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: { ...s.env, ...extraEnv } });
  s.children.push(child);
  const o = { child, out: '' };
  child.stdout.on('data', (d) => { o.out += d; });
  child.stderr.on('data', (d) => { o.out += d; });
  assert.ok(await until(() => /UI at http:\/\/127\.0\.0\.1:\d+\//.test(o.out), 60_000), o.out.slice(-3000));
  let id = 0;
  o.ask = (service, root) => new Promise((resolve) => {
    const my = ++id;
    const on = (m) => { if (m?.t === 'ujwalam-swap' && m.id === my) { child.off('message', on); resolve(m); } };
    child.on('message', on);
    child.send({ t: 'ujwalam-swap', id: my, service, root });
  });
  o.close = async () => { child.stdin.end(); return new Promise((r) => child.once('exit', r)); };
  return o;
}

test('LU5: a host update during a recording is staged, not applied while live, and applied after the stop; a service update waits for a click', { timeout: 120_000 }, async (t) => {
  const s = setup(t, 'stage');
  const stopFile = path.join(s.root, 'stop');
  const rel = stagedRelease(path.join(s.root, 'release'));
  const l = await launch(t, s, { UJWALAM_FAKE_HOST_RECORDING: '1', UJWALAM_FAKE_HOST_STOP_ON: stopFile });
  const host = await l.ask('host', rel);
  assert.equal(host.result, 'staged', l.out.slice(-2000));
  const svc = await l.ask('event-core', REPO);
  assert.equal(svc.result, 'waiting');
  const m = s.live('updates.json');
  assert.deepEqual(m.waiting.map((w) => [w.part, w.version, w.click]), [['host', '0.1.0-alpha.99', false], ['event-core', 'unversioned', true]]);
  assert.equal(m.parts.find((p) => p.part === 'host').version, 'dev');
  assert.equal(s.live('host-update.json').state, 'staged');
  await sleep(1500); // several queue polls while the recording runs
  assert.deepEqual(s.calls().filter((c) => c.event === 'start').map((c) => c.run), [1], 'the host was not touched while live');
  writeFileSync(stopFile, 'stop'); // the user's Stop
  assert.ok(await until(() => s.calls().filter((c) => c.event === 'start').length === 2), l.out.slice(-3000));
  assert.ok(await until(() => s.live('updates.json')?.waiting.length === 0 && /\(host\) updated to 0\.1\.0-alpha\.99/.test(l.out)), l.out.slice(-3000));
  const starts = s.calls().filter((c) => c.event === 'start');
  assert.equal(starts[1].dir, path.join(rel, 'bin'), 'the new host runs from the staged release');
  const all = s.calls();
  const stopIdx = all.findIndex((c) => c.event === 'stopped-by-user');
  assert.ok(stopIdx >= 0 && stopIdx < all.findIndex((c) => c.event === 'start' && c.run === 2), 'applied only after the stop');
  const after = s.live('updates.json');
  assert.equal(after.parts.find((p) => p.part === 'host').version, '0.1.0-alpha.99');
  assert.equal(after.parts.find((p) => p.part === 'overlay-server').version, '0.1.0-alpha.99');
  assert.equal(s.live('host-update.json').state, 'applied');
  const code = await l.close();
  assert.equal(code, 0, l.out.slice(-3000));
  assert.doesNotMatch(l.out, /HOST EXITED UNEXPECTEDLY|HOST CRASHED|shut itself down/, 'a planned restart is not a crash');
  assert.doesNotMatch(l.out, /[0-9a-f]{64}/, 'no token-shaped value printed');
});

test('LU5: closing the app with a staged host update applies it at the next start', { timeout: 120_000 }, async (t) => {
  const s = setup(t, 'close');
  const rel = stagedRelease(path.join(s.root, 'release'), { n: 42 });
  const a = await launch(t, s, { UJWALAM_FAKE_HOST_RECORDING: '1' });
  assert.equal((await a.ask('host', rel)).result, 'staged');
  assert.equal(await a.close(), 0);
  assert.match(a.out, /host update 0\.1\.0-alpha\.42 waits: it is applied at the next start/);
  assert.equal(s.calls().filter((c) => c.event === 'start').length, 1, 'not applied while live, not at the close');
  const b = await launch(t, s);
  assert.match(b.out, /host update 0\.1\.0-alpha\.42 staged before the last close is applied now/);
  const starts = s.calls().filter((c) => c.event === 'start');
  assert.equal(starts.at(-1).dir, path.join(rel, 'bin'));
  assert.ok(await until(() => s.live('updates.json')?.parts?.find((p) => p.part === 'host')?.version === '0.1.0-alpha.42'));
  assert.equal(await b.close(), 0);
});

test('LU5: a host update that does not start is rolled back to the previous host (nothing live: applied at once)', { timeout: 120_000 }, async (t) => {
  const s = setup(t, 'rollback');
  const bad = stagedRelease(path.join(s.root, 'bad'), { n: 77, broken: true });
  const l = await launch(t, s);
  const r = await l.ask('host', bad);
  assert.equal(r.result, 'restored-old', l.out.slice(-3000));
  const starts = s.calls().filter((c) => c.event === 'start');
  assert.equal(starts.length, 2, 'the previous host started again (the broken one logs nothing)');
  assert.equal(starts[1].dir, path.dirname(FAKE_HOST));
  assert.equal(s.live('updates.json').parts.find((p) => p.part === 'host').version, 'dev');
  assert.equal(s.live('host-update.json'), null, 'nothing for the next start');
  assert.equal(await l.close(), 0);
  assert.doesNotMatch(l.out, /HOST CRASHED/);
});
