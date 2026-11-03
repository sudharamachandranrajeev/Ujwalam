// SPDX-License-Identifier: GPL-2.0-or-later
// P3 E2: Windows Credential Manager provider. Creates and deletes a clearly test-only credential.
// P3 E7 follow-up: the read is asynchronous (no spawnSync), the provider caches for the connector's lifetime and
// re-reads after an auth failure, and a reconnect with a slow read keeps the event loop responsive (< 100 ms delay).
// All secrets here are invented test values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openMocks, startMockStreamerbot } from '../tools/mock/mock-streamerbot.mjs';
import { createEventCore } from '../services/event-core/index.mjs';
import { createStreamerbotConnector } from '../services/event-core/streamerbot/connector.mjs';
import { CHILD_ENV_KEYS, createCredentialStore, credentialChildEnv, credentialProvider } from '../services/event-core/streamerbot/credential.mjs';

// Every mock started by this file must be closed when it ends.
test.after(() => assert.equal(openMocks(), 0, 'a mock Streamer.bot was left open'));
const win = process.platform === 'win32';
// Test-only resource name: never the default production name.
const testName = () => `Ujwalam-TEST-ONLY-${process.pid}-${randomBytes(4).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(10); return fn(); };
const LOOP_LIMIT_MS = 100;
/** A blocking (synchronous) read would stall the loop for the whole read, so the limit scales with the measured read
 *  time: half of it, never below LOOP_LIMIT_MS. A fixed 100 ms failed a correct run on a loaded machine (145 ms of
 *  scheduler noise during a ~1 s PowerShell read); a sync read is still caught because its stall is ~the full read. */
const loopLimit = (readMs) => Math.max(LOOP_LIMIT_MS, readMs / 2);
const FAKE_READ_MS = 500;

/** Max event-loop delay (ms) while fn runs: the larger of perf_hooks monitorEventLoopDelay (10 ms resolution) and a
 *  5 ms interval gap probe. Under the test runner on Windows the histogram missed a 300 ms block (max 10.9 ms, 5
 *  samples; cause UNVERIFIED) while the probe saw it (299 ms), so both are taken. Both stay on 50 ms after fn, so a
 *  block just before the end is still recorded. */
async function maxLoopDelay(fn) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  let last = performance.now();
  let gap = 0;
  const probe = setInterval(() => { const n = performance.now(); gap = Math.max(gap, n - last - 5); last = n; }, 5);
  h.enable();
  try { await fn(); await sleep(50); } finally { h.disable(); clearInterval(probe); }
  return Math.max(h.max / 1e6, gap);
}

test('credential: the module has no synchronous child process or fs call', () => {
  const src = readFileSync(fileURLToPath(new URL('../services/event-core/streamerbot/credential.mjs', import.meta.url)), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\b(spawnSync|execSync|execFileSync|readFileSync|writeFileSync)\b/);
  assert.match(code, /shell: false/);
  // the secret goes through stdin only: never in the argument list or the environment
  assert.match(code, /\['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED\]/);
  // E8-09: by absolute path from a validated %SystemRoot%, never by bare name
  assert.match(code, /systemTool\('WindowsPowerShell', 'v1\.0', 'powershell\.exe'\)/);
  assert.match(code, /spawn\(exe, /);
  assert.doesNotMatch(code, /spawn\('powershell/);
  // E4b review finding 10: a minimal environment, never the whole process.env
  assert.match(code, /env: credentialChildEnv\(op, target\)/);
  assert.doesNotMatch(code, /\.\.\.process\.env/);
});

test('credential: the child environment is minimal; a sentinel variable (API-token-like) is not passed', () => {
  const base = {
    SystemRoot: 'sysroot', windir: 'sysroot', Path: 'sysroot-bin', TEMP: 'tmp', TMP: 'tmp',
    UJW_SENTINEL_E4B: 'sentinel-value-e4b', UJWALAM_API_TOKEN: 'token-like-e4b', PSModulePath: 'pwsh7-modules', NODE_OPTIONS: '--x',
  };
  const env = credentialChildEnv('get', 'Ujwalam-TEST', base);
  assert.deepEqual(Object.keys(env).sort(), ['Path', 'SystemRoot', 'TEMP', 'TMP', 'UJW_CRED_OP', 'UJW_CRED_TARGET', 'windir']);
  for (const k of Object.keys(env)) assert.ok(CHILD_ENV_KEYS.includes(k) || k === 'UJW_CRED_OP' || k === 'UJW_CRED_TARGET', k);
  assert.equal(JSON.stringify(env).includes('sentinel-value-e4b'), false);
  assert.equal(JSON.stringify(env).includes('token-like-e4b'), false);
  assert.deepEqual([env.UJW_CRED_OP, env.UJW_CRED_TARGET], ['get', 'Ujwalam-TEST']);
  assert.equal(credentialChildEnv('get', 'Ujwalam-TEST', { path: 'p' }).Path, 'p', 'case-insensitive lookup for a plain object');
});

test('credential: a real PowerShell child started with that environment cannot see a sentinel variable (Windows)', { skip: !win && 'Windows only' }, async () => {
  const { spawn } = await import('node:child_process');
  process.env.UJW_SENTINEL_E4B = 'sentinel-value-e4b';
  try {
    const ps = '[Console]::Out.Write("[" + $env:UJW_SENTINEL_E4B + "]" + [bool]$env:SystemRoot + "|" + $env:UJW_CRED_OP)';
    const out = await new Promise((resolve, reject) => {
      const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
        env: credentialChildEnv('get', 'Ujwalam-TEST-ONLY-env'), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false,
      });
      const chunks = [];
      c.stdout.on('data', (d) => chunks.push(d));
      c.on('error', reject);
      c.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    assert.equal(out, '[]True|get');
  } finally { delete process.env.UJW_SENTINEL_E4B; }
});

test('credential: target names must start with "Ujwalam" (rejects, does not throw)', async () => {
  const p = createCredentialStore('SomethingElse').get();
  assert.ok(p instanceof Promise);
  await assert.rejects(p, win ? /credential-bad-target/ : /unsupported-platform/);
});

test('credential: set, get, overwrite, delete round trip (Windows)', { skip: !win && 'Windows only' }, async () => {
  const s = createCredentialStore(testName());
  try {
    assert.equal(await s.get(), null);
    await s.set('päss "q" $x `y`');
    assert.equal(await s.get(), 'päss "q" $x `y`');
    await s.set('second');
    assert.equal(await s.get(), 'second');
    assert.equal(await s.delete(), true);
    assert.equal(await s.get(), null);
    assert.equal(await s.delete(), false);
  } finally { try { await s.delete(); } catch { /* best-effort cleanup */ } }
});

// Review E8-16: the secret crosses the PowerShell boundary as base64 of UTF-8, independent of the console code page.
test('E8-16 credential: non-ASCII passwords (CJK, euro, emoji, sharp s, RTL) round-trip exactly; TEST-ONLY target, deleted after (Windows)', { skip: !win && 'Windows only' }, async () => {
  const s = createCredentialStore(testName());
  try {
    for (const pw of ['密码€😀ß', 'كلمة-סיסמה-123', 'tab\tand "quotes" and $env:X and `n', ' leading and trailing spaces ']) {
      await s.set(pw);
      assert.equal(await s.get(), pw);
    }
  } finally { assert.equal(await s.delete(), true); }
  assert.equal(await s.get(), null);
});

test('E8-09 credential: a bogus %SystemRoot% fails closed with a code, nothing spawned from PATH (Windows)', { skip: !win && 'Windows only' }, async () => {
  const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  process.env.SystemRoot = 'C:\\no-such-system-root'; delete process.env.windir;
  try {
    await assert.rejects(createCredentialStore(testName()).get(), /credential-spawn-failed: no-system-powershell/);
  } finally { process.env.SystemRoot = saved.SystemRoot; process.env.windir = saved.windir; }
});

test('credential: the real async read keeps the event loop free (Windows, nothing stored)', { skip: !win && 'Windows only' }, async (t) => {
  const s = createCredentialStore(testName());
  let v;
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 10);
  const t0 = performance.now();
  const max = await maxLoopDelay(async () => { v = await s.get(); });
  const took = performance.now() - t0;
  clearInterval(iv);
  assert.equal(v, null);
  assert.ok(max < loopLimit(took), `max loop delay ${max.toFixed(1)} ms (limit ${loopLimit(took).toFixed(0)} ms, read ${took.toFixed(0)} ms)`);
  assert.ok(ticks >= 3, `timers kept firing during the read (${ticks} ticks in ${took.toFixed(0)} ms)`);
  t.diagnostic(`real read: ${took.toFixed(0)} ms, max loop delay ${max.toFixed(1)} ms, ${ticks} timer ticks`);
});

test('provider: caches a secret, shares one read, never caches null or errors, invalidate() re-reads', async () => {
  let reads = 0;
  let next = 'sekret-1';
  const store = { get: async () => { reads++; await sleep(20); if (next instanceof Error) throw next; return next; } };
  const p = credentialProvider('Ujwalam-TEST-ONLY', { store });
  const [a, b] = await Promise.all([p(), p()]);
  assert.deepEqual([a, b, reads, p.cached()], ['sekret-1', 'sekret-1', 1, true]);
  assert.equal(await p(), 'sekret-1');
  assert.equal(reads, 1);
  p.invalidate();
  next = 'sekret-2';
  assert.equal(await p(), 'sekret-2');
  assert.equal(reads, 2);
  p.invalidate(); next = null;
  assert.equal(await p(), null);
  assert.equal(await p(), null);
  assert.equal(reads, 4); // null is not cached
  next = new Error('credential-read-failed: win32 5');
  await assert.rejects(p(), /credential-read-failed/);
  assert.equal(p.cached(), false);
  // invalidate during an in-flight read: that read's value is not cached
  next = 'sekret-3';
  const inflight = p();
  p.invalidate();
  assert.equal(await inflight, 'sekret-3');
  assert.equal(p.cached(), false);
  const off = credentialProvider('Ujwalam-TEST-ONLY', { store, cache: false });
  const before = reads;
  await off(); await off();
  assert.equal(reads - before, 2);
});

test('connector: reconnect with a slow (500 ms) password read keeps the loop free (max delay < half the read); cache skips re-reads', async (t) => {
  const mock = await startMockStreamerbot({ password: 'slow-secret' });
  const core = createEventCore({ key: randomBytes(32) });
  let reads = 0;
  const store = { get: () => { reads++; return new Promise((r) => setTimeout(() => r('slow-secret'), FAKE_READ_MS)); } };
  const getPassword = credentialProvider('Ujwalam-TEST-ONLY', { store });
  const sb = createStreamerbotConnector({ core, url: mock.url, getPassword, backoff: { baseMs: 20, capMs: 40 } });
  try {
    const first = await maxLoopDelay(async () => { sb.start(); assert.ok(await until(() => sb.state() === 'connected')); });
    assert.equal(reads, 1);
    assert.ok(first < loopLimit(FAKE_READ_MS), `first connect: max loop delay ${first.toFixed(1)} ms`);
    // drop the connection: the connector reconnects and authenticates from the cache
    const again = await maxLoopDelay(async () => {
      mock.kill();
      assert.ok(await until(() => sb.state() !== 'connected'));
      assert.ok(await until(() => sb.state() === 'connected'));
    });
    assert.equal(reads, 1, 'reconnect used the cached secret');
    assert.ok(again < loopLimit(FAKE_READ_MS), `reconnect: max loop delay ${again.toFixed(1)} ms`);
    assert.deepEqual(mock.authLog, ['ok', 'ok']);
    t.diagnostic(`fake 500 ms read: first connect max delay ${first.toFixed(1)} ms, reconnect ${again.toFixed(1)} ms, reads ${reads}`);
  } finally {
    sb.stop();
    await mock.close();
  }
});

test('connector: an uncached reconnect with a slow read (cache off) also keeps the loop free and reads each time', async () => {
  const mock = await startMockStreamerbot({ password: 'slow-secret' });
  const core = createEventCore({ key: randomBytes(32) });
  let reads = 0;
  const store = { get: () => { reads++; return new Promise((r) => setTimeout(() => r('slow-secret'), FAKE_READ_MS)); } };
  const getPassword = credentialProvider('Ujwalam-TEST-ONLY', { store, cache: false });
  const sb = createStreamerbotConnector({ core, url: mock.url, getPassword, backoff: { baseMs: 20, capMs: 40 } });
  try {
    sb.start();
    assert.ok(await until(() => sb.state() === 'connected'));
    const max = await maxLoopDelay(async () => {
      mock.kill();
      assert.ok(await until(() => sb.state() !== 'connected'));
      assert.ok(await until(() => sb.state() === 'connected'));
    });
    assert.equal(reads, 2);
    assert.ok(max < loopLimit(FAKE_READ_MS), `max loop delay ${max.toFixed(1)} ms`);
  } finally {
    sb.stop();
    await mock.close();
  }
});

test('control: a blocking (synchronous 300 ms) read IS caught by the same measurement', async () => {
  const mock = await startMockStreamerbot({ password: 'slow-secret' });
  const core = createEventCore({ key: randomBytes(32) });
  const busy = () => { const t = performance.now(); while (performance.now() - t < 300) { /* blocks, like spawnSync did */ } return 'slow-secret'; };
  const sb = createStreamerbotConnector({ core, url: mock.url, getPassword: async () => busy(), backoff: { baseMs: 20, capMs: 40 } });
  try {
    const max = await maxLoopDelay(async () => { sb.start(); assert.ok(await until(() => sb.state() === 'connected')); });
    assert.ok(max >= 250, `the monitor saw the block (${max.toFixed(1)} ms)`);
  } finally {
    sb.stop();
    await mock.close();
  }
});

test('connector: an auth failure invalidates the cache; a failing read stops with a code, no loop', async () => {
  const mock = await startMockStreamerbot({ password: 'right' });
  const core = createEventCore({ key: randomBytes(32) });
  const notes = [];
  let value = 'wrong';
  let reads = 0;
  const store = { get: async () => { reads++; if (value instanceof Error) throw value; return value; } };
  const getPassword = credentialProvider('Ujwalam-TEST-ONLY', { store });
  const sb = createStreamerbotConnector({ core, url: mock.url, getPassword, backoff: { baseMs: 20, capMs: 40 }, onNote: (l, c) => notes.push(c) });
  try {
    sb.start();
    assert.ok(await until(() => sb.state() === 'auth-failed'));
    assert.equal(getPassword.cached(), false); // the wrong secret is forgotten
    sb.stop();
    value = 'right';
    sb.start();
    assert.ok(await until(() => sb.state() === 'connected'));
    assert.equal(reads, 2);
    sb.stop();
    getPassword.invalidate();
    value = new Error('credential-read-failed: win32 5');
    sb.start();
    assert.ok(await until(() => sb.state() === 'auth-failed'));
    assert.ok(notes.includes('auth-password-read-failed'));
    for (const n of notes) assert.match(n, /^[a-z-]+$/); // codes only
  } finally {
    sb.stop();
    await mock.close();
  }
});

test('credential: provider feeds the auth handshake (Windows)', { skip: !win && 'Windows only' }, async (t) => {
  const name = testName();
  const store = createCredentialStore(name);
  const mock = await startMockStreamerbot({ password: 'stored-secret' });
  const core = createEventCore({ key: randomBytes(32) });
  const sb = createStreamerbotConnector({ core, url: mock.url, getPassword: credentialProvider(name), backoff: { baseMs: 20, capMs: 80 } });
  try {
    // 1: nothing stored -> stop, no loop (its duration is one real read: the scale for the loop limit below)
    const r0 = performance.now();
    sb.start();
    assert.ok(await until(() => sb.state() === 'auth-failed'));
    const readMs = performance.now() - r0;
    sb.stop();
    // 2: stored -> connects; a reconnect over the real async path keeps the loop free
    await store.set('stored-secret');
    const max = await maxLoopDelay(async () => {
      sb.start();
      assert.ok(await until(() => sb.state() === 'connected'));
      mock.kill();
      assert.ok(await until(() => sb.state() !== 'connected'));
      assert.ok(await until(() => sb.state() === 'connected'));
    });
    assert.deepEqual(mock.authLog, ['ok', 'ok']);
    assert.ok(max < loopLimit(readMs), `real read + reconnect: max loop delay ${max.toFixed(1)} ms (limit ${loopLimit(readMs).toFixed(0)} ms, read ${readMs.toFixed(0)} ms)`);
    t.diagnostic(`real credential connect + reconnect: max loop delay ${max.toFixed(1)} ms`);
  } finally {
    sb.stop();
    await mock.close();
    try { await store.delete(); } catch { /* best-effort cleanup */ }
  }
  assert.equal(await store.get(), null);
});

test('credential CLI: stdin path, status never prints the secret, delete (Windows)', { skip: !win && 'Windows only' }, async () => {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'services', 'event-core', 'cli.mjs');
  const run = (args, input) => new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, 'credential', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
    c.stdin.end(input ?? '');
  });
  const name = testName();
  const store = createCredentialStore(name);
  const SECRET = 'cli-secret-ä-123';
  try {
    // stdin is a pipe, not a terminal: refused without --stdin, nothing stored
    let r = await run(['set', '--target', name], `${SECRET}\n`);
    assert.equal(r.code, 1);
    assert.match(r.out, /not a terminal/);
    assert.equal(await store.get(), null);
    r = await run(['status', '--target', name]);
    assert.match(r.out, /not set/);
    r = await run(['set', '--stdin', '--target', name], `${SECRET}\r\nignored second line\n`);
    assert.equal(r.code, 0);
    assert.ok(!r.out.includes(SECRET));
    assert.equal(await store.get(), SECRET);
    r = await run(['status', '--target', name]);
    assert.match(r.out, /credential: set/);
    assert.ok(!r.out.includes('cli-secret'));
    r = await run(['set', '--stdin', '--target', name], '\n');
    assert.equal(r.code, 1);
    assert.equal(await store.get(), SECRET); // empty input does not overwrite
    r = await run(['delete', '--target', name]);
    assert.match(r.out, /deleted/);
    assert.equal(await store.get(), null);
    r = await run(['set', '--stdin', '--target', 'NotOurs'], 'x\n');
    assert.equal(r.code, 1); // target must start with "Ujwalam"
    assert.match(r.out, /credential-bad-target/);
  } finally { try { await store.delete(); } catch { /* best-effort cleanup */ } }
});
