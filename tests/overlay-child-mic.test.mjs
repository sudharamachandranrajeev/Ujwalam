// SPDX-License-Identifier: GPL-2.0-or-later
// Overlay child (app/host/overlay/child.mjs) op "mic": the host's fire-and-forget mic level for the cam-pop voice
// trigger. The child is spawned directly, as the host does (stdin/stdout JSON lines), with an empty temp overlay root
// and port 0: no host, no devices, no browser. The rule's counters come back in the stats reply (campop).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(REPO, 'app', 'host', 'overlay', 'child.mjs');
const GUARDS = JSON.parse(readFileSync(path.join(REPO, 'data', 'effects', 'guards.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child, root, ready;
const lines = [];
let stderr = '';
let nextId = 0;

before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ujw-child-mic-'));
  mkdirSync(path.join(root, 'overlays'));
  const env = { ...process.env, UJWALAM_HEADLESS: '1' };
  delete env.UJWALAM_EVENT_CORE_API_TOKEN;
  child = spawn(process.execPath, [CHILD, '--root', root, '--port', '0', '--feed-port', '0'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  for (let t = 0; !lines.length; t += 20) {
    if (t > 15000) assert.fail(`child not ready: ${stderr}`);
    await sleep(20);
  }
  ready = lines.shift();
});

after(async () => {
  if (child && child.exitCode === null) {
    const done = new Promise((r) => child.once('exit', r));
    child.stdin.end();
    await done;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const sendRaw = (s) => child.stdin.write(s + '\n');

// Sends a stats call and returns its reply; asserts it is the only stdout line since `mark`, so no mic op answered.
async function statsOnly(mark) {
  const id = ++nextId;
  send({ id, op: 'stats' });
  for (let t = 0; lines.length === mark; t += 10) {
    if (t > 5000) assert.fail('no stats reply');
    await sleep(10);
  }
  await sleep(50);
  assert.equal(lines.length, mark + 1, `only the stats reply on stdout, got ${JSON.stringify(lines.slice(mark))}`);
  const r = lines[mark];
  assert.equal(r.type, 'reply');
  assert.equal(r.id, id);
  assert.equal(r.ok, true);
  return r.result;
}

test('ready names the mic source from guards.json (rules.campop.voice.audioSource)', () => {
  assert.equal(ready.type, 'ready');
  assert.equal(ready.micSource, GUARDS.rules.campop.voice.audioSource.id);
});

test('bad mic levels are ignored: no reply, no rule call, at most one stderr warning', async () => {
  const mark = lines.length;
  const before = (await statsOnly(mark)).campop;
  assert.ok(before, 'the cam-pop rule is built from guards.json');
  // Each of these, if it reached the rule as "loud", would start the hold timer; two of them 200 ms apart would fire.
  const bad = [{ op: 'mic', level: '0.9' }, { op: 'mic', level: 1.5 }, { op: 'mic', level: -0.1 }, { op: 'mic', level: null },
    { op: 'mic' }, { op: 'mic', level: [0.5] }, { op: 'mic', level: true }, { id: 7, op: 'mic', level: 2 }];
  for (const m of bad) send(m);
  sendRaw('{"op":"mic","level":1e999}'); // JSON Infinity
  await sleep(200);
  for (const m of bad) send(m);
  sendRaw('{"op":"mic","level":1e999}');
  await sleep(50);
  const after = (await statsOnly(mark + 1)).campop;
  assert.deepEqual(after, before, 'no level reached the rule');
  const warns = stderr.split('\n').filter((l) => l.includes('mic: ignored'));
  assert.equal(warns.length, 1, `rate-limited warning: ${JSON.stringify(warns)}`);
});

test('a valid level reaches the rule: held at or above spikeLevel for holdMs it triggers once', async () => {
  const { spikeLevel, holdMs } = GUARDS.rules.campop.voice;
  const mark = lines.length;
  const before = (await statsOnly(mark)).campop;
  send({ op: 'mic', level: 0 });               // quiet
  send({ op: 'mic', level: spikeLevel });      // loud: hold starts
  await sleep(holdMs + 60);
  send({ op: 'mic', level: 1 });               // still loud after holdMs: voice-spike trigger
  await sleep(50);
  const after = (await statsOnly(mark + 1)).campop;
  assert.equal(after.triggers - before.triggers, 1, 'one voice-spike trigger');
  // The flag `chat-effects` decides whether the pop is admitted; either way the trigger was counted.
  assert.equal((after.admitted + after.refused + after.gap) - (before.admitted + before.refused + before.gap), 1);
});

test('the child keeps answering after mic lines (stdin channel intact)', async () => {
  const mark = lines.length;
  for (let i = 0; i < 50; i++) send({ op: 'mic', level: 0.001 * i });
  const s = await statsOnly(mark);
  assert.equal(typeof s.effects, 'number');
});
