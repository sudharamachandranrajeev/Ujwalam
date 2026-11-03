// SPDX-License-Identifier: GPL-2.0-or-later
// services/event-core/api: api.json (atomic, owner-only, removed on shutdown), data-dir ACL, env tokens, the service,
// and the serve CLI in mock mode. Temp dirs only; no real platform; invented chat only. ACL checks run on Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { currentUserSid, ensureSecureDir, protectPath, systemTool } from '../services/event-core/config.mjs';
import { API_FILE, ENV_API_TOKEN, ENV_SYSTEM_TOKEN, publishApiFile, startService, tokensFromEnv, writeSecretFileAtomic, SYSTEM_FILE, readSystemFile, pipeSddl, isOwnerOnlySddl, panicViaPipe, pipeRequest } from '../services/event-core/api/index.mjs';
import { raw, rpc, tmp, sleep, cleanup } from './event-core-api-helpers.mjs';

test.after(cleanup);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

/** Principals listed by icacls for a path, e.g. ['DOMAIN\\user'], plus their permission strings. */
function acl(p) {
  const r = spawnSync(systemTool('icacls.exe'), [p], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  const rows = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.split(p).join('').trim();
    const m = /^(.+?):((?:\([A-Z,]+\))+)\s*$/.exec(t);
    if (m) rows.push({ who: m[1], perms: m[2] });
  }
  return rows;
}
const me = () => process.env.USERNAME;

/** { name: SDDL DACL } for p and everything below it (icacls /save), with the current user's SID shown as <ME>. */
function dacls(p) {
  const t = mkdtempSync(path.join(os.tmpdir(), 'acl-save-'));
  try {
    const f = path.join(t, 'acl.txt');
    const r = spawnSync(systemTool('icacls.exe'), [p, '/save', f, '/T', '/C', '/Q'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0);
    const lines = readFileSync(f).toString('utf16le').split(/\r?\n/).filter(Boolean);
    const out = {};
    // /save names entries relative to the parent of p
    for (let i = 0; i < lines.length; i += 2) out[path.join(path.dirname(p), lines[i])] = lines[i + 1].split(currentUserSid()).join('<ME>');
    return out;
  } finally { rmSync(t, { recursive: true, force: true }); }
}
/** Runs fn with %SystemRoot% pointing at a directory with no System32 tools, so every system-tool spawn fails. */
function withBogusSystemRoot(fn) {
  const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  const bogus = tmp();
  process.env.SystemRoot = bogus; process.env.windir = bogus;
  try { return fn(); } finally { process.env.SystemRoot = saved.SystemRoot; process.env.windir = saved.windir; }
}

test('api.json: content, atomic write (no partial reads, no temp files), owner-only ACL', { skip: !win && 'ACL part is Windows; POSIX uses mode 0600' }, async () => {
  const dir = tmp();
  const tokens = { api: 'a1'.repeat(32), system: 'b2'.repeat(32) };
  const f = publishApiFile({ dataDir: dir, port: 4242, tokens });
  assert.equal(f.file, path.join(dir, API_FILE));
  assert.equal(f.protection, 'acl');
  const doc = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.deepEqual(Object.keys(doc).sort(), ['pid', 'port', 'startedAt', 'tokens']);
  assert.equal(doc.port, 4242);
  assert.equal(doc.pid, process.pid);
  assert.deepEqual(doc.tokens, tokens);
  assert.ok(!Number.isNaN(Date.parse(doc.startedAt)));
  const rows = acl(f.file);
  assert.equal(rows.length, 1, JSON.stringify(rows.map((r) => r.perms)));
  assert.ok(rows[0].who.toLowerCase().endsWith(me().toLowerCase()));
  assert.match(rows[0].perms, /\(F\)/);
  assert.deepEqual(readdirSync(dir), [API_FILE]);
  // atomic: a reader thread spinning while the file is replaced 60 times never sees a partial document
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    let stop = false; let ok = 0; let bad = 0; let missing = 0;
    parentPort.on('message', () => { stop = true; });
    (async () => { while (!stop) { try { JSON.parse(fs.readFileSync(workerData.file, 'utf8')); ok++; } catch (e) { if (e.code === 'ENOENT') missing++; else if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') missing++; else bad++; } await new Promise((r) => setTimeout(r, 2)); } parentPort.postMessage({ ok, bad, missing }); })();`;
  const w = new Worker(code, { eval: true, workerData: { file: f.file } });
  const result = new Promise((res) => w.once('message', res));
  let r;
  try {
    await sleep(50);
    for (let i = 0; i < 60; i++) writeSecretFileAtomic(f.file, `${JSON.stringify({ port: i, pid: process.pid, startedAt: new Date().toISOString(), tokens })}\n`);
    w.postMessage('stop');
    r = await result;
  } finally {
    // A failed write must not leave the reader thread running: it kept the test process alive for 24 min in a CI
    // run (2026-11-03) and blocked the whole suite.
    await w.terminate();
  }
  assert.equal(r.bad, 0, JSON.stringify(r));
  assert.ok(r.ok > 0);
  assert.deepEqual(readdirSync(dir), [API_FILE]);
  f.remove();
  assert.equal(existsSync(f.file), false);
});

test('api.json fails closed: if the file cannot be restricted, no file and no temp file are left', { skip: !win && 'Windows ACL path' }, () => {
  const dir = tmp();
  // icacls cannot be resolved from a bogus %SystemRoot%, so protectPath reports acl-failed (E8-09: no PATH fallback)
  withBogusSystemRoot(() => assert.throws(() => writeSecretFileAtomic(path.join(dir, API_FILE), 'secret-bearing text'), /ACL_FAILED/));
  assert.deepEqual(readdirSync(dir), []);
});

test('remove() deletes api.json only when it is still ours', () => {
  const dir = tmp();
  const f = publishApiFile({ dataDir: dir, port: 1, tokens: null });
  writeFileSync(f.file, JSON.stringify({ port: 2, pid: process.pid + 1, startedAt: 'x', tokens: null }));
  f.remove();
  assert.equal(existsSync(f.file), true);
});

test('data dir ACL: a directory the core creates is restricted to the current user, inheritable', { skip: !win && 'Windows ACL path' }, () => {
  const parent = tmp();
  const dir = path.join(parent, 'event-core-data');
  const r = ensureSecureDir(dir);
  assert.deepEqual(r, { created: true, protection: 'acl' });
  const rows = acl(dir);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.ok(rows[0].who.toLowerCase().endsWith(me().toLowerCase()));
  assert.equal(rows[0].perms, '(OI)(CI)(F)');
  // no Everyone / Users / Authenticated Users / SYSTEM / Administrators entries
  for (const x of rows) assert.doesNotMatch(x.who, /everyone|^builtin[\\]users|authenticated|nt authority|administrators/i);
  // a file created inside inherits the same single entry
  writeFileSync(path.join(dir, 'probe.txt'), 'x');
  const fileRows = acl(path.join(dir, 'probe.txt'));
  assert.equal(fileRows.length, 1);
  assert.ok(fileRows[0].who.toLowerCase().endsWith(me().toLowerCase()));
  // an existing directory is re-protected every time (E8-06)
  assert.deepEqual(ensureSecureDir(dir), { created: false, protection: 'acl' });
  assert.equal(protectPath(dir, { dir: true }), 'acl');
});

// Review E8-06 / E8-09: the DACL is set by SID, other ACEs are removed, existing children are reset, the result is
// read back, and the tools come from %SystemRoot%\System32 only.
test('E8-06: protectPath removes pre-seeded ACEs (BUILTIN\\Users, Everyone deny), re-protects existing children, grants by SID', { skip: !win && 'Windows ACL path' }, () => {
  const sid = currentUserSid();
  assert.match(sid, /^S-1-5-21-[0-9-]+$/);
  assert.equal(currentUserSid(), sid, 'read once and cached');
  const icacls = (...a) => assert.equal(spawnSync(systemTool('icacls.exe'), a, { windowsHide: true }).status, 0);
  const dir = path.join(tmp(), 'existing-data');
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  writeFileSync(path.join(dir, 'audit.db'), 'x');
  writeFileSync(path.join(dir, 'sub', 'stalls.jsonl'), 'y');
  icacls(dir, '/grant', '*S-1-5-32-545:(OI)(CI)RX');                                   // BUILTIN\Users, inheritable
  icacls(path.join(dir, 'audit.db'), '/inheritance:r', '/grant', '*S-1-5-32-545:R', '/grant', `*${sid}:F`); // explicit, protected
  icacls(path.join(dir, 'audit.db'), '/deny', '*S-1-1-0:(WD)');                          // an explicit deny for Everyone
  const before = dacls(dir);
  assert.match(before[dir], /;BU\)/);
  assert.match(before[path.join(dir, 'audit.db')], /^D:PAI.*\(D;;[^)]*;;;WD\).*;BU\)/);
  assert.deepEqual(ensureSecureDir(dir), { created: false, protection: 'acl' });
  const after = dacls(dir);
  assert.deepEqual(after, {
    [dir]: 'D:PAI(A;OICI;FA;;;<ME>)',
    [path.join(dir, 'audit.db')]: 'D:AI(A;ID;FA;;;<ME>)',
    [path.join(dir, 'sub')]: 'D:AI(A;OICIID;FA;;;<ME>)',
    [path.join(dir, 'sub', 'stalls.jsonl')]: 'D:AI(A;ID;FA;;;<ME>)',
  });
  // a single file: protected, the current user's SID only
  const f = path.join(tmp(), 'k.bin'); writeFileSync(f, 'k'); icacls(f, '/grant', '*S-1-5-32-545:R');
  assert.equal(protectPath(f), 'acl');
  assert.deepEqual(dacls(f), { [f]: 'D:PAI(A;;FA;;;<ME>)' });
});

test('E8-09: system tools resolve only from a validated %SystemRoot%; a bogus one fails closed (acl-failed, no PATH fallback)', { skip: !win && 'Windows path' }, () => {
  assert.equal(systemTool('icacls.exe').toLowerCase(), path.win32.join(process.env.SystemRoot, 'System32', 'icacls.exe').toLowerCase());
  const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  try {
    for (const bad of ['', 'Windows', '\\\\server\\share', 'C:/Windows', 'C:\\Windows\\x|y', 'C:\\Win*']) {
      process.env.SystemRoot = bad; delete process.env.windir;
      assert.throws(() => systemTool('icacls.exe'), undefined, JSON.stringify(bad));
    }
    process.env.SystemRoot = saved.SystemRoot; process.env.windir = 'D:\\Other';
    assert.throws(() => systemTool('icacls.exe'), /disagree/);
  } finally { process.env.SystemRoot = saved.SystemRoot; process.env.windir = saved.windir; }
  const dir = tmp();
  assert.equal(withBogusSystemRoot(() => protectPath(dir, { dir: true })), 'acl-failed');
  assert.equal(withBogusSystemRoot(() => ensureSecureDir(path.join(dir, 'x')).protection), 'acl-failed');
});

test('tokensFromEnv: both or neither, 64 hex, different', () => {
  assert.equal(tokensFromEnv({}), null);
  const a = 'ab'.repeat(32);
  const b = 'cd'.repeat(32);
  assert.deepEqual(tokensFromEnv({ [ENV_API_TOKEN]: a, [ENV_SYSTEM_TOKEN]: b }), { api: a, system: b });
  for (const env of [{ [ENV_API_TOKEN]: a }, { [ENV_SYSTEM_TOKEN]: b }, { [ENV_API_TOKEN]: a, [ENV_SYSTEM_TOKEN]: a }, { [ENV_API_TOKEN]: 'short', [ENV_SYSTEM_TOKEN]: b }, { [ENV_API_TOKEN]: a.toUpperCase(), [ENV_SYSTEM_TOKEN]: b }]) {
    assert.throws(() => tokensFromEnv(env));
  }
});

test('service: api.json written with real port and tokens, tokens work, file and listener gone after stop; data dir restricted', async () => {
  const dataDir = path.join(tmp(), 'core');
  const svc = await startService({ dataDir, noStreamerbot: true });
  try {
    assert.equal(svc.dataDirProtection, win ? 'acl' : 'mode-0700');
    const doc = JSON.parse(readFileSync(path.join(dataDir, API_FILE), 'utf8'));
    assert.equal(doc.port, svc.port);
    assert.deepEqual(doc.tokens, svc.tokens);
    assert.equal(doc.pid, process.pid);
    const st = await rpc({ port: doc.port }, doc.tokens.api, 'core.status');
    assert.equal(st.status, 200);
    assert.equal(st.result.audit.failed, null);
    // audit start row is there
    const ex = await rpc({ port: doc.port }, doc.tokens.api, 'audit.export', { limit: 50 });
    assert.ok(ex.result.rows.some((x) => x.type === 'system' && x.subtype === 'api-start'));
    if (win) for (const p of [dataDir, path.join(dataDir, API_FILE), path.join(dataDir, 'pseudo.key')]) {
      const rows = acl(p);
      assert.equal(rows.length, 1, p);
      assert.ok(rows[0].who.toLowerCase().endsWith(me().toLowerCase()));
    }
  } finally { await svc.stop(); }
  assert.equal(existsSync(path.join(dataDir, API_FILE)), false);
  await assert.rejects(() => raw({ port: svc.port, method: 'GET', path: '/events' }));
  assert.deepEqual(readdirSync(dataDir).filter((n) => n.endsWith('.tmp')), []);
});

test('service: system pipe for the supervisor, named only in system.json (owner-only), never in api.json; gone after stop', { skip: !win && 'named pipe is Windows' }, async () => {
  const dataDir = path.join(tmp(), 'core');
  const svc = await startService({ dataDir, noStreamerbot: true });
  let pipe;
  try {
    assert.ok(svc.systemPipe, 'system pipe started');
    const sys = readSystemFile(dataDir);
    pipe = sys.pipe;
    assert.equal(sys.pid, process.pid);
    assert.equal(pipe, svc.systemPipe.path);
    assert.match(pipe, /^\\\\\.\\pipe\\ujwalam-core-system-[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(dataDir, SYSTEM_FILE), 'utf8'))).sort(), ['pid', 'pipe', 'startedAt']);
    // the api role's discovery file never names the pipe
    const apiText = readFileSync(path.join(dataDir, API_FILE), 'utf8');
    assert.ok(!apiText.includes('pipe') && !apiText.includes(svc.systemPipe.name));
    const rows = acl(path.join(dataDir, SYSTEM_FILE));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].who.toLowerCase().endsWith(me().toLowerCase()));
    // the pipe itself: owner-only DACL, system token only
    assert.ok(isOwnerOnlySddl(await pipeSddl(svc.systemPipe.name, 'read'), currentUserSid()));
    assert.deepEqual(await panicViaPipe({ path: pipe, token: svc.tokens.system, reason: 'service test' }), { ok: true, reason: 'panic-engaged' });
    await assert.rejects(() => panicViaPipe({ path: pipe, token: svc.tokens.api }), (e) => e.code === 'UNAUTHORIZED');
    const ex = await rpc({ port: svc.port }, svc.tokens.api, 'audit.export', { limit: 50 });
    assert.ok(ex.result.rows.some((x) => x.type === 'system' && x.subtype === 'system-pipe-start' && x.verdict === 'ok'));
  } finally { await svc.stop(); }
  assert.equal(existsSync(path.join(dataDir, SYSTEM_FILE)), false);
  await assert.rejects(() => pipeRequest({ path: pipe, token: svc.tokens.system, method: 'core.status' }), (e) => e.code === 'ENOENT');
});

test('service with tokens from the environment: api.json carries no tokens, the env tokens authenticate', async () => {
  const a = '12'.repeat(32);
  const b = '34'.repeat(32);
  const dataDir = path.join(tmp(), 'core');
  const svc = await startService({ dataDir, noStreamerbot: true, env: { [ENV_API_TOKEN]: a, [ENV_SYSTEM_TOKEN]: b } });
  try {
    const doc = JSON.parse(readFileSync(path.join(dataDir, API_FILE), 'utf8'));
    assert.equal(doc.tokens, null);
    assert.equal((await rpc(svc, a, 'core.status')).status, 200);
    assert.equal((await rpc(svc, b, 'live.set', { state: 'offline' })).status, 200);
    assert.equal((await rpc(svc, 'f'.repeat(64), 'core.status')).status, 401);
  } finally { await svc.stop(); }
});

test('a second service on the same data dir is refused (single owner)', async () => {
  const dataDir = path.join(tmp(), 'core');
  const a = await startService({ dataDir, noStreamerbot: true });
  try {
    await assert.rejects(() => startService({ dataDir, noStreamerbot: true }), /owned by another writer|DB_LOCKED/i);
    assert.equal(existsSync(path.join(dataDir, API_FILE)), true);
  } finally { await a.stop(); }
});

test('service never enables sending: the connector is read-only', async () => {
  const src = readFileSync(path.join(repo, 'services', 'event-core', 'api', 'service.mjs'), 'utf8');
  assert.doesNotMatch(src, /sendEnabled\s*:\s*true|allowMockSend\s*:\s*true/);
});

test('serve --mock end to end: starts, flows invented chat, status over the API, stops, removes api.json, prints no token', { timeout: 60_000 }, async () => {
  const dataDir = path.join(tmp(), 'core');
  const child = spawn(process.execPath, [path.join(repo, 'services', 'event-core', 'cli.mjs'), 'serve', '--mock', '--data-dir', dataDir, '--duration', '9'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((res) => child.once('exit', res));
  try {
    const file = path.join(dataDir, API_FILE);
    let doc = null;
    for (let i = 0; i < 100 && !doc; i++) { await sleep(100); try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { /* not yet */ } }
    assert.ok(doc, 'api.json appeared');
    let st;
    for (let i = 0; i < 60; i++) {
      st = await rpc({ port: doc.port }, doc.tokens.api, 'core.status');
      if (st.result?.streamerbot?.received >= 2) break;
      await sleep(250);
    }
        assert.equal(st.result.streamerbot.state, 'connected');
    assert.ok(st.result.streamerbot.received >= 2);
    assert.ok(!st.text.includes('text'), 'status carries no chat text');
    assert.equal((await rpc({ port: doc.port }, doc.tokens.system, 'live.set', { state: 'offline' })).result.ok, true);
  } finally {
    if (child.exitCode === null) { await Promise.race([exited, sleep(15_000)]); child.kill(); }
  }
  assert.equal(existsSync(path.join(dataDir, API_FILE)), false, 'api.json removed on clean shutdown');
  assert.match(out, /\[serve\] api on 127\.0\.0\.1:\d+ \(mock Streamer\.bot\)/);
  assert.match(out, /sending to platforms is off/);
  assert.doesNotMatch(out, /[0-9a-f]{64}/);
});
