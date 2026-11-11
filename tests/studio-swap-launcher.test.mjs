// SPDX-License-Identifier: GPL-3.0-or-later
// LU4 studio window swap (D346), launcher level: the studio is a swappable service (stop-start) behind the
// service-swap flag; a swap closes the old window with "swap-close" (planned, no quit lock, nothing stopped), starts
// the new exe, which logs in again; a build that crashes at start is rolled back to the old one; a normal close of the
// window (exit 0) still stops everything (D280). Headless: the studio runs with UJWALAM_STUDIO_HIDDEN=1 (its window is
// laid out but never on screen) against the fake host. Previews and frames under a stream: studio-swap-stream.test.mjs.
// The launcher tests are skipped when the studio is not built (npm run build:studio) or no Qt kit is configured.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serveSwaps, SERVICE_SWAP_FLAG, studioRootPaths, swapEntryOk } from '../services/studio-ui/launch.mjs';
import { refuseReason, SERVICES } from '../services/supervisor/swap.mjs';
import { killChildTree } from '../services/common/kill-tree.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = !existsSync(EXE) || !qtDir() ? 'studio shell not built (npm run build:studio)' : false;

test('the studio is a stop-start service; the host and the overlay server stay refused', () => {
  assert.equal(SERVICES.studio.mode, 'stop-start');
  assert.equal(refuseReason('studio'), null);
  assert.match(refuseReason('studio', { busy: true }), /one at a time/);
  assert.match(refuseReason('host'), /LU5/);
});

test('studioRootPaths / swapEntryOk: a staged studio/ujwalam-studio.exe, else this checkout\'s build; nothing else', () => {
  const files = new Set([path.join('C:\\stage', 'studio', 'ujwalam-studio.exe'), 'C:\\dev\\ujwalam-studio.exe']);
  const exists = (f) => files.has(f);
  assert.deepEqual(studioRootPaths('C:\\stage', { repo: 'C:\\repo', devExe: 'C:\\dev\\ujwalam-studio.exe', devQtDir: 'C:\\qt', exists }),
    { exe: path.join('C:\\stage', 'studio', 'ujwalam-studio.exe'), qtBin: path.join('C:\\qt', 'bin'), qtPlugins: null });
  assert.equal(studioRootPaths('C:\\repo', { repo: 'C:\\repo', devExe: 'C:\\dev\\ujwalam-studio.exe', exists }).exe, 'C:\\dev\\ujwalam-studio.exe');
  assert.equal(studioRootPaths('C:\\other', { repo: 'C:\\repo', devExe: 'C:\\dev\\ujwalam-studio.exe', exists }), null, 'a folder without a studio exe');
  assert.equal(swapEntryOk('studio', 'C:\\stage', { exists }), true);
  assert.equal(swapEntryOk('studio', 'C:\\other', { exists }), false);
  assert.equal(swapEntryOk('event-core', 'C:\\stage', { exists }), false);
});

test('serveSwaps: one swap at a time over all services; a studio result carries its timings', async () => {
  const p = new EventEmitter();
  p.sent = []; p.connected = true; p.send = (m) => p.sent.push(m);
  let release;
  const slow = { swap: () => new Promise((r) => { release = () => r({ result: 'swapped', ms: 5, history: [{ action: 'check-new', ok: true, value: { readyMs: 7, previewGapMs: { h: 900 } } }] }); }) };
  const quick = { swap: async () => ({ result: 'swapped', ms: 1, history: [] }) };
  serveSwaps({ slots: { studio: slow, 'event-core': quick }, log: () => {}, proc: p, entryOk: () => true });
  p.emit('message', { t: 'ujwalam-swap', id: 1, service: 'studio', root: REPO });
  await sleep(10);
  p.emit('message', { t: 'ujwalam-swap', id: 2, service: 'event-core', root: REPO });
  await sleep(10);
  assert.deepEqual(p.sent.map((m) => [m.id, m.result]), [[2, 'refused']]);
  assert.match(p.sent[0].reason, /one at a time/);
  release();
  await sleep(10);
  const done = p.sent.find((m) => m.id === 1);
  assert.equal(done.result, 'swapped');
  assert.deepEqual(done.studio, { readyMs: 7, previewGapMs: { h: 900 } });
  p.emit('message', { t: 'ujwalam-swap', id: 3, service: 'event-core', root: REPO });
  await sleep(10);
  assert.equal(p.sent.find((m) => m.id === 3).result, 'swapped', 'free again after the swap');
});

// A staged studio build (a copy of the built exe) under <dir>/studio; crash: a build that crashes at start (headless
// test marker beside the exe, app/studio/src/main.cpp).
function stageStudio(dir, { crash = false } = {}) {
  mkdirSync(path.join(dir, 'studio'), { recursive: true });
  copyFileSync(EXE, path.join(dir, 'studio', 'ujwalam-studio.exe'));
  if (crash) writeFileSync(path.join(dir, 'studio', 'ujwalam-studio.test-crash'), 'av');
  return dir;
}

function startLauncher(root, env = {}) {
  const dataDir = path.join(root, 'core');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { [SERVICE_SWAP_FLAG]: true } }));
  const child = spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--mock', '--fake-host', '--stop-on-stdin', '--data-dir', dataDir,
    '--feedback-dir', path.join(root, 'feedback'), '--profile', path.join(REPO, 'tests', 'fixtures', 'project', 'profile.fixture.json')], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_HIDDEN: '1', UJWALAM_HOST_EXE: path.join(root, 'no-host.exe'), UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), ...env },
  });
  const st = { child, out: '', dataDir };
  child.stdout.on('data', (d) => { st.out += d; });
  child.stderr.on('data', (d) => { st.out += d; });
  let id = 0;
  st.swap = (service, to) => new Promise((resolve) => {
    const my = ++id;
    const on = (m) => { if (m?.t === 'ujwalam-swap' && m.id === my) { child.off('message', on); resolve(m); } };
    child.on('message', on);
    child.send({ t: 'ujwalam-swap', id: my, service, root: to });
  });
  st.until = async (re, ms) => { for (let i = 0; i < ms / 50 && !re.test(st.out); i++) await sleep(50); return re.test(st.out); };
  st.exits = () => { try { return readFileSync(path.join(dataDir, 'logs', 'studio-exits.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return st;
}

const portOpen = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (r) => { r.resume(); resolve(true); });
  req.on('error', () => resolve(false));
  req.setTimeout(2000, () => { req.destroy(); resolve(false); });
});

test('launcher: the studio window swaps over IPC (closed for the update, not stopped); a build that crashes at start is rolled back', { skip, timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lu4-launch-'));
  const st = startLauncher(root);
  t.after(() => { killChildTree(st.child); rmSync(root, { recursive: true, force: true }); });
  assert.ok(await st.until(/window: studio attach: ready/, 60_000), st.out.slice(-3000));
  const uiPort = Number(/UI at http:\/\/127\.0\.0\.1:(\d+)\//.exec(st.out)?.[1]);
  const stageA = stageStudio(path.join(root, 'stage-a'));
  const stageB = stageStudio(path.join(root, 'stage-b'));
  const crash = stageStudio(path.join(root, 'crash'), { crash: true });
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await st.swap('studio', i % 2 ? stageA : stageB));
  const bad = await st.swap('studio', crash);
  const after = await st.swap('studio', REPO); // the restored window swaps again
  const noExe = await st.swap('studio', path.join(root, 'feedback'));
  assert.deepEqual(results.map((r) => r.result), Array(4).fill('swapped'), JSON.stringify(results) + st.out.slice(-3000));
  for (const r of results) assert.ok(Number.isFinite(r.studio?.readyMs), JSON.stringify(r));
  assert.equal(bad.result, 'restored-old', JSON.stringify(bad));
  assert.match(bad.failed.join(' '), /check-new: the studio exited \(3221225477\)/, 'an access violation (0xC0000005) at start');
  assert.equal(after.result, 'swapped', JSON.stringify(after));
  assert.equal(noExe.result, 'refused');
  assert.ok(await portOpen(uiPort), 'the UI server kept running');
  assert.doesNotMatch(st.out, /studio window closed: stopping Ujwalam|Qt shell ended unexpectedly/);
  const exits = st.exits();
  const swapExits = exits.filter((e) => e.swap === true);
  // 6 windows closed for an update (4 swaps, the crashed build's predecessor, the restored one), plus the crashed build.
  assert.equal(swapExits.length, 7, JSON.stringify(exits));
  assert.equal(swapExits.filter((e) => e.code === 75).length, 6, 'every old window closed itself cleanly with exit 75');
  assert.equal(exits.length, swapExits.length, 'no exit outside a swap');
  assert.ok(existsSync(path.join(st.dataDir, 'logs')) && exits.some((e) => e.code !== 75 && e.crash === true), 'the crashed build is recorded as a crash');
  st.child.stdin.end();
  assert.equal(await new Promise((r) => st.child.once('exit', r)), 0);
});

test('launcher: a normal close of the studio window still stops everything (D280), with the swap flag on', { skip, timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lu4-close-'));
  const st = startLauncher(root, { UJWALAM_STUDIO_TEST_CLOSE_MS: '1500' });
  t.after(() => { killChildTree(st.child); rmSync(root, { recursive: true, force: true }); });
  const code = await Promise.race([new Promise((r) => st.child.once('exit', r)), new Promise((r) => setTimeout(r, 90_000, 'timeout').unref())]);
  assert.equal(code, 0, st.out.slice(-3000));
  assert.match(st.out, /window: studio attach: ready/);
  assert.match(st.out, /studio window closed: stopping Ujwalam/);
  const uiPort = Number(/UI at http:\/\/127\.0\.0\.1:(\d+)\//.exec(st.out)?.[1]);
  const corePort = Number(/event core is reached through port (\d+)/.exec(st.out)?.[1]);
  assert.equal(await portOpen(uiPort), false, 'the UI server stopped');
  assert.equal(await portOpen(corePort), false, 'the event core stopped');
  const exits = st.exits();
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 0);
  assert.equal(exits[0].swap, undefined, 'a user close is not a swap');
});
