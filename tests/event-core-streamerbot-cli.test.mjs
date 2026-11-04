// SPDX-License-Identifier: GPL-3.0-or-later
// P3 E2: the read-only listen CLI against the mock. No chat text or names in the output without --show-text,
// and never in any file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeAllMocks, openMocks, startMockStreamerbot } from '../tools/mock/mock-streamerbot.mjs';
import { openChildren, stopTracked, track, waitExit } from '../tools/proc-registry.mjs';

// Every child is registered, every wait for a child's exit is bounded (a stuck child is killed with its tree), and the
// teardown below kills and closes whatever a failed or timed-out test left behind, so the runner can always end.
const spawnTracked = (...a) => track(spawn(a[0], a[1], { ...a[2], windowsHide: true }));
const CHILD_WAIT_MS = 60000;

// Every mock started by this file must be closed when it ends.
test.after(async () => {
  const killed = await stopTracked(); const closed = await closeAllMocks();
  assert.equal(openMocks() + openChildren(), 0, 'a mock or child process was left open');
  assert.equal(killed + closed, 0, `teardown had to clean up ${killed} child(ren) and ${closed} mock(s): a test did not clean up after itself`);
});
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'services', 'event-core', 'cli.mjs');
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A credential target that never exists, so the test does not depend on (or touch) a real stored password.
const NO_CREDENTIAL = `Ujwalam-TEST-ONLY-absent-${process.pid}`;

const COND_WAIT_MS = 30000;
const lastStat = (out, k) => { const m = [...out.matchAll(new RegExp(`${k}=(\\d+)`, 'g'))].at(-1); return m ? Number(m[1]) : -1; };
async function until(pred, what, out) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > COND_WAIT_MS) throw new Error(`timed out waiting for ${what}; output tail:\n${out().slice(-600)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Waits on conditions, never on a fixed time, so a loaded machine only makes it slower: the Subscribe (the Hello is
// followed by a credential-store read, E8-04), then every emit received and every alert fixture written (from the
// 100 ms reports), then asks the child to stop over IPC so it prints its final report and exits 0. --duration 50 is
// only a cap for a hung child.
async function listenUntilDone(dataDir, extraArgs, emits, fixturesWanted) {
  const mock = await startMockStreamerbot();
  const child = spawnTracked(process.execPath, [CLI, 'listen', '--url', mock.url, '--interval', '100', '--duration', '50', '--data-dir', dataDir, '--credential', NO_CREDENTIAL, ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    await until(() => mock.subscriptions().some((x) => x.length), 'the Subscribe', () => out);
    for (const k of emits) mock.emit(k);
    await until(() => lastStat(out, 'received') >= emits.length, `${emits.length} events received`, () => out);
    await until(() => lastStat(out, 'fixtures') >= fixturesWanted, `${fixturesWanted} fixtures written`, () => out);
  } finally {
    if (child.connected) child.send('stop');
  }
  const { code } = await waitExit(child, CHILD_WAIT_MS);
  await mock.close();
  return { out, code, doActions: mock.doActions };
}

const ALERT_SAMPLES = new Set(['twitchFollow', 'twitchRaid']);
async function runListen(extraArgs, emits = ['twitchChat', 'youtubeChat', 'kickChat', 'twitchChatOld', 'twitchFollow', 'twitchRaid', 'chatEmpty']) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'evcli-')); dirs.push(dataDir);
  const fixtures = extraArgs.includes('--no-fixtures') ? 0 : emits.filter((k) => ALERT_SAMPLES.has(k)).length;
  const r = await listenUntilDone(dataDir, extraArgs, emits, fixtures);
  return { ...r, dataDir };
}

const NAMES_AND_TEXT = ['Alpha9', 'alpha9', 'gg that was clean', 'Charlie77', 'W stream', 'DeltaX', 'lets go', 'EchoRider', 'IndiaM', 'BravoK', 'bravok', 'behind you!'];

function allFileText(dir) {
  let all = '';
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else all += readFileSync(p, 'utf8'); } };
  walk(dir);
  return all;
}

test('listen: prints state and counts per platform and kind, no text or names, writes none', async () => {
  const { out, code, dataDir, doActions } = await runListen([]);
  assert.equal(code, 0);
  assert.match(out, /\[listen\] state=connected/);
  assert.match(out, /twitch chat\.message 2/);
  assert.match(out, /youtube chat\.message 1/);
  assert.match(out, /kick chat\.message 1/);
  assert.match(out, /twitch alert\.follow 1/);
  assert.match(out, /twitch alert\.raid 1/);
  assert.match(out, /skipped: empty-text=1/);
  assert.match(out, /text hidden/);
  for (const s of NAMES_AND_TEXT) assert.ok(!out.includes(s), `output leaked ${s}`);
  assert.equal(doActions.length, 0);                       // read-only: nothing sent
  // fixtures were recorded (anonymised); no file holds text or names
  const files = allFileText(dataDir);
  assert.ok(files.length > 0);
  for (const s of NAMES_AND_TEXT) assert.ok(!files.includes(s), `file leaked ${s}`);
});

test('listen --show-text: text appears on the terminal only, still never in files', async () => {
  const { out, dataDir } = await runListen(['--show-text']);
  assert.ok(out.includes('Alpha9: gg that was clean'));
  assert.ok(out.includes('[youtube] Charlie77: W stream'));
  assert.match(out, /SHOWN on terminal only/);
  const files = allFileText(dataDir);
  for (const s of NAMES_AND_TEXT) assert.ok(!files.includes(s), `file leaked ${s}`);
});

test('listen: no server -> keeps trying and reports state, exits cleanly at the end', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'evcli-')); dirs.push(dataDir);
  const mock = await startMockStreamerbot(); const url = mock.url; await mock.close();
  const out = await new Promise((resolve) => {
    let o = '';
    const child = spawnTracked(process.execPath, [CLI, 'listen', '--url', url, '--interval', '200', '--duration', '1', '--data-dir', dataDir, '--no-fixtures'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => { o += d; });
    waitExit(child, CHILD_WAIT_MS).then(() => resolve(o));
  });
  assert.match(out, /state=(waiting|connecting)/);
  assert.match(out, /fixtures off/);
});

// Review E8-11: untrusted names and text are printed with control, format and separator characters escaped.
// The inputs are built with escapes so this file holds no raw bidi or invisible characters.
test('E8-11 displaySafe: bidi, zero-width, soft hyphen, controls and separators become visible escapes; plain text unchanged', async () => {
  const { displaySafe } = await import('../services/event-core/cli.mjs');
  assert.equal(displaySafe('gg that was clean'), 'gg that was clean');
  assert.equal(displaySafe('ünïcödé 日本語 \u{1F600}'), 'ünïcödé 日本語 \u{1F600}');
  assert.equal(displaySafe('evil\u202Egnp.exe'), 'evil\\u{202E}gnp.exe');
  assert.equal(displaySafe('a\u2066b\u2069c\u200Bd\u00ADe\u2060f\uFEFFg'), 'a\\u{2066}b\\u{2069}c\\u{200B}d\\u{00AD}e\\u{2060}f\\u{FEFF}g');
  assert.equal(displaySafe('x\u001b[2Jy\u0085z\u2028w\u2029v\r\n'), 'x\\u{001B}[2Jy\\u{0085}z\\u{2028}w\\u{2029}v\\u{000D}\\u{000A}');
  assert.equal(displaySafe('\u3164\u115F'), '\\u{3164}\\u{115F}');
});

test('E8-11 listen --show-text: a bidi override in a name is shown escaped, never raw', async () => {
  const data = { messageId: 'tw-bidi', text: 'hello\u2066there', user: { id: '909', login: 'trojan', name: 'Tro\u202Ejan', role: 1 }, meta: {}, parts: [], emotes: [], isTest: true };
  const { out } = await runListen(['--show-text', '--no-fixtures'], [{ event: { source: 'Twitch', type: 'ChatMessage' }, data }]);
  assert.ok(out.includes('[twitch] Tro\\u{202E}jan: hello\\u{2066}there'), out);
  assert.ok(!/[\u202E\u2066]/.test(out), 'no raw bidi character on the terminal');
});

// Review E8-15: listen refuses ws:// to a non-loopback host unless --allow-remote, and protects its data dir.
test('E8-15 listen: non-loopback ws:// is refused (exit 1, nothing contacted); wss:// would be allowed', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'evcli-')); dirs.push(dataDir);
  const run = (url, extra = []) => new Promise((resolve) => {
    let o = '';
    const child = spawnTracked(process.execPath, [CLI, 'listen', '--url', url, '--duration', '0.3', '--data-dir', dataDir, '--no-fixtures', '--credential', NO_CREDENTIAL, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => { o += d; });
    waitExit(child, CHILD_WAIT_MS).then(({ code }) => resolve({ o, code }));
  });
  const a = await run('ws://192.0.2.10:8080/');
  assert.equal(a.code, 1);
  assert.match(a.o, /refused: .*non-loopback/);
  assert.doesNotMatch(a.o, /state=/);
  const b = await run('http://127.0.0.1:8080/');
  assert.equal(b.code, 1);
  // --allow-remote: accepted with a warning (192.0.2.0/24 is TEST-NET-1, never routed; nothing answers)
  const c = await run('ws://192.0.2.10:8080/', ['--allow-remote']);
  assert.equal(c.code, 0);
  assert.match(c.o, /warn: ws:\/\/ to a non-loopback host \(--allow-remote\)/);
});

test('E8-15 listen: an existing data dir is restricted before fixtures are written (same helper as serve)', { skip: process.platform !== 'win32' && 'Windows ACL path' }, async () => {
  const { currentUserSid, systemTool } = await import('../services/event-core/config.mjs');
  const { spawnSync } = await import('node:child_process');
  const { out, dataDir } = await runListenIn(async (dir) => {
    // pre-seed an inheritable BUILTIN\Users ACE on the existing data dir
    assert.equal(spawnSync(systemTool('icacls.exe'), [dir, '/grant', '*S-1-5-32-545:(OI)(CI)RX'], { windowsHide: true }).status, 0);
  });
  assert.match(out, /fixtures on/);
  const t = mkdtempSync(path.join(os.tmpdir(), 'acl-save-')); dirs.push(t);
  const f = path.join(t, 'acl.txt');
  assert.equal(spawnSync(systemTool('icacls.exe'), [dataDir, '/save', f, '/T', '/C', '/Q'], { windowsHide: true }).status, 0);
  const lines = readFileSync(f).toString('utf16le').split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 4, 'the data dir and the fixture files were read back');
  const sid = currentUserSid();
  for (let i = 1; i < lines.length; i += 2) {
    const aces = [...lines[i].matchAll(/\(([^;()]*);[^;()]*;[^;()]*;[^;()]*;[^;()]*;([^;()]*)\)/g)];
    assert.ok(aces.length > 0 && aces.every((m) => m[1] === 'A' && m[2] === sid), `${lines[i - 1]}: only the current user`);
  }
});

async function runListenIn(seed) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'evcli-')); dirs.push(dataDir);
  await seed(dataDir);
  const { out } = await listenUntilDone(dataDir, [], ['twitchFollow', 'twitchRaid'], 2);
  return { out, dataDir };
}
