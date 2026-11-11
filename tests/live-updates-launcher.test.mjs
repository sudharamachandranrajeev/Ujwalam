// SPDX-License-Identifier: GPL-3.0-or-later
// LU5 host staging with the real launcher (D343): the fake host (tests/fixtures/studio-ui/fake-host.mjs) records while
// "live"; a host update from a staged fixture release (temp folder) arrives over the launcher's IPC channel, is staged
// (from a checked private copy) and applied only after the user's stop (a fresh outputs.status with everything
// stopped). A service update while live waits for a click, also after the stop. Closing with a staged host update
// tries it at the next start; a broken one is rejected there and the installed host starts instead, and it is never
// tried again (Codex review of D343). A broken host update while running is rolled back to the previous host. No
// window (UJWALAM_HEADLESS=1, windowsHide), no device, nothing outside temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChildTree } from '../services/common/kill-tree.mjs';
import { folderFiles, releaseParts } from '../services/supervisor/parts.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'tests', 'fixtures');
const FAKE_HOST = path.join(FIX, 'studio-ui', 'fake-host.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return v; await sleep(50); } }
const partsOf = (root) => releaseParts(folderFiles(root).filter((f) => f.rel !== 'release.json'));

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
  const copies = path.join(dataDir, 'live', 'releases');
  return { root, dataDir, env, args, calls, live, children, copies };
}

function stagedRelease(dir, { n = 99, broken = false } = {}) {
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const exe = path.join(dir, 'bin', 'ujwalam-host.mjs');
  if (broken) writeFileSync(exe, 'process.exit(3);\n'); else copyFileSync(FAKE_HOST, exe);
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: `0.1.0-alpha.${n}`, n, hostExeSha256: createHash('sha256').update(readFileSync(exe)).digest('hex'), parts: partsOf(dir) }));
  return dir;
}
function serviceRelease(dir, { n = 99 } = {}) {
  for (const s of ['event-core', 'studio-ui']) { mkdirSync(path.join(dir, 'services', s), { recursive: true }); writeFileSync(path.join(dir, 'services', s, 'cli.mjs'), `// stand-in ${s}\n`); }
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: `0.1.0-alpha.${n}`, n, parts: partsOf(dir) }));
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

test('LU5: a host update during a recording is staged, not applied while live, and applied after the stop; a service update waits for a click, also after the stop', { timeout: 120_000 }, async (t) => {
  const s = setup(t, 'stage');
  const stopFile = path.join(s.root, 'stop');
  const rel = stagedRelease(path.join(s.root, 'release'));
  const l = await launch(t, s, { UJWALAM_FAKE_HOST_RECORDING: '1', UJWALAM_FAKE_HOST_STOP_ON: stopFile });
  const host = await l.ask('host', rel);
  assert.equal(host.result, 'staged', l.out.slice(-2000));
  const svc = await l.ask('event-core', serviceRelease(path.join(s.root, 'svc'), { n: 98 }));
  assert.equal(svc.result, 'waiting', l.out.slice(-2000));
  const m = s.live('updates.json');
  assert.deepEqual(m.waiting.map((w) => [w.part, w.version, w.click]), [['host', '0.1.0-alpha.99', false], ['event-core', '0.1.0-alpha.98', true]]);
  assert.equal(m.parts.find((p) => p.part === 'host').version, 'dev');
  assert.equal(s.live('host-update.json').pending.n, 99);
  await sleep(1500); // several queue polls while the recording runs
  assert.deepEqual(s.calls().filter((c) => c.event === 'start').map((c) => c.run), [1], 'the host was not touched while live');
  writeFileSync(stopFile, 'stop'); // the user's Stop
  assert.ok(await until(() => s.calls().filter((c) => c.event === 'start').length === 2), l.out.slice(-3000));
  assert.ok(await until(() => s.live('updates.json')?.waiting.length === 1 && /\(host\) updated to 0\.1\.0-alpha\.99/.test(l.out)), l.out.slice(-3000));
  const starts = s.calls().filter((c) => c.event === 'start');
  assert.ok(starts[1].dir.startsWith(s.copies), 'the new host runs from the checked copy of the staged release');
  const all = s.calls();
  const stopIdx = all.findIndex((c) => c.event === 'stopped-by-user');
  assert.ok(stopIdx >= 0 && stopIdx < all.findIndex((c) => c.event === 'start' && c.run === 2), 'applied only after the stop');
  const after = s.live('updates.json');
  assert.equal(after.parts.find((p) => p.part === 'host').version, '0.1.0-alpha.99');
  assert.equal(after.parts.find((p) => p.part === 'overlay-server').version, '0.1.0-alpha.99');
  assert.deepEqual(after.waiting.map((w) => w.part), ['event-core'], 'the stop does not apply a service: it waits for the click');
  assert.doesNotMatch(l.out, /Event core updated/);
  const st = s.live('host-update.json');
  assert.deepEqual([st.pending, st.good.n], [null, 99]);
  const code = await l.close();
  assert.equal(code, 0, l.out.slice(-3000));
  assert.match(l.out, /event-core update 0\.1\.0-alpha\.98 not applied \(Ujwalam closed\)/);
  assert.doesNotMatch(l.out, /HOST EXITED UNEXPECTEDLY|HOST CRASHED|shut itself down/, 'a planned restart is not a crash');
  assert.doesNotMatch(l.out, /[0-9a-f]{64}/, 'no token-shaped value printed');
});

test('LU5: closing the app with a staged host update tries it at the next start', { timeout: 120_000 }, async (t) => {
  const s = setup(t, 'close');
  const rel = stagedRelease(path.join(s.root, 'release'), { n: 42 });
  const a = await launch(t, s, { UJWALAM_FAKE_HOST_RECORDING: '1' });
  assert.equal((await a.ask('host', rel)).result, 'staged');
  assert.equal(await a.close(), 0);
  assert.match(a.out, /host update 0\.1\.0-alpha\.42 waits: it is tried at the next start/);
  assert.equal(s.calls().filter((c) => c.event === 'start').length, 1, 'not applied while live, not at the close');
  const b = await launch(t, s);
  assert.match(b.out, /host update 0\.1\.0-alpha\.42 staged before the last close is tried now/);
  assert.match(b.out, /host update 0\.1\.0-alpha\.42 started and is now the last good host/);
  const starts = s.calls().filter((c) => c.event === 'start');
  assert.ok(starts.at(-1).dir.startsWith(s.copies));
  assert.ok(await until(() => s.live('updates.json')?.parts?.find((p) => p.part === 'host')?.version === '0.1.0-alpha.42'));
  assert.deepEqual([s.live('host-update.json').pending, s.live('host-update.json').good.n], [null, 42]);
  assert.equal(await b.close(), 0);
});

test('P1-3: a broken host staged at close is rejected at the next start, the installed host starts, and it is never tried again', { timeout: 120_000 }, async (t) => {
  const s = setup(t, 'trial');
  const bad = stagedRelease(path.join(s.root, 'bad'), { n: 43, broken: true });
  const a = await launch(t, s, { UJWALAM_FAKE_HOST_RECORDING: '1' });
  assert.equal((await a.ask('host', bad)).result, 'staged');
  assert.equal(await a.close(), 0);
  const b = await launch(t, s);
  assert.match(b.out, /host update 0\.1\.0-alpha\.43 did not start \(the host did not get ready\); it is not tried again/);
  assert.match(b.out, /starting the installed host/);
  const starts = s.calls().filter((c) => c.event === 'start');
  assert.equal(starts.at(-1).dir, path.dirname(FAKE_HOST), 'the installed host runs');
  const st = s.live('host-update.json');
  assert.deepEqual([st.pending, st.good, st.rejected.map((r) => r.n)], [null, null, [43]]);
  assert.ok(await until(() => s.live('updates.json')?.parts?.find((p) => p.part === 'host')?.version === 'dev'));
  assert.equal(await b.close(), 0);
  const c = await launch(t, s);
  assert.doesNotMatch(c.out, /0\.1\.0-alpha\.43/, 'not tried again');
  assert.equal(await c.close(), 0);
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
  const st = s.live('host-update.json');
  assert.deepEqual([st.pending, st.good, st.rejected.map((x) => x.n)], [null, null, [77]], 'nothing for the next start; never tried again');
  assert.equal(await l.close(), 0);
  assert.doesNotMatch(l.out, /HOST CRASHED/);
});

test('Codex re-review 2: the copy is read-only, and a copy changed after the queue check (while the old host shuts down) is hashed again before the spawn: not started, rejected, the previous host comes back', { timeout: 120_000 }, async (t) => {
  const s = setup(t, 'rehash');
  const stopFile = path.join(s.root, 'stop');
  const pointer = path.join(s.root, 'tamper.txt');
  const rel = stagedRelease(path.join(s.root, 'release'), { n: 55 });
  const l = await launch(t, s, { UJWALAM_FAKE_HOST_RECORDING: '1', UJWALAM_FAKE_HOST_STOP_ON: stopFile, UJWALAM_FAKE_HOST_TAMPER_ON_SHUTDOWN: pointer });
  assert.equal((await l.ask('host', rel)).result, 'staged', l.out.slice(-2000));
  const exe = path.join(s.live('host-update.json').pending.root, 'bin', 'ujwalam-host.mjs');
  assert.throws(() => appendFileSync(exe, '// x\n'), /EPERM|EACCES/, 'the copied release files are read-only');
  writeFileSync(pointer, exe); // the old host changes the copy while it shuts down (after the queue's own check)
  writeFileSync(stopFile, 'stop');
  assert.ok(await until(() => s.live('host-update.json')?.rejected?.some((r) => r.n === 55)), l.out.slice(-3000));
  assert.ok(await until(() => s.calls().filter((c) => c.event === 'start').length === 2), l.out.slice(-3000));
  const starts = s.calls().filter((c) => c.event === 'start');
  assert.equal(starts[1].dir, path.dirname(FAKE_HOST), 'the previous host started again; the changed copy never ran');
  assert.match(l.out, /its files changed before it started/);
  assert.equal(s.live('host-update.json').pending, null);
  assert.equal(await l.close(), 0);
});

test('Codex review of the merge: a final hash that cannot read the copy after the old host exited restarts the old host; the versions follow the host that runs', { timeout: 120_000 }, async (t) => {
  const s = setup(t, 'throw');
  const stopFile = path.join(s.root, 'stop');
  const pointer = path.join(s.root, 'tamper.txt');
  const rel = stagedRelease(path.join(s.root, 'release'), { n: 56 });
  const l = await launch(t, s, { UJWALAM_FAKE_HOST_RECORDING: '1', UJWALAM_FAKE_HOST_STOP_ON: stopFile, UJWALAM_FAKE_HOST_TAMPER_ON_SHUTDOWN: pointer });
  assert.equal((await l.ask('host', rel)).result, 'staged', l.out.slice(-2000));
  // While the old host shuts down, the copy's exe becomes a folder: the last hash's read throws (EISDIR).
  writeFileSync(pointer, `dir:${path.join(s.live('host-update.json').pending.root, 'bin', 'ujwalam-host.mjs')}`);
  writeFileSync(stopFile, 'stop');
  assert.ok(await until(() => s.live('host-update.json')?.rejected?.some((r) => r.n === 56)), l.out.slice(-3000));
  assert.ok(await until(() => s.calls().filter((c) => c.event === 'start').length === 2), l.out.slice(-3000));
  assert.equal(s.calls().filter((c) => c.event === 'start')[1].dir, path.dirname(FAKE_HOST), 'the previous host was started again');
  assert.match(l.out, /could not be read \(EISDIR\)/);
  assert.match(l.out, /starting the previous host again/);
  assert.ok(await until(() => s.live('updates.json')?.parts?.find((p) => p.part === 'host')?.version === 'dev'), 'the version is the running host\'s');
  assert.equal(s.live('host-update.json').pending, null);
  assert.equal(await l.close(), 0);
  assert.doesNotMatch(l.out, /HOST CRASHED|HOST EXITED UNEXPECTEDLY/);
});
