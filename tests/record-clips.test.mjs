// SPDX-License-Identifier: GPL-3.0-or-later
// Clips from recordings and streams (D283, D284): stopped recordings, the user's choices (ask / after / while / off,
// for recordings and for streams), the clipper argv, live pause, the answer to "make clips?", requeue after a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clipRunSpec, countClips, createRecordClips, finishedRecording, isLive } from '../services/studio-ui/record-clips.mjs';
import { folderProblem, readSettings, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

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
  assert.equal(isLive(st('stopped', { stream: 'retrying' })), true);
  assert.equal(isLive(st('stopped')), false);
});

test('settings: defaults ask/ask, plain folders only, bad values refused, merge on write', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-set-'));
  try {
    assert.deepEqual(readSettings(d), { exists: false, clips: { recording: 'ask', live: 'ask' }, folders: { recordings: null, clips: null } });
    assert.deepEqual(settingsProblems({ clips: { recording: 'sometimes' } }), ['clips.recording must be one of ask, after, while, off']);
    assert.match(settingsProblems({ folders: { clips: 'relative\\x' } })[0], /full path/);
    assert.match(settingsProblems({ folders: { clips: path.join(d, 'app', 'clips') } }, { forbidden: [path.join(d, 'app')] })[0], /may not be inside/);
    assert.match(settingsProblems({ colour: 1 })[0], /unknown setting/);
    assert.equal(folderProblem(null), null, 'null = the default folder');
    writeSettings(d, { clips: { live: 'while' } });
    const clips = path.join(d, 'my clips');
    writeSettings(d, { folders: { clips } });
    assert.deepEqual(readSettings(d), { exists: true, clips: { recording: 'ask', live: 'while' }, folders: { recordings: null, clips } });
    assert.ok(existsSync(clips), 'the chosen folder is made');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('clipRunSpec: whole recording (after) and moments found while it ran (while)', () => {
  const root = 'C:/clip';
  const has = (set) => (p) => set.some((x) => path.resolve(p) === path.resolve(x));
  const script = path.join(root, 'services', 'clip', 'clipper.py');
  const gpu = path.join(root, '.venv-gpu', 'Scripts', 'python.exe');
  assert.match(clipRunSpec({ clipRoot: null, dataDir: 'D', job: { type: 'full', h: 'a', name: 'a' } }).reason, /not set up/);
  assert.match(clipRunSpec({ clipRoot: root, dataDir: 'D', job: { type: 'full', h: 'a', name: 'a' }, exists: has([script]) }).reason, /missing/);
  const r = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { type: 'full', h: 'C:/r/h.mkv', v: 'C:/r/v.mkv', name: 'h' }, exists: has([script, gpu]) });
  assert.equal(r.spec.exe, gpu);
  assert.deepEqual(r.spec.argv, ['-I', script, '--data-dir', 'D', 'run', '--detect', '--threads', '4', '--encoder', 'h264_nvenc',
    '--recording', 'C:/r/h.mkv', '--v-recording', 'C:/r/v.mkv', '--out', path.join('E:/clips', 'h')]);
  const job = { type: 'review', since: '2026-11-08T10:00:00.000Z', until: '2026-11-08T11:00:00.000Z', name: 'live-1' };
  assert.match(clipRunSpec({ clipRoot: root, dataDir: 'D', job, saves: null, exists: has([script, gpu]) }).reason, /no moments/);
  const rv = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job, saves: 'D/live-clips/s1', exists: has([script, gpu]) });
  assert.deepEqual(rv.spec.argv.slice(4), ['live-review', '--saves', 'D/live-clips/s1', '--since', job.since, '--until', job.until, '--encoder', 'h264_nvenc', '--out', path.join('E:/clips', 'live-1')]);
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
  let t = Date.parse('2026-11-08T10:00:00Z');
  return {
    d, root, h, v, dataDir, spawned, spawnFn, lines, log: (l) => lines.push(l),
    now: () => t, advance: (ms) => { t += ms; },
    status: () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'status.json'), 'utf8')),
    worker: () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'live-worker.json'), 'utf8')),
    S: (state, o = {}) => st(state, { h, v, ...o }),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const make = (s) => createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: s.log, spawnFn: s.spawnFn, now: s.now });

test('after: a stopped recording is clipped whole, hidden, then counted; off: nothing', async () => {
  const s = setup();
  try {
    writeSettings(s.dataDir, { clips: { recording: 'off', live: 'off' } });
    const rc = make(s);
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 0, 'off: nothing');
    writeSettings(s.dataDir, { clips: { recording: 'after' } });
    rc.feed(s.S('live')); s.advance(8 * 60000); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    assert.equal(s.spawned[0].o.windowsHide, true);
    assert.ok(s.spawned[0].argv.includes('--detect'));
    assert.equal(s.status().running.minutes, 8);
    const out = path.join(s.dataDir, 'clips', 'practice-h-1');
    mkdirSync(path.join(out, 'clips', 'c01'), { recursive: true });
    writeFileSync(path.join(out, 'clips', 'c01', 'stream-v.mp4'), '');
    assert.equal(countClips(out), 1);
    s.spawned[0].c.emit('exit', 0);
    assert.equal(s.status().state, 'idle');
    assert.deepEqual(s.status().last, { name: 'practice-h-1', kind: 'recording', result: 'done', code: 0, clips: 1, out });
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('ask: a question per recording; yes + remember sets "after"; no makes nothing', async () => {
  const s = setup();
  try {
    const rc = make(s); // no settings file: ask
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 0);
    const [ask] = s.status().asks;
    assert.equal(ask.kind, 'recording');
    writeFileSync(path.join(s.dataDir, 'clips', 'answer.json'), JSON.stringify({ id: ask.id, make: true, remember: true }));
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1, 'yes: clips are made');
    assert.equal(readSettings(s.dataDir).clips.recording, 'after', 'remember: from now on automatically');
    assert.equal(s.status().asks.length, 0);
    assert.ok(!existsSync(path.join(s.dataDir, 'clips', 'answer.json')), 'the answer is used once');
    // a stream: asked about separately (live setting), "no" makes nothing
    s.spawned[0].c.emit('exit', 0);
    rc.feed(s.S('live', { stream: 'live' })); rc.feed(s.S('stopped'));
    const [a2] = s.status().asks;
    assert.equal(a2.kind, 'live', 'a recording during a stream counts as live');
    writeFileSync(path.join(s.dataDir, 'clips', 'answer.json'), JSON.stringify({ id: a2.id, make: false }));
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    assert.equal(readSettings(s.dataDir).clips.live, 'ask', 'not remembered');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('while: the moment watcher is on only while recording or live; the moments are edited when it stops', async () => {
  const s = setup();
  try {
    writeSettings(s.dataDir, { clips: { recording: 'while', live: 'off' } });
    const saves = path.join(s.dataDir, 'live-clips', '20261108-100000');
    mkdirSync(saves, { recursive: true });
    writeFileSync(path.join(saves, 'saves.jsonl'), '');
    const rc = make(s);
    rc.feed(s.S('stopped'));
    assert.equal(s.worker().on, false);
    rc.feed(s.S('live'));
    assert.equal(s.worker().on, true, 'recording: watching');
    rc.feed(s.S('live', { stream: 'live' }));
    assert.equal(s.worker().on, false, 'live setting is off: not watching while live');
    s.advance(60000);
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 0, 'the recording ran during a stream: the live setting (off) applies');
    rc.feed(s.S('live')); s.advance(60000); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    const a = s.spawned[0].argv;
    assert.equal(a[a.indexOf('--saves') + 1], saves);
    assert.equal(a[a.indexOf('--until') + 1], new Date(s.now()).toISOString());
    // a stream with no recording and live = while: its moments become clips when it ends
    s.spawned[0].c.emit('exit', 0);
    writeSettings(s.dataDir, { clips: { live: 'while' } });
    const noRec = { rungs: RUNGS, sinks: [{ id: 'yt', kind: 'stream', rung: 'rec-h', state: 'live' }] };
    rc.feed(noRec);
    assert.equal(s.worker().on, true);
    rc.feed({ ...noRec, sinks: [{ ...noRec.sinks[0], state: 'stopped' }] });
    assert.equal(s.spawned.length, 2);
    assert.match(s.spawned[1].argv.at(-1), /live-\d{8}-\d{6}$/);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('a stream that starts pauses the run; it runs again after; closing Ujwalam keeps it for the next start', async () => {
  const s = setup();
  try {
    writeSettings(s.dataDir, { clips: { recording: 'after', live: 'off' } });
    const rc = make(s);
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    rc.feed(s.S('stopped', { stream: 'live' }));
    assert.equal(s.spawned[0].c.killed, true, 'live: stopped (VRAM)');
    await tick(); await tick();
    rc.feed(s.S('stopped', { stream: 'live' }));
    assert.equal(s.spawned.length, 1, 'nothing while live');
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2, 'runs again after the stream');
    rc.stop();
    await tick(); await tick();
    assert.equal(s.status().running.h, s.h, 'the killed run stays in the status');
    assert.equal(s.worker().on, false);
    const rc2 = make(s);
    assert.ok(s.lines.some((l) => /1 unfinished clip job\(s\)/.test(l)));
    rc2.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 3);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('no clip maker: reported in plain words, nothing spawned', () => {
  const s = setup();
  try {
    writeSettings(s.dataDir, { clips: { recording: 'after' } });
    const rc = createRecordClips({ clipRoot: null, dataDir: s.dataDir, log: s.log, spawnFn: s.spawnFn, now: s.now });
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 0);
    assert.equal(s.status().available, false);
    assert.equal(s.status().last.result, 'not-made');
    assert.match(s.status().last.reason, /not set up on this PC/);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});
