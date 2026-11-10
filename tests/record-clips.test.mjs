// SPDX-License-Identifier: GPL-3.0-or-later
// Clips from recordings and streams (D283, D284): stopped recordings, the user's choices (ask / after / while / off,
// for recordings and for streams), the clipper argv, live pause, the answer to "make clips?", requeue after a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIP_MAKER_FIX, clipRunSpec, clipTools, countClips, countSaves, createRecordClips, finishedRecording, isLive, jobStages, liveClipperTask, parseProgress, reelsNotMade, stageWords } from '../services/studio-ui/record-clips.mjs';
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

// --- ui settings (D290) ---
test('settings ui.motion (D290): system | on | off, written and read back; absent until chosen; bad values refused', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-set-ui-'));
  try {
    assert.equal(readSettings(d).ui, undefined, 'nothing chosen: no ui block');
    assert.deepEqual(settingsProblems({ ui: { motion: 'off' } }), []);
    assert.deepEqual(settingsProblems({ ui: { motion: 'system' } }), []);
    assert.deepEqual(settingsProblems({ ui: { motion: 'fast' } }), ['ui.motion must be one of system, on, off']);
    assert.match(settingsProblems({ ui: { shine: 1 } })[0], /unknown ui setting shine/);
    assert.match(settingsProblems({ ui: 'off' })[0], /ui must be an object/);
    writeSettings(d, { ui: { motion: 'off' } });
    assert.deepEqual(readSettings(d).ui, { motion: 'off' });
    writeSettings(d, { clips: { live: 'while' } });
    assert.deepEqual(readSettings(d).ui, { motion: 'off' }, 'a clips change keeps the ui choice');
    writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { motion: 'wild' } }));
    assert.equal(readSettings(d).ui, undefined, 'an invalid value in the file is ignored');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// --- end ui settings ---

test('settings: defaults ask/ask, plain folders only, bad values refused, merge on write', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-set-'));
  try {
    const gate = { top3: true, minKills: null }; // D286 proposed defaults (tests/user-settings-match-gate.test.mjs)
    assert.deepEqual(readSettings(d), { exists: false, clips: { recording: 'ask', live: 'ask', matchGate: gate }, folders: { recordings: null, clips: null } });
    assert.deepEqual(settingsProblems({ clips: { recording: 'sometimes' } }), ['clips.recording must be one of ask, after, while, off']);
    assert.match(settingsProblems({ folders: { clips: 'relative\\x' } })[0], /full path/);
    assert.match(settingsProblems({ folders: { clips: path.join(d, 'app', 'clips') } }, { forbidden: [path.join(d, 'app')] })[0], /may not be inside/);
    assert.match(settingsProblems({ colour: 1 })[0], /unknown setting/);
    assert.equal(folderProblem(null), null, 'null = the default folder');
    writeSettings(d, { clips: { live: 'while' } });
    const clips = path.join(d, 'my clips');
    writeSettings(d, { folders: { clips } });
    assert.deepEqual(readSettings(d), { exists: true, clips: { recording: 'ask', live: 'while', matchGate: gate }, folders: { recordings: null, clips } });
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
  // the zip ships no Python (D283): plain reason, a fix, and which part is missing
  const noPy = clipTools({ clipRoot: root, exists: has([script]) });
  assert.deepEqual([noPy.py, noPy.missing, noPy.fix], [null, 'python', CLIP_MAKER_FIX]);
  assert.match(noPy.reason, /Python is missing \(the Ujwalam download does not include Python/);
  assert.deepEqual([clipTools({ clipRoot: root, exists: has([gpu]) }).missing, clipTools({ clipRoot: null }).missing, clipTools({ clipRoot: root, exists: has([script, gpu]) }).missing], ['script', 'root', null]);
  const r = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { type: 'full', h: 'C:/r/h.mkv', v: 'C:/r/v.mkv', name: 'h' }, exists: has([script, gpu]) });
  assert.equal(r.spec.exe, gpu);
  assert.deepEqual(r.spec.argv, ['-I', script, '--data-dir', 'D', 'run', '--detect', '--threads', '4', '--encoder', 'h264_nvenc',
    '--recording', 'C:/r/h.mkv', '--v-recording', 'C:/r/v.mkv', '--montage', '--publish', 'E:/clips', '--out', path.join('D', 'clips', 'runs', 'h')]);
  assert.equal(r.spec.out, path.join('D', 'clips', 'runs', 'h'), 'the run works in app data');
  assert.equal(r.spec.folder, 'E:/clips', 'only finished videos go to the clips folder');
  const noV = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { type: 'full', h: 'C:/r/h.mkv', name: 'h' }, exists: has([script, gpu]) });
  assert.ok(!noV.spec.argv.includes('--montage'), 'no V recording: no montage');
  const job = { type: 'review', since: '2026-11-08T10:00:00.000Z', until: '2026-11-08T11:00:00.000Z', name: 'live-1' };
  assert.match(clipRunSpec({ clipRoot: root, dataDir: 'D', job, saves: null, exists: has([script, gpu]) }).reason, /no moments/);
  const rv = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job, saves: 'D/live-clips/s1', exists: has([script, gpu]) });
  assert.deepEqual(rv.spec.argv.slice(4), ['live-review', '--saves', 'D/live-clips/s1', '--since', job.since, '--until', job.until, '--encoder', 'h264_nvenc',
    '--publish', 'E:/clips', '--drop-used-saves', '--out', path.join('D', 'clips', 'runs', 'live-1')]);
  // D304 proposed: a stream that was recorded gives live-review its H recording, so the match gate applies.
  const withRec = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { ...job, h: 'C:/r/h.mkv', v: 'C:/r/v.mkv' }, saves: 'D/live-clips/s1', exists: has([script, gpu, 'C:/r/h.mkv']) });
  assert.deepEqual(withRec.spec.argv.slice(4), ['live-review', '--saves', 'D/live-clips/s1', '--since', job.since, '--until', job.until,
    '--recording', 'C:/r/h.mkv', '--threads', '4', '--encoder', 'h264_nvenc', '--publish', 'E:/clips', '--drop-used-saves', '--out', path.join('D', 'clips', 'runs', 'live-1')]);
  assert.ok(!withRec.spec.argv.includes('--montage'), 'a V recording that is gone: no montage');
  // D322 proposed (user 2026-11-10: no montage clips from a recorded stream): H and V there -> montage after the shorts.
  const withV = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { ...job, h: 'C:/r/h.mkv', v: 'C:/r/v.mkv' }, saves: 'D/live-clips/s1', exists: has([script, gpu, 'C:/r/h.mkv', 'C:/r/v.mkv']) });
  assert.deepEqual(withV.spec.argv.slice(4), ['live-review', '--saves', 'D/live-clips/s1', '--since', job.since, '--until', job.until,
    '--recording', 'C:/r/h.mkv', '--threads', '4', '--v-recording', 'C:/r/v.mkv', '--montage', '--encoder', 'h264_nvenc', '--publish', 'E:/clips',
    '--drop-used-saves', '--out', path.join('D', 'clips', 'runs', 'live-1')]);
  const vOnly = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { ...job, h: 'C:/r/h.mkv', v: 'C:/r/v.mkv' }, saves: 'D/live-clips/s1', exists: has([script, gpu, 'C:/r/v.mkv']) });
  assert.ok(!vOnly.spec.argv.includes('--montage'), 'no H recording: no detector hits, no montage');
  const goneRec = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { ...job, h: 'C:/r/h.mkv' }, saves: 'D/live-clips/s1', exists: has([script, gpu]) });
  assert.ok(!goneRec.spec.argv.includes('--recording'), 'a recording that is gone: no gate input, every save kept');
  // 2026-11-10: the H recording is a canvas; the project's game layer places the detector boxes (D235).
  const P = 'D/projects/alpha.project.json';
  const withProj = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { ...job, h: 'C:/r/h.mkv' }, saves: 'D/live-clips/s1', project: P, exists: has([script, gpu, 'C:/r/h.mkv', P]) });
  assert.deepEqual(withProj.spec.argv.slice(withProj.spec.argv.indexOf('--recording'), withProj.spec.argv.indexOf('--encoder')), ['--recording', 'C:/r/h.mkv', '--threads', '4', '--project', P]);
  const fullProj = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { type: 'full', h: 'C:/r/h.mkv', name: 'h' }, project: P, exists: has([script, gpu, P]) });
  assert.deepEqual(fullProj.spec.argv.slice(fullProj.spec.argv.indexOf('--recording'), fullProj.spec.argv.indexOf('--publish')), ['--recording', 'C:/r/h.mkv', '--project', P]);
  const noProj = clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { type: 'full', h: 'C:/r/h.mkv', name: 'h' }, project: P, exists: has([script, gpu]) });
  assert.ok(!noProj.spec.argv.includes('--project'), 'a missing project file is not passed');
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
    const out = path.join(s.dataDir, 'clips', 'runs', 'practice-h-1');
    assert.equal(s.spawned[0].argv[s.spawned[0].argv.indexOf('--out') + 1], out);
    mkdirSync(path.join(out, 'clips', 'c01'), { recursive: true });
    writeFileSync(path.join(out, 'clips', 'c01', 'stream-v.mp4'), '');
    assert.equal(countClips(out), 1, 'older run folder: the rendered videos');
    writeFileSync(path.join(out, 'published.json'), JSON.stringify({ files: [{ file: 'a' }, { file: 'b' }] }));
    mkdirSync(path.join(out, 'montage'));
    writeFileSync(path.join(out, 'montage', 'published.json'), JSON.stringify({ files: [{ file: 'm' }] }));
    assert.equal(countClips(out), 3, 'published videos (short clips + montages)');
    s.spawned[0].c.emit('exit', 0);
    assert.equal(s.status().state, 'idle');
    assert.deepEqual(s.status().last, { name: 'practice-h-1', kind: 'recording', result: 'done', code: 0, clips: 3, out, folder: path.join(s.dataDir, 'clips') });
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

test('parseProgress: only well-formed ujwalam-progress lines count; lengths capped, paths dropped', () => {
  assert.deepEqual(parseProgress('ujwalam-progress {"stage":"render","done":3,"total":7,"note":"clip 3"}'), { stage: 'render', done: 3, total: 7, note: 'clip 3' });
  assert.equal(parseProgress('ujwalam-progress {"stage":"bogus","done":1,"total":2}'), null);
  assert.equal(parseProgress('ujwalam-progress {not json'), null);
  assert.equal(parseProgress('some other line'), null);
  assert.equal(parseProgress(`ujwalam-progress ${'x'.repeat(3000)}`), null);
  assert.equal(parseProgress('ujwalam-progress {"stage":"detect","done":9,"total":4}').done, 4, 'done never above total');
  assert.equal(parseProgress('ujwalam-progress {"stage":"detect","done":-1,"total":"a"}').done, null);
  const line = (note) => 'ujwalam-progress ' + JSON.stringify({ stage: 'gate', note });
  assert.equal(parseProgress(line('n'.repeat(400))).note.length, 160);
  assert.equal(parseProgress(line('see D:\\recordings\\a.mp4 now')).note, 'see  now', 'a Windows path is dropped');
});

test('task panel: the stages of each job type in order, and their plain words', () => {
  assert.deepEqual(jobStages({ type: 'full', h: 'a.mkv' }), ['detect', 'candidates', 'gate', 'render', 'validate', 'publish']);
  assert.deepEqual(jobStages({ type: 'full', h: 'a.mkv', v: 'b.mkv' }), ['detect', 'candidates', 'gate', 'render', 'validate', 'publish', 'montage'], 'a V recording adds the montage');
  assert.deepEqual(jobStages({ type: 'review', h: 'a.mkv' }), ['detect', 'gate', 'review', 'publish'], 'the stream recording gives the matches');
  assert.deepEqual(jobStages({ type: 'review' }), ['review', 'publish']);
  assert.deepEqual(jobStages({ type: 'review', h: 'a.mkv', v: 'b.mkv' }), ['detect', 'gate', 'review', 'publish', 'montage'], 'D322: a recorded stream adds the montage');
  assert.deepEqual(jobStages({ type: 'review', v: 'b.mkv' }), ['review', 'publish'], 'no H recording: no montage');
  assert.deepEqual(stageWords('detect', { type: 'full' }), { stageText: 'Reading the game screen', unit: 'frame', measured: true });
  assert.deepEqual(stageWords('gate', { type: 'full' }), { stageText: 'Sorting clips by match', unit: 'match', measured: true });
  assert.deepEqual(stageWords('gate', { type: 'review' }), { stageText: 'Sorting saves by match', unit: null, measured: true });
  assert.deepEqual(stageWords('render', {}), { stageText: 'Making clip videos', unit: 'clip', measured: true });
  assert.deepEqual(stageWords('montage', {}), { stageText: 'Making the kill montage', unit: null, measured: false }, 'no progress while it works');
  assert.equal(stageWords('publish', {}).measured, false);
  assert.equal(parseProgress('ujwalam-progress {"stage":"montage","done":0,"total":1,"note":"making the kill montage"}').stage, 'montage');
});

test('task panel: a long montage (no progress lines) is never called stuck; a silent detect is', async () => {
  const s = setup();
  const { PassThrough } = await import('node:stream');
  const spawnFn = (exe, argv, o) => { const c = new EventEmitter(); c.stderr = new PassThrough(); c.kill = () => {}; s.spawned.push({ exe, argv, o, c }); return c; };
  const task = () => JSON.parse(readFileSync(path.join(s.dataDir, 'tasks', 'clip-practice-h-1.json'), 'utf8'));
  try {
    writeSettings(s.dataDir, { clips: { recording: 'after', live: 'off' } });
    const rc = createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: s.log, spawnFn, now: s.now });
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    const { stallOf } = await import('../services/studio-ui/tasks.mjs');
    s.advance(10 * 60_000);
    assert.equal(stallOf(task(), s.now(), 180_000).stalled, true, 'no line at all for 10 min: stuck');
    s.spawned[0].c.stderr.write('ujwalam-progress {"stage":"montage","done":0,"total":1,"note":"making the kill montage"}\n'); await tick();
    assert.deepEqual([task().stageText, task().measured, task().step ?? null], ['Making the kill montage', false, null]);
    s.advance(20 * 60_000);
    assert.deepEqual(stallOf(task(), s.now(), 180_000), { silentMs: 20 * 60_000, stalled: false }, '20 min of montage: still not stuck');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('tasks: a queued run shows as waiting while the stream is live, then running', () => {
  const s = setup();
  const task = () => JSON.parse(readFileSync(path.join(s.dataDir, 'tasks', 'clip-practice-h-1.json'), 'utf8'));
  try {
    writeSettings(s.dataDir, { clips: { recording: 'after', live: 'after' } });
    const rc = make(s);
    rc.feed(s.S('live', { stream: 'live' })); rc.feed(s.S('stopped', { stream: 'live' }));
    assert.equal(s.spawned.length, 0, 'nothing runs while the stream is live');
    assert.deepEqual([task().state, task().note], ['waiting', 'Waiting until the stream ends']);
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    assert.deepEqual([task().state, task().title], ['running', 'Finding the best moments in practice-h-1']);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('tasks: stderr progress lines drive the task title and bar; exit makes it done or failed', async () => {
  const s = setup();
  const { PassThrough } = await import('node:stream');
  const spawnFn = (exe, argv, o) => { const c = new EventEmitter(); c.stderr = new PassThrough(); c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', 1)); }; s.spawned.push({ exe, argv, o, c }); return c; };
  const task = () => JSON.parse(readFileSync(path.join(s.dataDir, 'tasks', 'clip-practice-h-1.json'), 'utf8'));
  try {
    writeSettings(s.dataDir, { clips: { recording: 'after', live: 'off' } });
    const rc = createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: s.log, spawnFn, now: s.now });
    rc.feed(s.S('live')); const t0 = s.now(); rc.feed(s.S('stopped'));
    // Task panel (2026-11-10): before any progress line the task says "Starting", knows its 5 steps, and has no
    // progressAt (the stall warning then measures from activeAt).
    assert.deepEqual([task().stage, task().stageText, task().unit, task().stages, task().activeAt, task().progressAt],
      ['detect', 'Starting', null, ['detect', 'candidates', 'gate', 'render', 'validate', 'publish', 'montage'], t0, null]);
    const err = s.spawned[0].c.stderr;
    s.advance(5000);
    err.write('warming up\nujwalam-progress {"stage":"detect","done":40,"total":100,"note":"scanning"}\n');
    await tick();
    assert.deepEqual([task().stage, task().done, task().total, task().note], ['detect', 40, 100, 'scanning']);
    assert.deepEqual([task().stageText, task().unit, task().progressAt], ['Reading the game screen', 'frame', t0 + 5000]);
    err.write('ujwalam-progress {"stage":"rend'); await tick();
    err.write('er","done":2,"total":7}\nnot a progress line\n'); await tick();
    assert.equal(task().title, 'Editing clips from practice-h-1');
    assert.deepEqual([task().stageText, task().unit], ['Making clip videos', 'clip']);
    assert.equal(task().state, 'running');
    s.spawned[0].c.emit('exit', 1);
    assert.equal(task().state, 'failed');
    assert.match(task().title, /did not finish/);
    assert.match(readFileSync(path.join(s.dataDir, 'clips', 'run-practice-h-1.log'), 'utf8'), /warming up/, 'stderr still reaches the log');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('D300: a finished clip job hands its run folder to the post chain; every status feeds its tick; a failed job does not', async () => {
  const s = setup();
  try {
    writeSettings(s.dataDir, { clips: { recording: 'after', live: 'off' } });
    const after = []; const ticks = [];
    const postChain = { afterRun: (dir, status) => { after.push({ dir, live: isLive(status) }); return Promise.resolve(); }, tick: (status) => { ticks.push(status); return Promise.resolve(); } };
    const rc = createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: s.log, spawnFn: s.spawnFn, now: s.now, postChain });
    rc.feed(s.S('live')); s.advance(60000); rc.feed(s.S('stopped'));
    assert.ok(ticks.length >= 2, 'each status feeds the chain tick');
    const out = path.join(s.dataDir, 'clips', 'runs', 'practice-h-1');
    mkdirSync(path.join(out, 'clips', 'a'), { recursive: true }); writeFileSync(path.join(out, 'clips', 'a', 'x.mp4'), 'v');
    s.spawned[0].c.emit('exit', 0);
    assert.deepEqual(after, [{ dir: out, live: false }]);
    // a failed job posts nothing
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    s.spawned[1].c.emit('exit', 1);
    assert.equal(after.length, 1);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

// --- LC1 (D333 proposed): live clipper state, moments kept, reels not made ---
test('countSaves: rows of the newest session since a time; nothing yet = 0', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-lc1-'));
  try {
    assert.equal(countSaves(d, null), 0);
    const s = path.join(d, 'live-clips', '20261110-100000');
    mkdirSync(s, { recursive: true });
    writeFileSync(path.join(s, 'saves.jsonl'), ['{"v":1,"at":"2026-11-10T09:59:00.000Z"}', '{"v":1,"at":"2026-11-10T10:01:00.000Z"}', 'not json', '', '{"v":1,"at":"2026-11-10T10:02:00.000Z"}'].join('\n'));
    assert.equal(countSaves(d, '2026-11-10T10:00:00.000Z'), 2);
    assert.equal(countSaves(d, null), 3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('liveClipperTask: running while watched (never "stuck"), the reason when it is not running, a finished row once', () => {
  const lc = { state: 'running', reason: null, restarts: 0, maxRestarts: 5 };
  const r = liveClipperTask({ lc, watching: true, saves: 2, since: 1000, now: 5000 });
  assert.deepEqual([r.id, r.kind, r.state, r.title, r.note, r.measured], ['live-clipper', 'live-clips', 'running', 'Live clips: watching the game', '2 moments kept so far', false]);
  assert.equal(liveClipperTask({ lc: { ...lc, restarts: 1 }, watching: true, saves: 1, since: 1, now: 2 }).note, '1 moment kept so far; restarted 1 time');
  const no = liveClipperTask({ lc: { state: 'not-started', reason: 'the game layer has no capture device (devices are off or none is chosen)' }, watching: true, now: 1 });
  assert.deepEqual([no.state, no.title, no.note], ['failed', 'Live clips are not being made', 'the game layer has no capture device (devices are off or none is chosen)']);
  assert.equal(liveClipperTask({ lc: null, watching: true, now: 1 }).note, 'the live clipper is not running');
  const end = liveClipperTask({ lc, watching: false, ended: true, saves: 3, since: 1, now: 9 });
  assert.deepEqual([end.state, end.title, end.note], ['done', 'Live clips: 3 moments kept', 'They become clips after the stream']);
  assert.equal(liveClipperTask({ lc, watching: false, ended: true, saves: 0, now: 9 }).note, 'No moment was found');
  assert.equal(liveClipperTask({ lc, watching: false, ended: false, now: 1 }), null, 'nothing to show when nothing is watched');
});

test('reelsNotMade: why the kill montages and match reels were not made, from the job or render.json', () => {
  const files = {};
  const readJson = (f) => { if (!Object.hasOwn(files, f)) throw new Error('missing'); return files[f]; };
  const exists = () => true;
  const out = path.join('C:', 'runs', 'x');
  const rv = { type: 'review', h: 'C:/r/a.mkv', v: 'C:/r/a-v.mkv' };
  assert.equal(reelsNotMade({ type: 'review' }, out, { readJson, exists }), 'the stream was not recorded');
  assert.equal(reelsNotMade({ type: 'review', h: 'C:/r/a.mkv' }, out, { readJson, exists }), 'there is no portrait (V) recording of this stream');
  assert.equal(reelsNotMade(rv, out, { readJson, exists: (p) => p !== rv.v }), 'the portrait (V) recording is missing');
  assert.equal(reelsNotMade(rv, out, { readJson, exists }), 'the reel step left no result; see the log');
  files[path.join(out, 'render.json')] = { montage: { status: 'skipped', reason: 'no kills were found in the recording' } };
  assert.equal(reelsNotMade(rv, out, { readJson, exists }), 'no kills were found in the recording');
  files[path.join(out, 'render.json')] = { montage: { status: 'failed' } };
  assert.equal(reelsNotMade(rv, out, { readJson, exists }), 'failed');
  files[path.join(out, 'render.json')] = { montage: { status: 'made' } };
  assert.equal(reelsNotMade(rv, out, { readJson, exists }), null);
  assert.equal(reelsNotMade({ type: 'full', h: 'a' }, out, { readJson, exists }), 'there is no portrait (V) recording');
  assert.equal(reelsNotMade({ type: 'full', h: 'a', v: 'b' }, out, { readJson, exists }), 'the reel step did not finish; see the log');
  files[path.join(out, 'montage', 'report.json')] = {};
  assert.equal(reelsNotMade({ type: 'full', h: 'a', v: 'b' }, out, { readJson, exists }), null);
});

test('LC1: status.json and the task panel show the live clipper while a stream is watched; a review without V says "Reels not made"', async () => {
  const s = setup();
  try {
    writeSettings(s.dataDir, { clips: { recording: 'off', live: 'while' } });
    const saves = path.join(s.dataDir, 'live-clips', '20261108-100000');
    mkdirSync(saves, { recursive: true });
    writeFileSync(path.join(saves, 'saves.jsonl'), '');
    const lc = { state: 'running', reason: null, restarts: 0, maxRestarts: 5, flagOn: false };
    const rc = createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: s.log, spawnFn: s.spawnFn, now: s.now, liveClipper: () => lc });
    const taskFile = path.join(s.dataDir, 'tasks', 'live-clipper.json');
    const task = () => JSON.parse(readFileSync(taskFile, 'utf8'));
    rc.feed(s.S('stopped'));
    assert.equal(existsSync(taskFile), false, 'not live: no row');
    assert.equal(s.status().liveClipper.watching, false);
    // live and recording H only (no V recording), so the reels cannot be made after
    const live = (state) => ({ rungs: RUNGS, sinks: [{ id: 'practice-h', kind: 'record', rung: 'rec-h', state, path: s.h }, { id: 'yt', kind: 'stream', rung: 'rec-h', state }] });
    rc.feed(live('live'));
    assert.deepEqual([task().state, task().note], ['running', '0 moments kept so far']);
    s.advance(30000);
    writeFileSync(path.join(saves, 'saves.jsonl'), `${JSON.stringify({ v: 1, at: new Date(s.now()).toISOString() })}\n`);
    rc.feed(live('live'));
    assert.equal(task().note, '1 moment kept so far');
    const v = s.status().liveClipper;
    assert.deepEqual([v.state, v.watching, v.saves, v.restarts], ['running', true, 1, 0]);
    lc.state = 'not-started'; lc.reason = 'the game layer has no capture device (devices are off or none is chosen)';
    rc.feed(live('live'));
    assert.deepEqual([task().state, task().title, task().note], ['failed', 'Live clips are not being made', lc.reason]);
    lc.state = 'running'; lc.reason = null;
    s.advance(30000);
    rc.feed(live('stopped'));
    assert.deepEqual([task().state, task().title], ['done', 'Live clips: 1 moment kept']);
    // the review job: H only, so no --montage, and the finished task says why the reels were not made
    assert.equal(s.spawned.length, 1);
    assert.equal(s.spawned[0].argv.includes('--montage'), false);
    s.spawned[0].c.emit('exit', 0);
    const done = JSON.parse(readFileSync(path.join(s.dataDir, 'tasks', 'clip-practice-h-1.json'), 'utf8'));
    assert.equal(done.state, 'done');
    assert.equal(done.note, '0 clips made. Reels not made: there is no portrait (V) recording of this stream');
    assert.equal(s.status().last.reelsNotMade, 'there is no portrait (V) recording of this stream');
    assert.ok(s.lines.some((l) => /reels not made from practice-h-1/.test(l)));
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});
