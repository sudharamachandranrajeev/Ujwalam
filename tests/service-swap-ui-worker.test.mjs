// SPDX-License-Identifier: GPL-3.0-or-later
// LU3 studio-ui and worker swaps (D337). The real studio-ui server behind the supervisor's front: 20 swaps while a
// client keeps calling the API with its login session (never logged out, never refused) and holds the event stream on
// one connection, which each new server starts with its whole state; a crashing new build is rolled back. Worker
// slot (stop-start) with stand-in workers: 20 swaps, a crashing build restores the old version, and neither the planned
// stops nor the probation exit count as a crash.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFront, splitFrames } from '../services/supervisor/front.mjs';
import { createUiSlot, createWorkerSlot } from '../services/supervisor/slots.mjs';
import { killChildTree } from '../services/common/kill-tree.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'lu3-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false, headers }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Event stream that reconnects like EventSource: records each connection's named events. */
function stream(port, cookie) {
  const st = { connections: 0, firstEvents: [], on: true };
  let req = null;
  const open = () => {
    if (!st.on) return;
    const names = [];
    req = http.get({ host: '127.0.0.1', port, path: '/ui/api/events', agent: false, headers: { cookie } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); setTimeout(open, 100); return; }
      st.connections++; st.firstEvents.push(names);
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (d) => {
        const r = splitFrames(buf + d); buf = r.rest;
        for (const f of r.frames) { const m = /^event: (\w+)$/m.exec(f.text); if (m) names.push(m[1]); }
      });
      res.on('error', () => {});
      res.on('close', () => setTimeout(open, 50)); // ended or cut: EventSource reconnects either way
    });
    req.on('error', () => setTimeout(open, 100));
  };
  open();
  return { st, close: () => { st.on = false; req?.destroy(); } };
}

test('studio-ui: 20 swaps keep the login session, the API answers throughout, one event stream connection carries the state of each new server; a crashing build is rolled back', async (t) => {
  const dataDir = tmp();
  const launchKey = randomBytes(32).toString('hex');
  const crash = tmp();
  mkdirSync(path.join(crash, 'services', 'studio-ui'), { recursive: true });
  writeFileSync(path.join(crash, 'services', 'studio-ui', 'cli.mjs'), "console.log('broken build'); process.exit(3);\n");
  const lines = [];
  const spawnUi = (root) => {
    const c = spawn(process.execPath, [path.join(root, 'services', 'studio-ui', 'cli.mjs'), 'serve', '--fake-host', '--data-dir', dataDir], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      env: { ...process.env, UJWALAM_UI_LAUNCH_KEY: launchKey, UJWALAM_PARENT_PIPE: '1', UJWALAM_EVENT_CORE_API_TOKEN: '', UJWALAM_EVENT_CORE_SYSTEM_TOKEN: '', UJWALAM_HOST_TOKEN: '', UJWALAM_HEADLESS: '1' },
    });
    c.stderr.on('data', (d) => lines.push(`ERR ${d}`));
    t.after(() => killChildTree(c));
    return c;
  };
  const front = createFront({ backendPort: null, name: 'studio-ui' });
  const fport = await front.listen();
  t.after(() => front.close());
  const unexpected = [];
  const slot = createUiSlot({ front, root: REPO, spawn: spawnUi, onLine: (l) => lines.push(l), onUnexpectedExit: (c, code) => unexpected.push(code) });
  await slot.start();
  const login = await get(fport, `/login?k=${launchKey}`);
  const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0];
  assert.ok(cookie, `login ${login.status}`);
  const s0 = await get(fport, '/ui/api/session', { cookie });
  assert.equal(s0.status, 200);
  const csrf = JSON.parse(s0.body).csrf;
  const ev = stream(fport, cookie);
  t.after(() => ev.close());
  const calls = { ok: 0, bad: [] };
  let on = true;
  const loop = (async () => {
    while (on) {
      try { const r = await get(fport, '/ui/api/session', { cookie }); if (r.status === 200 && JSON.parse(r.body).csrf === csrf) calls.ok++; else calls.bad.push(r.status); } catch (e) { calls.bad.push(e.message); }
      await sleep(20);
    }
  })();
  const results = [];
  for (let i = 0; i < 20; i++) { await sleep(100); results.push((await slot.swap(REPO)).result); }
  const rb = await slot.swap(crash);
  await sleep(800);
  on = false; await loop;
  ev.close();
  await slot.stop?.();
  assert.deepEqual(results, Array(20).fill('swapped'), lines.slice(-20).join('\n'));
  assert.equal(rb.result, 'kept-old');
  assert.match(rb.history.find((h) => !h.ok).error, /exited|listening on/);
  assert.deepEqual(calls.bad, [], 'every API call during the swaps answered 200 with the same session');
  assert.ok(calls.ok > 50, `${calls.ok} calls`);
  // The front carries the stream to each new server on the same connection; each new server starts it with the whole
  // state (flags, edits), so the page is current after every swap without reconnecting.
  assert.equal(ev.st.connections, 1, 'the page never reconnected');
  const names = ev.st.firstEvents[0];
  assert.equal(names.filter((n) => n === 'edits').length, 21, `edits frames: ${names.filter((n) => n === 'edits').length}`);
  assert.equal(names.filter((n) => n === 'flags').length, 21);
  assert.deepEqual(unexpected, []);
  t.diagnostic(`ui swaps 20, api calls ${calls.ok}, held ${front.stats().held}`);
});

test('worker (stop-start): 20 swaps; a crashing build restores the old version; planned stops are no crash', async (t) => {
  const d = tmp();
  const good = path.join(d, 'good.mjs');
  const bad = path.join(d, 'bad.mjs');
  writeFileSync(good, "process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);\n");
  writeFileSync(bad, "setTimeout(() => process.exit(4), 50);\n");
  const spawned = [];
  const unexpected = [];
  const slot = createWorkerSlot({
    name: 'live-clipper', healthMs: 300,
    spawn: (spec) => { const c = spawn(process.execPath, [spec.script], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }); spawned.push(spec.script); t.after(() => killChildTree(c)); return c; },
    onUnexpectedExit: (c, code) => unexpected.push(code),
  });
  slot.start({ script: good });
  const results = [];
  for (let i = 0; i < 20; i++) results.push((await slot.swap({ script: good })).result);
  const pidBefore = slot.child().pid;
  const r = await slot.swap({ script: bad });
  await sleep(500);
  assert.deepEqual(results, Array(20).fill('swapped'));
  assert.equal(r.result, 'restored-old');
  assert.match(r.history.find((h) => !h.ok).error, /exited \(4\)/);
  assert.equal(slot.spec().script, good);
  assert.notEqual(slot.child().pid, pidBefore);
  assert.equal(slot.child().exitCode, null, 'the old version runs again');
  assert.deepEqual(unexpected, []);
  // An exit after the swap is a real crash again and is reported.
  killChildTree(slot.child());
  for (let i = 0; i < 50 && !unexpected.length; i++) await sleep(50);
  assert.equal(unexpected.length, 1);
});
