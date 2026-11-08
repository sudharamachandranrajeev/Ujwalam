// SPDX-License-Identifier: GPL-3.0-or-later
// Clips from finished recordings (D283): detection of a stopped recording, the clipper argv, the queue, live pause,
// requeue after a restart, the status file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clipRunSpec, countClips, createRecordClips, finishedRecording, isLive } from '../services/studio-ui/record-clips.mjs';

const RUNGS = [{ id: 'rec-h', canvas: 'H' }, { id: 'rec-v', canvas: 'V' }];
const st = (state, { stream = 'stopped', h = 'C:/r/practice-h-1.mkv', v = 'C:/r/practice-v-1.mkv' } = {}) => ({
  rungs: RUNGS,
  sinks: [
    { id: 'practice-h', kind: 'record', rung: 'rec-h', state, path: h },
    { id: 'practice-v', kind: 'record', rung: 'rec-v', state, path: v },
    { id: 'yt', kind: 'stream', rung: 'rec-h', state: stream },
  ],
});

test('finishedRecording: active then stopped gives the H and V files; anything else gives null', () => {
  assert.deepEqual(finishedRecording(st('live'), st('stopped')), { h: 'C:/r/practice-h-1.mkv', v: 'C:/r/practice-v-1.mkv' });
  assert.equal(finishedRecording(null, st('stopped')), null);
  assert.equal(finishedRecording(st('stopped'), st('stopped')), null);
  assert.equal(finishedRecording(st('live'), st('live')), null);
  assert.equal(finishedRecording(st('live', { h: null }), st('stopped', { h: null })), null, 'no H file: nothing to clip');
  assert.deepEqual(finishedRecording(st('live'), st('stopped', { v: null })), { h: 'C:/r/practice-h-1.mkv', v: 'C:/r/practice-v-1.mkv' }, 'the path from before the stop is kept');
});

test('isLive: a stream sink in an active state', () => {
  assert.equal(isLive(st('stopped')), false);
  assert.equal(isLive(st('stopped', { stream: 'live' })), true);
  assert.equal(isLive(st('stopped', { stream: 'retrying' })), true);
});

test('clipRunSpec: venv preference, isolated python, out folder per recording, chat db only when present', () => {
  const root = 'C:/clip';
  const has = (set) => (p) => set.some((x) => path.resolve(p) === path.resolve(x));
  const base = [path.join(root, 'services', 'clip', 'clipper.py')];
  assert.match(clipRunSpec({ clipRoot: null, dataDir: 'D', h: 'a.mkv' }).reason, /no clip folder/);
  assert.match(clipRunSpec({ clipRoot: root, dataDir: 'D', h: 'a.mkv', exists: has(base) }).reason, /no Python venv/);
  const gpu = path.join(root, '.venv-gpu', 'Scripts', 'python.exe');
  const cpu = path.join(root, '.venv', 'Scripts', 'python.exe');
  const r = clipRunSpec({ clipRoot: root, dataDir: 'D', h: 'C:/r/practice-h-1.mkv', v: 'C:/r/practice-v-1.mkv', exists: has([...base, gpu, cpu]) });
  assert.equal(r.spec.exe, gpu);
  assert.equal(r.spec.out, path.join('D', 'clips', 'practice-h-1'));
  assert.deepEqual(r.spec.argv, ['-I', base[0], '--data-dir', 'D', 'run', '--detect', '--threads', '4', '--encoder', 'h264_nvenc',
    '--recording', 'C:/r/practice-h-1.mkv', '--v-recording', 'C:/r/practice-v-1.mkv', '--out', r.spec.out]);
  const db = path.join('D', 'event-core.db');
  const r2 = clipRunSpec({ clipRoot: root, dataDir: 'D', h: 'C:/r/x.mkv', exists: has([...base, cpu, db]) });
  assert.equal(r2.spec.exe, cpu);
  assert.ok(!r2.spec.argv.includes('--v-recording'));
  assert.deepEqual(r2.spec.argv.slice(-4), ['--chat-db', db, '--out', path.join('D', 'clips', 'x')]);
});

function setup() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-rc-'));
  const root = path.join(d, 'repo');
  mkdirSync(path.join(root, 'services', 'clip'), { recursive: true });
  mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(path.join(root, 'services', 'clip', 'clipper.py'), '');
  writeFileSync(path.join(root, '.venv', 'Scripts', 'python.exe'), '');
  const rec = path.join(d, 'rec');
  mkdirSync(rec);
  const h = path.join(rec, 'practice-h-1.mkv'); const v = path.join(rec, 'practice-v-1.mkv');
  writeFileSync(h, ''); writeFileSync(v, '');
  const dataDir = path.join(d, 'core');
  mkdirSync(dataDir);
  const spawned = [];
  const spawnFn = (exe, argv, o) => { const c = new EventEmitter(); c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', 1)); }; spawned.push({ exe, argv, o, c }); return c; };
  const lines = [];
  return { d, root, h, v, dataDir, spawned, spawnFn, lines, log: (l) => lines.push(l), status: () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'status.json'), 'utf8')) };
}
const tick = () => new Promise((r) => setImmediate(r));

test('createRecordClips: queued on stop, one hidden run, done with the clip count; flag off ignores', async () => {
  const s = setup();
  try {
    let on = false;
    const rc = createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, flagOn: () => on, log: s.log, spawnFn: s.spawnFn });
    const S = (state, o = {}) => st(state, { h: s.h, v: s.v, ...o });
    rc.feed(S('live')); rc.feed(S('stopped'));
    assert.equal(s.spawned.length, 0, 'flag off: nothing queued');
    on = true;
    rc.feed(S('live')); rc.feed(S('stopped'));
    assert.equal(s.spawned.length, 1);
    assert.equal(s.spawned[0].o.windowsHide, true);
    assert.equal(s.status().state, 'running');
    assert.deepEqual(s.status().running, { h: s.h, v: s.v });
    const out = path.join(s.dataDir, 'clips', 'practice-h-1');
    mkdirSync(path.join(out, 'clips', 'c01'), { recursive: true });
    writeFileSync(path.join(out, 'clips', 'c01', 'stream-v.mp4'), '');
    assert.equal(countClips(out), 1);
    s.spawned[0].c.emit('exit', 0);
    assert.equal(s.status().state, 'idle');
    assert.deepEqual(s.status().last, { recording: 'practice-h-1.mkv', result: 'done', code: 0, clips: 1, out });
    assert.ok(s.lines.some((l) => /1 clip file\(s\) made/.test(l)));
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('createRecordClips: a stream that starts stops the run; it runs again after the stream; a restart requeues', async () => {
  const s = setup();
  try {
    const mk = () => createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, flagOn: () => true, log: s.log, spawnFn: s.spawnFn });
    const rc = mk();
    const S = (state, o = {}) => st(state, { h: s.h, v: s.v, ...o });
    rc.feed(S('live')); rc.feed(S('stopped'));
    assert.equal(s.spawned.length, 1);
    rc.feed(S('stopped', { stream: 'live' }));
    assert.equal(s.spawned[0].c.killed, true, 'live: the run is stopped (VRAM)');
    await tick(); await tick();
    assert.equal(s.status().state, 'queued');
    rc.feed(S('stopped', { stream: 'live' }));
    assert.equal(s.spawned.length, 1, 'no run while live');
    rc.feed(S('stopped'));
    assert.equal(s.spawned.length, 2, 'runs again after the stream');
    // Ujwalam closed during the run: the next start queues it again and runs it on the first status
    rc.stop();
    await tick(); await tick(); // the killed run's exit must not drop it from the status
    assert.deepEqual(s.status().running, { h: s.h, v: s.v });
    const rc2 = mk();
    assert.ok(s.lines.some((l) => /1 recording\(s\) from the last session queued again/.test(l)));
    rc2.feed(S('stopped'));
    assert.equal(s.spawned.length, 3);
    assert.equal(s.spawned[2].argv.at(-1), path.join(s.dataDir, 'clips', 'practice-h-1'));
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('createRecordClips: no clip folder: reported as not run, nothing spawned', () => {
  const s = setup();
  try {
    const rc = createRecordClips({ clipRoot: null, dataDir: s.dataDir, flagOn: () => true, log: s.log, spawnFn: s.spawnFn });
    rc.feed(st('live', { h: s.h })); rc.feed(st('stopped', { h: s.h }));
    assert.equal(s.spawned.length, 0);
    assert.equal(s.status().last.result, 'not-run');
    assert.match(s.status().last.reason, /no clip folder/);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});
