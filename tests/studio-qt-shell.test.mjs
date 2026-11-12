// SPDX-License-Identifier: GPL-3.0-or-later
// Qt studio shell (P5a step 1) smoke test: headless (UJWALAM_HEADLESS=1, no window), the shell logs in to a real
// studio UI server (fake host, stub core, 127.0.0.1) with the one-time launch key from its environment, calls
// scenes.list through the server and prints one line. Also: the key is single use, a bad URL is refused.
// Skipped when the shell is not built (npm run build:studio) or no Qt kit is configured.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
// UJWALAM_STUDIO_TEST_EXE runs these tests against a packaged, self-contained studio exe (studio/ of an unzipped alpha
// build, D277): its Qt DLLs sit beside it, so no Qt kit goes on PATH.
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 20_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('Qt studio shell (headless smoke)', { skip }, () => {
  const KEY = 'k'.repeat(40);
  let srv, port, dataDir;
  before(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qt-'));
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, limits: { statusPollMs: 50 } });
    ({ port } = await srv.listen());
  });
  after(() => { srv?.close(); rmSync(dataDir, { recursive: true, force: true }); });

  test('logs in with the launch key and lists scenes through the UI server', async () => {
    const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: KEY });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio smoke: ok, 3 scene\(s\)$/m);
  });
  test('the launch key is single use: a second shell is refused', async () => {
    const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: KEY });
    assert.equal(r.code, 77);
    assert.match(r.err, /login failed/);
  });
  test('only a 127.0.0.1 server URL is accepted', async () => {
    const r = await runShell({ UJWALAM_UI_URL: 'http://example.com:80/', UJWALAM_UI_LAUNCH_KEY: KEY });
    assert.equal(r.code, 64);
  });
});

// Panel probe (D271): the shell runs its loads and status polls with the window never shown (offscreen, headless),
// then prints what its panels show. Real UI server, fake host, fake bots; flags set in the server's flag store.
// A project file that matches the fake host's scene-1 and scene-2 (layer ids game, cam, chat / text), for the menu tests.
function menuProject() {
  const doc = createProject({ name: 'T', fps: 30 });
  const place = (w, h) => ({ h: { visible: true, x: 0, y: 0, width: w, height: h }, v: { visible: true, x: 0, y: 0, width: 1080, height: 608 } });
  doc.scenes = [
    { id: 'scene-1', name: 'Gameplay', layers: [
      { id: 'game', type: 'color', name: 'Game capture', source: { color: '#101010' }, placements: place(1920, 1080) },
      { id: 'cam', type: 'color', name: 'Camera', source: { color: '#202020' }, placements: place(440, 248) },
      { id: 'chat', type: 'color', name: 'Chat overlay', source: { color: '#303030' }, visible: false, placements: place(480, 440) },
    ] },
    { id: 'scene-2', name: 'Starting soon', layers: [{ id: 'text', type: 'text', name: 'Title card', source: { text: 'Soon' }, placements: place(1920, 1080) }] },
  ];
  doc.activeScene = 'scene-1';
  doc.devices = [{ id: 'cam-dev', kind: 'camera', name: 'Face camera', match: { name: 'Cam' } }];
  const v = validateProject(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return doc;
}

describe('Qt studio shell panels (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe(on, ms = 5000, actions = '', prepare = null, env = {}, opts = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtp-')); dirs.push(dataDir);
    if (prepare) prepare(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of on) flags.set(id, true);
    const fake = createFakeHost({ outputsReady: !!opts.live });
    if (opts.live) await fake.call('stream.start', {}); // the window sees a live stream
    const calls = [];
    // opts.slowStatusMs: host.status answers late, so a structure reply (the route asks host.status first) arrives after
    // the user has moved on (D330 review).
    const host = { describe: () => fake.describe(), call: async (m, p) => {
      calls.push([m, p]);
      if (opts.slowStatusMs && m === 'host.status') await new Promise((r) => setTimeout(r, opts.slowStatusMs));
      if (opts.hostStatus && m === 'host.status') return { ...(await fake.call(m, p)), ...opts.hostStatus(calls) }; // D335: extra host status fields
      if (opts.hostCall) { const r = await opts.hostCall(m, p, calls); if (r !== undefined) return r; } // D335: a host answer of the test's own (may throw)
      return fake.call(m, p);
    } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'p'.repeat(40);
    const file = opts.project ? path.join(dataDir, 'p.project.json') : null;
    if (file) { const doc = menuProject(); opts.editProject?.(doc); saveProject(file, doc); }
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), limits: { statusPollMs: 50 }, ...(file ? { projectSync: createProjectSync({ file }) } : {}) });
    const { port } = await srv.listen();
    // opts.onStatus(n, dataDir): called once per status request the shell makes (n counts from 1), so a test can change
    // state at a point in the shell's own progress instead of at a wall-clock time that a loaded machine moves.
    if (opts.onStatus) {
      let n = 0;
      srv.server.on('request', (req) => { if (req.method === 'GET' && req.url?.split('?')[0] === '/ui/api/status') opts.onStatus(++n, dataDir); });
    }
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions, ...env });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { ...JSON.parse(m[1]), fake, store: flags, calls, dataDir, file };
    } finally { srv.close(); }
  }

  test('defaults: every flag listed and off, flag-gated panels hidden, scenes and layers loaded', async () => {
    const p = await probe([]);
    const ids = JSON.parse(readFileSync(path.join(UI, '..', 'data', 'flags.json'), 'utf8')).flags.map((f) => f.id);
    assert.deepEqual(p.flags.map((f) => f.id), ids);
    assert.ok(p.flags.every((f) => f.on === (f.id === 'preview-edit')), 'all off but preview-edit (on by default, D330)');
    assert.deepEqual(p.shown, { structure: false, transitions: false, bots: false, report: false, posts: false, review: false });
    assert.equal(p.scenes, 3);
    assert.ok(p.layers > 0, 'the active scene\'s layers are listed');
    assert.equal(p.undoEnabled, false, 'empty history');
    assert.equal(p.live, false);
    assert.equal(p.trackButtons, 0, 'no track routing buttons while mixer-routing is off');
    // D280: the slots asked for canvas h and v (the server's enum); an upper-case id was refused as "bad field canvas".
    assert.equal(p.previews.length, 2);
    for (const m of p.previews) assert.doesNotMatch(m, /bad field/, m);
    assert.equal(p.clips, 'Clips: ready', 'D284: no clip runs yet, the default choice is "ask me"');
    assert.deepEqual(p.clipSettings, { recording: 'ask', live: 'ask', recordLive: true, matchGate: { top3: true, minKills: null } });
  });

  test('flags on: structure, transitions, bots, report and posts appear; bots listed with their buttons; mixer track buttons', async () => {
    const p = await probe(['scene-edit', 'transitions', 'bot-manager', 'report-button', 'posting', 'mixer-routing']);
    for (const id of ['scene-edit', 'transitions', 'bot-manager', 'report-button', 'posting']) assert.equal(p.flags.find((f) => f.id === id)?.on, true, id);
    assert.deepEqual(p.shown, { structure: true, transitions: true, bots: true, report: true, posts: true, review: false });
    assert.equal(p.botButtons, 4, 'Start and Stop for Streamer.bot and Speaker.bot');
    assert.equal(p.trackButtons, 6, 'mixer-routing: a button per project track (2) on each of the 3 fake mixer strips (D273)');
  });
  test('probe actions click the real widgets: Mute, a track button, a flag off; undo with no history does nothing (D275)', async () => {
    const p = await probe(['mixer-routing', 'scene-edit'], 7000, 'mute:0,track:0:1,flag-off:scene-edit,undo');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['mute:0', true], ['track:0:1', true], ['flag-off:scene-edit', true], ['undo', false]]);
    const cam = (await p.fake.call('mixer.list')).sources.find((s) => s.id === 'scene-1/cam');
    assert.equal(cam.muted, true, 'Mute clicked: mixer.setMute reached the host');
    assert.deepEqual(cam.tracks, ['t1', 't2'], 'second track clicked: mixer.setTracks with both tracks');
    assert.equal(p.store.isOn('scene-edit'), false, 'flag switched off: off at once');
    assert.equal(p.shown.structure, false, 'the structure box follows the flag');
    assert.equal(p.trackButtons, 6);
  });
  test('Save clip and Mark moment (D281): replay.save and an api marker reach the host with no confirm', async () => {
    const p = await probe([], 6000, 'clip,mark');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['clip', true], ['mark', true]]);
    assert.ok(p.calls.some(([m]) => m === 'replay.save'), 'replay.save called');
    assert.ok(p.calls.some(([m, q]) => m === 'marker.add' && q?.source === 'api'), 'marker.add {source: api} called');
  });
  test('clip maker without Python (the zip ships none): the pill says so in plain words, the tooltip has the reason and the fix', async () => {
    const reason = "the clip maker's Python is missing (the Ujwalam download does not include Python; looked in C:\\Ujwalam\\app)";
    const fix = 'To make clips, point Ujwalam at a folder that has the clip maker and its Python: Install-Ujwalam.ps1 -SettingsOnly -ClipMaker <folder>';
    const p = await probe([], 5000, '', (d) => {
      mkdirSync(path.join(d, 'clips'), { recursive: true });
      writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { recording: 'after', live: 'off' } }));
      writeFileSync(path.join(d, 'clips', 'status.json'), JSON.stringify({ state: 'idle', available: false, reason, fix, missing: 'python', asks: [], queued: [], last: null }));
    });
    assert.equal(p.clips, 'Clips: Python not found');
    assert.ok(p.clipsTip.includes(reason), p.clipsTip);
    assert.ok(p.clipsTip.includes(fix), p.clipsTip);
    const q = await probe([], 5000, '', (d) => {
      mkdirSync(path.join(d, 'clips'), { recursive: true });
      writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { recording: 'after', live: 'off' } }));
      writeFileSync(path.join(d, 'clips', 'status.json'), JSON.stringify({ state: 'idle', available: false, reason: 'the clip maker is not set up on this PC', fix, missing: 'root', asks: [], queued: [], last: null }));
    });
    assert.equal(q.clips, 'Clips: not set up');
  });
  test('clip choices (D284): Settings saves the modes; a "make clips?" question is answered from the window', async () => {
    const ask = { id: 'practice-h-1-1', name: 'practice-h-1', kind: 'recording', minutes: 8 };
    const p = await probe([], 6000, 'clip-modes:after:while,answer:yes', (d) => {
      mkdirSync(path.join(d, 'clips'), { recursive: true });
      writeFileSync(path.join(d, 'clips', 'status.json'), JSON.stringify({ state: 'idle', available: true, asks: [ask], queued: [], last: null }));
    });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['clip-modes:after:while', true], ['answer:yes', true]]);
    assert.equal(p.clipAsks, 1, 'the question is listed until the launcher picks up the answer');
    assert.equal(p.clips, 'Make clips? (1)');
    const saved = JSON.parse(readFileSync(path.join(p.dataDir, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.clips, { recording: 'after', live: 'while', recordLive: true, matchGate: { top3: true, minKills: null } });
    assert.deepEqual(JSON.parse(readFileSync(path.join(p.dataDir, 'clips', 'answer.json'), 'utf8')), { id: ask.id, make: true, remember: false });
  });

  // Task bar (D287): chip, list and toasts are child widgets of the window (no top-level window, no focus); the tasks come
  // in the status snapshot from <dataDir>/tasks/*.json.
  const task = (dataDir, o) => writeTaskFile(dataDir, { kind: 'clips', startedAt: Date.now() - 5000, updatedAt: Date.now(), ...o });
  test('task bar (D287): chip counts running tasks, the list opens and closes by probe action, idle hides the chip', async () => {
    const idle = await probe([]);
    assert.equal(idle.tasks.chipHidden, true, 'hidden when nothing runs');
    assert.deepEqual([idle.tasks.running, idle.tasks.total, idle.tasks.panelOpen, idle.tasks.toasts], [0, 0, false, 0]);
    const p = await probe([], 6000, 'tasks:open', (d) => {
      task(d, { id: 'clip-a', title: 'Editing clips (3 of 7)', state: 'running', stage: 'render', done: 2, total: 7 });
      task(d, { id: 'clip-b', title: 'Clips from practice-3', state: 'waiting', note: 'Waiting until the stream ends' });
      task(d, { id: 'ui-c', kind: 'preview', title: 'Opening the horizontal preview', state: 'failed', note: 'Could not open' });
    });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['tasks:open', true]]);
    assert.equal(p.tasks.chipHidden, false);
    assert.equal(p.tasks.chipText, '1 task running');
    assert.deepEqual([p.tasks.running, p.tasks.waiting, p.tasks.total, p.tasks.rows, p.tasks.panelOpen], [1, 1, 3, 3, true]);
    assert.equal(p.tasks.toasts, 0, 'tasks already finished when the window starts do not pop up');
    const c = await probe([], 6000, 'tasks:open,tasks:close,tasks:dismiss', (d) => {
      task(d, { id: 'ui-c', kind: 'preview', title: 'Opening the horizontal preview', state: 'failed' });
    });
    assert.deepEqual(c.actions.map((a) => [a.action, a.done]), [['tasks:open', true], ['tasks:close', true], ['tasks:dismiss', true]]);
    assert.deepEqual([c.tasks.panelOpen, c.tasks.rows, c.tasks.total], [false, 0, 1], 'the X hides a finished task from the list');
  });
  test('task bar: "Clear finished" removes every done and failed task at once; running and waiting ones stay (user, 2026-11-10)', async () => {
    const p = await probe([], 6000, 'tasks:open,tasks:clear', (d) => {
      task(d, { id: 'clip-a', title: 'Editing clips (3 of 7)', state: 'running', stage: 'render', done: 2, total: 7 });
      task(d, { id: 'clip-b', title: 'Clips from practice-3', state: 'waiting', note: 'Waiting until the stream ends' });
      task(d, { id: 'ui-c', kind: 'preview', title: 'Opening the horizontal preview', state: 'failed', note: 'Could not open' });
      task(d, { id: 'ui-d', kind: 'upload', title: 'Uploaded', state: 'done' });
      task(d, { id: 'data-posting-rules', kind: 'data', title: 'Auto-post rules not applied: the file has a problem', state: 'failed' });
    });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['tasks:open', true], ['tasks:clear', true]]);
    assert.deepEqual([p.tasks.total, p.tasks.rows, p.tasks.clearShown, p.tasks.panelOpen], [5, 2, false, true], 'the two unfinished tasks stay listed');
    const only = await probe([], 6000, 'tasks:open,tasks:clear', (d) => {
      task(d, { id: 'ui-d', kind: 'upload', title: 'Uploaded', state: 'done' });
    });
    assert.deepEqual([only.tasks.rows, only.tasks.panelOpen, only.tasks.chipHidden], [0, false, true], 'nothing left: the list folds away');
    const before = await probe([], 5000, 'tasks:open', (d) => { task(d, { id: 'ui-d', kind: 'upload', title: 'Uploaded', state: 'done' }); });
    assert.equal(before.tasks.clearShown, true, 'the button shows while a finished task is listed');
  });
  test('task bar (D287): a task that was running and finishes gives a toast; a failure too; the stats cards fill from the status poll', async () => {
    const p = await probe([], 5500, '', (d) => {
      task(d, { id: 'clip-a', title: 'Editing clips', state: 'running', done: 1, total: 4 });
      setTimeout(() => task(d, { id: 'clip-a', title: 'Clips ready from practice-1', state: 'done', note: '4 clips made' }), 1200);
      setTimeout(() => task(d, { id: 'ui-x', kind: 'upload', title: 'Uploading a clip to YouTube (private)', state: 'failed', note: 'The upload did not finish' }), 2200);
    });
    assert.equal(p.tasks.toasts, 2, 'one toast for the finished clip run, one for the failed upload');
    assert.deepEqual([p.tasks.running, p.tasks.chipHidden, p.tasks.chipQuiet, p.tasks.chipText], [0, false, true, 'Tasks'], 'only finished tasks listed: a quiet button');
    assert.equal(p.tasks.lastToast, 'Failed: Uploading a clip to YouTube (private)');
    assert.ok(p.stats.samples >= 2, 'a history sample per status poll');
    assert.equal(p.stats.session, 'Not live');
  });
  // 2026-11-08 crash (docs/evidence/2026-11-08-studio-crash.md): the window closed itself a few seconds after a clip
  // job started (recording stopped, "while" mode). The task bar's progress bar kept a raw pointer to its glide
  // animation, which deletes itself when it ends; the next status poll called stop() on the freed animation. Only a
  // shown window animates, so this probe shows it (offscreen platform: nothing on screen, no focus) with motion on, and
  // drives the same sequence: a clip task running with progress, then done, while recording.
  test('regression (D296 proposed): a clip task running and finishing with the window shown and animations on does not crash the studio', async () => {
    const p = await probe([], 16000, 'tasks:open,tasks:close,tasks:open', (d) => {
      const steps = [[0, 'running', 0], [1500, 'running', 1], [3500, 'running', 2], [5500, 'running', 3], [7500, 'running', 4], [9500, 'done', 5]];
      for (const [at, state, done] of steps)
        setTimeout(() => task(d, { id: 'clip-practice-h', title: state === 'done' ? 'Clips ready from practice-h' : 'Reviewing the moments in practice-h', state, stage: 'review', done, total: 5, note: `clip L0${done} done` }), at);
      setTimeout(() => task(d, { id: 'ui-prev', kind: 'preview', title: 'Opening the horizontal preview', state: 'done' }), 4000);
    }, { UJWALAM_STUDIO_PROBE_SHOW: '1', UJWALAM_REDUCE_MOTION: '0' });
    assert.equal(p.windowShown, true, 'the probe window was shown (offscreen), so the animations ran');
    assert.equal(p.tasks.running, 0, 'the clip job finished while the window watched');
    assert.ok(p.tasks.titles.includes('Clips ready from practice-h'), JSON.stringify(p.tasks.titles));
  });
  // Task panel (user feedback 2026-11-10): the button is in the top bar at the right, the panel and the notifications
  // open under it at the top right, each task is shown in full (stage words, step, count, time left or "estimating",
  // last progress), and a task with no progress for stallAfterMs (data/studio/tasks.json, 3 min) warns "it may be stuck".
  const STAGES = ['detect', 'candidates', 'gate', 'render', 'validate'];
  const hung = (d) => task(d, { id: 'clip-hung', title: 'Finding the best moments in practice-h-7', state: 'running', stage: 'detect', stages: STAGES, stageText: 'Starting',
    activeAt: Date.now() - 5 * 60_000 - 5000, progressAt: null, startedAt: Date.now() - 6 * 60_000 });
  test('task panel (2026-11-10): top-right button and panel; every task in full; a job with no progress for 5 min warns it may be stuck', async () => {
    const p = await probe([], 6000, 'tasks:open', (d) => {
      hung(d);
      task(d, { id: 'clip-a', title: 'Finding the best moments in practice-h-8', state: 'running', stage: 'detect', stages: STAGES, stageText: 'Reading the game screen', unit: 'frame',
        done: 412, total: 3148, activeAt: Date.now() - 60_000, progressAt: Date.now() });
      task(d, { id: 'clip-b', title: 'Clips from practice-3', state: 'waiting', note: 'Waiting for its turn' });
    }, { UJWALAM_STUDIO_PROBE_SHOW: '1' }, { onStatus: (n, d) => { if (n > 1) task(d, { id: 'clip-a', title: 'Finding the best moments in practice-h-8', state: 'running', stage: 'detect', stages: STAGES, stageText: 'Reading the game screen', unit: 'frame', done: Math.min(3148, 412 + n * 3), total: 3148, activeAt: Date.now() - 60_000, progressAt: Date.now() }); } });
    const t = p.tasks;
    assert.deepEqual([t.chipInTopBar, t.chipHidden, t.panelOpen, t.running, t.waiting, t.stalled], [true, false, true, 2, 1, 1]);
    assert.equal(t.chipText, '2 tasks running - 1 may be stuck');
    assert.equal(t.panel.right, 14, 'anchored at the right edge');
    assert.ok(t.panel.y >= t.topY && t.panel.y < 140, `under the top bar: ${JSON.stringify(t.panel)} topY ${t.topY}`);
    assert.ok(t.panel.width >= 400, 'wide enough that lines are read in full');
    const by = Object.fromEntries(t.detail.map((r) => [r.id, r]));
    assert.equal(by['clip-hung'].stage, 'Step 1 of 5: Starting');
    assert.match(by['clip-hung'].warn, /^No progress for 5 min - it may be stuck$/);
    assert.match(by['clip-hung'].last, /^No progress yet \(started 5 min ago\)$/);
    assert.equal(by['clip-hung'].count, 'Working; how much is left is not known for this step');
    assert.match(by['clip-hung'].eta, /^Elapsed \d+:\d\d · Time left unknown$/);
    assert.deepEqual([by['clip-hung'].stalled, by['clip-hung'].stop], [true, true]);
    assert.equal(by['clip-a'].stage, 'Step 1 of 5: Reading the game screen');
    assert.match(by['clip-a'].count, /^4\d\d of 3148 frames \(1[34]%\)$/);
    assert.match(by['clip-a'].eta, /^Elapsed \d+:\d\d · (Estimating time left\.\.\.|About \d+ (h \d+ )?min left in this step)$/, 'a measured time left, or estimating; never a guess');
    assert.match(by['clip-a'].last, /^Last progress \d+ s ago$/);
    assert.deepEqual([by['clip-a'].stalled, by['clip-a'].warn, by['clip-a'].stop], [false, '', true]);
    assert.deepEqual([by['clip-b'].state, by['clip-b'].stop], ['waiting', true]);
    assert.match(by['clip-b'].eta, /^Elapsed \d+:\d\d · Waiting its turn$/);
    assert.ok(t.toastsShown >= 1 && t.toastPos.every((x) => x.y >= t.topY), 'notifications under the top bar');
    assert.ok(t.toastPos.every((x) => x.x + x.width <= t.panel.x), 'with the panel open, notifications sit to its left');
  });
  test('task panel (2026-11-10): the "may be stuck" notification is at the top right; a click opens the panel; Stop reaches the stop route', async () => {
    const p = await probe([], 5000, 'tasks:toast-click,tasks:stop', (d) => hung(d), { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    const t = p.tasks;
    assert.ok(t.toastLog.includes('May be stuck: Finding the best moments in practice-h-7'), JSON.stringify(t.toastLog));
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['tasks:toast-click', true], ['tasks:stop', true]]);
    assert.deepEqual([t.toastClicks, t.panelOpen, t.stopsSent], [1, true, 1]);
    assert.ok(existsSync(path.join(p.dataDir, 'clips', 'stop-tasks.json')), 'the launcher gets the stop request');
    const q = await probe([], 3500, '', (d) => hung(d), { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    assert.equal(q.tasks.panelOpen, false, 'collapsed until clicked');
    assert.ok(q.tasks.toastLog.includes('May be stuck: Finding the best moments in practice-h-7'), JSON.stringify(q.tasks.toastLog));
    assert.ok(q.tasks.toastPos.length >= 1);
    assert.ok(q.tasks.toastPos.every((x) => x.right === 14), `notifications at the right edge: ${JSON.stringify(q.tasks.toastPos)}`);
    assert.ok(q.tasks.toastPos[0].y >= q.tasks.topY && q.tasks.toastPos[0].y < 140, 'the first at the top, under the top bar');
  });
  test('match filter (D287): saved through the settings route; an older server refusing the key gives a plain message', async () => {
    const p = await probe([], 6000, 'match-gate:true:5');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['match-gate:true:5', true]]);
    assert.match(p.note, /match filter|Settings saved/, p.note);
    assert.doesNotMatch(p.note, /HTTP 400|bad-settings/, 'plain words, not the raw refusal');
  });
  test('look (D285): the themed window renders to a 1600x900 picture; the top bar fits', async () => {
    const shot = path.join(os.tmpdir(), `ujw-shot-${process.pid}.png`);
    try {
      // The finish of clip-z is tied to the shell's own status polls (every 2 s), not to a wall-clock timer: the shell
      // sees it running on its first poll and done on a later one, so the toast (alive 4 s) always starts well inside the
      // probe's 5.5 s, however slowly the shell starts on a loaded machine (a timer from before the launch made the toast
      // appear never, or after the probe had ended: toasts 0 vs 1, 2026-11-09).
      const p = await probe(['posting', 'report-button'], 5500, 'tasks:open', (d) => {
        task(d, { id: 'clip-a', title: 'Editing clips (3 of 7)', state: 'running', done: 2, total: 7 });
        task(d, { id: 'clip-b', title: 'Clips from practice-3', state: 'waiting' });
        task(d, { id: 'clip-z', title: 'Clips ready from practice-1', state: 'running' });
      }, { UJWALAM_STUDIO_PROBE_SHOT: shot, QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts') }, // the real UI font (offscreen has none)
      { onStatus: (n, d) => { if (n === 2) task(d, { id: 'clip-z', title: 'Clips ready from practice-1', state: 'done' }); } });
      assert.equal(p.shot, true);
      const b = readFileSync(shot);
      assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [1600, 900], 'not widened by the top bar');
      assert.deepEqual([p.shown.posts, p.shown.report], [true, true], 'Posts and Report a problem in the More menu');
      assert.deepEqual([p.tasks.panelOpen, p.tasks.toasts, p.tasks.chipHidden], [true, 1, false], 'the shot shows the task list and a toast, still 1600x900');
    } finally { rmSync(shot, { force: true }); }
  });
  // --- Look panel, Settings, motion (D290) ---
  test('Look panel (D290): shown for a selected layer with no flag; built from the effect table; a switch and a slider reach layers.setEffects', async () => {
    const p = await probe([], 9000, 'select-layer:cam,look:rounded:on,look-set:rounded:radius:40');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['select-layer:cam', true], ['look:rounded:on', true], ['look-set:rounded:radius:40', true]]);
    assert.equal(p.look.shown, true, 'no effect-editor flag needed');
    assert.equal(p.look.advancedShown, false, 'the plain list stays behind the flag');
    assert.deepEqual(p.look.groups, ['shape', 'filter', 'camera', 'compositing', 'light'], 'the table groups, in the usual order (compositing from D291)');
    assert.equal(p.look.cards[0].type, 'rounded', 'rounded corners come first in Shape');
    assert.ok(p.look.cards.length >= 9, 'one card per effect type in the table');
    const sets = p.calls.filter(([m]) => m === 'layers.setEffects');
    assert.ok(sets.length >= 1, 'layers.setEffects reached the host');
    assert.deepEqual(sets.at(-1)[1], { scene: 'scene-1', layer: 'cam', effects: [{ type: 'rounded', radius: 40 }] });
    assert.equal((await p.fake.call('layers.list', { scene: 'scene-1' })).layers.find((l) => l.id === 'cam').effects[0].radius, 40);
    assert.equal(p.undoEnabled, true, 'a Look change is an undoable edit');
    assert.equal(p.look.cards.find((c) => c.type === 'rounded').on, true);
  });
  test('Look panel (D290): switching off removes the effect; flag effect-editor shows the Advanced list too', async () => {
    const p = await probe(['effect-editor'], 10000, 'select-layer:cam,look:blur:on,look:rounded:on,look:blur:off');
    assert.equal(p.look.advancedShown, true);
    const sets = p.calls.filter(([m]) => m === 'layers.setEffects');
    assert.deepEqual(sets.at(-1)[1].effects.map((e) => e.type), ['rounded'], 'blur switched on then off: only rounded corners left');
  });
  test('controls and flags (D290): round controls carry their captions; the flag list is not on the main window', async () => {
    const p = await probe([]);
    assert.deepEqual(p.controls, { stream: 'Start stream', record: 'Record', clip: 'Save clip', mark: 'Mark moment', streamIcon: 'play-' });
    assert.equal(p.flagsInSettings, false, 'the flag rows exist only inside Settings > Advanced');
    assert.ok(p.flags.length > 5, 'still loaded: the list follows the server');
  });
  test('Settings (D290, D294): sections Clips, Folders, Layer effects, Appearance, Preview (D335), Connections (D327), Help & tips, Advanced; the layer-effects item and animations choice are there', async () => {
    const p = await probe([], 6000, 'settings-open,settings-section:Advanced');
    assert.deepEqual(p.settings.sections, ['Clips', 'Folders', 'Layer effects', 'Appearance', 'Preview', 'Connections', 'Help & tips', 'Advanced']);
    assert.equal(p.settings.layerEffects, false);
    assert.equal(p.settings.layerEffectsText, 'Show layer effects from the scene (rounded corners, shadows, video buttons)');
    assert.equal(p.settings.motionChoices, 3, 'Follow Windows / Always on / Off');
    assert.equal(p.settings.motion, 'system');
    assert.equal(p.flagsInSettings, true, 'the feature flags list sits in Settings > Advanced');
    // N2: one row per flag with a switch and its plain description from data/flags.json, always shown.
    const rows = p.settings.flagRows;
    assert.equal(rows.length, p.flags.length, 'a row for every flag the server lists');
    for (const r of rows) {
      assert.equal(r.on, p.flags.find((f) => f.id === r.id).on, r.id);
      assert.ok(r.description.length > 10, `${r.id}: its description is shown`);
      assert.equal(r.visible, true, r.id);
    }
    assert.equal(p.settings.dirty, false, 'nothing changed yet');
  });
  test('Settings > Advanced (2026-11-10 offset bug): with the window shown, the flag rows have no native handle and sit inside their box, also on a second open', async () => {
    const p = await probe([], 8000, 'settings-open,settings-section:Advanced,settings-cancel,settings-open,settings-section:Advanced', null, { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    const f = p.settings.flagList;
    assert.ok(f, 'the Advanced page reports the flag rows');
    assert.equal(f.native, false, 'a native handle made the list a separate child window placed off its box');
    assert.equal(f.nativeAttr, false);
    assert.equal(f.insideBox, true);
    assert.ok(f.w > 300 && f.h >= 220, `laid out to the page: ${f.w}x${f.h}`);
    assert.deepEqual([f.scrollX, f.scrollY], [0, 0]);
  });
  test('Settings deleted without closing (no finished signal): the flags still refresh and the rows are built again', async () => {
    const p = await probe([], 9000, 'settings-open,settings-section:Advanced,settings-destroy,settings-open,settings-section:Advanced', null, { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.ok(p.flags.length > 0, 'the flag list is kept as data in the window, never as a widget in the dialog');
    assert.equal(p.settings.flagList?.insideBox, true);
  });
  test('the app quits cleanly (exit 0) while Settings > Advanced is open', async () => {
    const p = await probe([], 6000, 'settings-open,settings-section:Advanced', null, { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.equal(p.flagsInSettings, true, 'Settings was still open at quit');
  });
  test('Settings (D290, D332): layer effects on turns flag layer-effects on at Save, no phrase; animations Off is saved as ui.motion', async () => {
    const p = await probe([], 11000, 'settings-open,settings-layer-effects:on,settings-motion:off,settings-save');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['settings-open', true], ['settings-layer-effects:on', true], ['settings-motion:off', true], ['settings-save', true]]);
    assert.equal(p.store.isOn('layer-effects'), true, 'applied on Save through the flags route');
    assert.equal(JSON.parse(readFileSync(path.join(p.dataDir, 'settings.json'), 'utf8')).ui.motion, 'off');
    assert.equal(p.motionMode, 'off');
    assert.equal(p.motion, false, 'no animation while the choice is Off');
    assert.equal(p.flagsInSettings, false, 'the rows went with the closed Settings window');
  });
  test('Settings > Clips (CL1, D350): reel length rows show the defaults, Save sends the changed type, a shortest over the longest blocks Save', async () => {
    const p = await probe([], 9000, 'settings-open,settings-page:0,settings-reel:montage:10:30,settings-save');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['settings-open', true], ['settings-page:0', true], ['settings-reel:montage:10:30', true], ['settings-save', true]]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(p.dataDir, 'settings.json'), 'utf8')).clips.reelLengths, { montage: { minSec: 10, maxSec: 30 } });
    const q = await probe([], 8000, 'settings-open,settings-page:0');
    assert.deepEqual(Object.keys(q.settings.reelLengths.rows).sort(), ['impact-play', 'live-clip', 'match-reel', 'montage', 'short']);
    assert.deepEqual(q.settings.reelLengths.rows.montage, { min: 20, max: 60, maxLimit: 60 });
    assert.equal(q.settings.reelLengths.error, '');
    const r = await probe([], 9000, 'settings-open,settings-page:0,settings-reel:montage:50:40,settings-save');
    assert.match(r.settings.reelLengths.error, /montage: the shortest \(50 s\) is longer than the longest \(40 s\)/);
    assert.equal(r.settings.dirty, true, 'Settings stayed open with the edit');
    assert.equal(existsSync(path.join(r.dataDir, 'settings.json')), false, 'nothing saved');
  });
  test('Settings > Clips (ED1, D352): reel opening rows show on and 2 s per type, Save sends only the changed type', async () => {
    const q = await probe([], 8000, 'settings-open,settings-page:0');
    assert.deepEqual(Object.keys(q.settings.reelHooks).sort(), ['impact-play', 'live-clip', 'match-reel', 'montage']);
    assert.deepEqual(q.settings.reelHooks.montage, { on: true, teaserSec: 2, teaserEnabled: true, min: 1, max: 3 });
    const p = await probe([], 9000, 'settings-open,settings-page:0,settings-hook:match-reel:0:3,settings-save');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['settings-open', true], ['settings-page:0', true], ['settings-hook:match-reel:0:3', true], ['settings-save', true]]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(p.dataDir, 'settings.json'), 'utf8')).clips.reelHooks, { 'match-reel': { on: false, teaserSec: 3 } });
  });
  test('Settings > Clips (RP1): Transition between pieces shows Cross fade 250 ms (150-500); Save sends the choice; Cut saves no length', async () => {
    const q = await probe([], 8000, 'settings-open,settings-page:0');
    assert.deepEqual(q.settings.reelTransition, { kind: 'fade', label: 'Cross fade', ms: 250, msEnabled: true, min: 150, max: 500 });
    const p = await probe([], 9000, 'settings-open,settings-page:0,settings-transition:fade:400,settings-save');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['settings-open', true], ['settings-page:0', true], ['settings-transition:fade:400', true], ['settings-save', true]]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(p.dataDir, 'settings.json'), 'utf8')).clips.reelTransition, { kind: 'fade', ms: 400 });
    const c = await probe([], 9000, 'settings-open,settings-page:0,settings-transition:cut:0,settings-save');
    assert.deepEqual(JSON.parse(readFileSync(path.join(c.dataDir, 'settings.json'), 'utf8')).clips.reelTransition, { kind: 'cut', ms: 0 });
  });
  test('Settings > Clips (LC2, D334 proposed): Record while live is a switch row with its explanation, on by default; off is saved at Save', async () => {
    const p = await probe([], 7000, 'settings-open,settings-page:0');
    assert.deepEqual(p.settings.recordLive, { on: true, text: 'Record while live', visible: true,
      hint: 'Records the stream (H and V) to your recordings folder so reels can be made after it ends. Uses about 10 GB per hour.' });
    assert.equal(p.settings.dirty, false);
    const draft = await probe([], 7000, 'settings-open,settings-record-live:off');
    assert.deepEqual([draft.settings.recordLive.on, draft.settings.dirty], [false, true], 'a draft until Save (D332)');
    const saved = await probe([], 9000, 'settings-open,settings-record-live:off,settings-save');
    assert.ok(saved.actions.every((x) => x.done), JSON.stringify(saved.actions));
    assert.equal(JSON.parse(readFileSync(path.join(saved.dataDir, 'settings.json'), 'utf8')).clips.recordLive, false);
  });
  test('Settings > Advanced (N2, D332): a flag switch is a draft; Save applies it, on and off alike', async () => {
    const draft = await probe(['scene-edit'], 7000, 'settings-open,settings-flag:transitions:on,settings-flag:scene-edit:off');
    assert.ok(draft.actions.every((a) => a.done), JSON.stringify(draft.actions));
    assert.deepEqual(draft.settings.flagRows.filter((r) => ['transitions', 'scene-edit'].includes(r.id)).map((r) => [r.id, r.on]).sort(), [['scene-edit', false], ['transitions', true]]);
    assert.equal(draft.settings.dirty, true);
    assert.equal(draft.store.isOn('transitions'), false, 'not applied before Save');
    assert.equal(draft.store.isOn('scene-edit'), true, 'off is not applied before Save either');
    const saved = await probe(['scene-edit'], 8000, 'settings-open,settings-flag:transitions:on,settings-flag:scene-edit:off,settings-save');
    assert.ok(saved.actions.every((a) => a.done), JSON.stringify(saved.actions));
    assert.equal(saved.store.isOn('transitions'), true, 'on at Save, no phrase');
    assert.equal(saved.store.isOn('scene-edit'), false, 'off at Save');
    assert.equal(saved.shown.transitions, true);
  });
  test('Settings > Advanced (N2): the layer-effects row and the Layer effects switch are one setting', async () => {
    const p = await probe([], 7000, 'settings-open,settings-flag:layer-effects:on');
    assert.equal(p.settings.layerEffects, true, 'the Layer effects page follows the row');
    const q = await probe([], 7000, 'settings-open,settings-layer-effects:on');
    assert.equal(q.settings.flagRows.find((r) => r.id === 'layer-effects').on, true, 'the row follows the Layer effects page');
  });
  test('Settings > Preview (D335 F10): the snap switch is off by default with its words beside it; Save writes ui.snap', async () => {
    const p = await probe([], 7000, 'settings-open,settings-section:Preview');
    assert.equal(p.settings.snap, false, 'off unless the user turns it on');
    assert.equal(p.settings.snapText, 'Snap to preview edges and other layers');
    assert.equal(p.settings.dirty, false);
    const d = await probe([], 7000, 'settings-open,settings-snap:on');
    assert.deepEqual([d.settings.snap, d.settings.dirty], [true, true], 'a draft until Save');
    assert.equal(existsSync(path.join(d.dataDir, 'settings.json')), false, 'nothing written before Save');
    const s = await probe([], 9000, 'settings-open,settings-snap:on,settings-save');
    assert.ok(s.actions.every((a) => a.done), JSON.stringify(s.actions));
    assert.equal(JSON.parse(readFileSync(path.join(s.dataDir, 'settings.json'), 'utf8')).ui.snap, true);
    const back = await probe([], 9000, 'settings-open,settings-snap:off,settings-save', (dir) => writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ui: { snap: true } })));
    assert.equal(JSON.parse(readFileSync(path.join(back.dataDir, 'settings.json'), 'utf8')).ui.snap, false, 'and off again');
  });
  test('preview selection (D335 F8): the layer picked in the list is sent to the host preview (preview.select)', async () => {
    const p = await probe([], 7000, 'select-layer:cam', null, {}, { hostStatus: () => ({ previewEditing: true, previewSelection: { seq: 0, H: null, V: null } }) });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    const sel = p.calls.filter(([m]) => m === 'preview.select').map(([, x]) => x);
    assert.deepEqual(sel.at(-1), { canvas: 'h', layer: 'cam' }, JSON.stringify(sel));
    assert.equal(sel.filter((x) => x.layer === 'cam').length, 1, 'sent once, not on every status poll');
    // a hidden layer (chat) is not one the mouse can edit: the preview selects none
    const h = await probe([], 7000, 'select-layer:chat', null, {}, { hostStatus: () => ({ previewEditing: true, previewSelection: { seq: 0, H: null, V: null } }) });
    assert.deepEqual(h.calls.filter(([m]) => m === 'preview.select').map(([, x]) => x).at(-1), { canvas: 'h' });
    // flag off on the host (previewEditing false): nothing is sent
    const off = await probe([], 6000, 'select-layer:cam');
    assert.equal(off.calls.filter(([m]) => m === 'preview.select').length, 0);
  });
  // host.status previewSelection as the host sends it (seq per canvas, dragging per canvas)
  const sel = (sh, sv, H, V, drag = {}) => ({ seq: sh + sv, seqs: { H: sh, V: sv }, dragging: { H: !!drag.H, V: !!drag.V }, H, V });
  const selects = (calls, layer) => calls.filter(([m, x]) => m === 'preview.select' && x.layer === layer);
  test('preview selection (D335 F8): a click on the preview that picks another layer selects it in the list, without an echo', async () => {
    let n = 0;
    const p = await probe([], 7000, '', null, {}, { hostStatus: () => {
      n++;
      return { previewEditing: true, previewSelection: n < 6 ? sel(0, 0, null, null) : sel(1, 0, { scene: 'scene-1', layer: 'game' }, null) };
    } });
    assert.ok(n >= 6, `enough status polls: ${n}`);
    assert.equal(p.selectedLayer, 'game', 'the list follows the preview');
    assert.equal(p.calls.filter(([m, x]) => m === 'preview.select' && x.layer === 'game').length, 0, 'not sent back to the host');
  });
  test('preview selection (Codex review of 23e5289): a click on the V preview does not change the H list', async () => {
    // cam picked in the H list; the host's H selection stays null (as for a layer the host could not select); then a
    // click on V moves only V's seq: the H list keeps cam.
    let sentAt = 0, shellPollsAfterV = 0;
    const vClicked = () => sentAt > 0 && Date.now() - sentAt > 1500; // the V click comes 1.5 s after the list pick
    const p = await probe([], 9000, 'select-layer:cam', null, {}, {
      hostCall: (m, x) => { if (m === 'preview.select' && x.layer === 'cam') sentAt = Date.now(); return undefined; },
      hostStatus: () => ({ previewEditing: true, previewSelection: vClicked() ? sel(0, 1, null, { scene: 'scene-1', layer: 'game' }) : sel(0, 0, null, null) }),
      onStatus: () => { if (vClicked()) shellPollsAfterV++; },
    });
    assert.ok(shellPollsAfterV >= 2, `the shell read the status after the V click (${shellPollsAfterV})`);
    assert.equal(p.selectedLayer, 'cam', 'the H list keeps its selection');
  });
  test('preview selection (Codex review of 23e5289): a selection refused mid-drag is sent again once the drag ends', async () => {
    const DRAG_MS = 2500;
    const at = []; // times of the preview.select calls for cam
    let dragSeen = false;
    const p = await probe([], 10000, 'select-layer:cam', null, {}, {
      hostStatus: () => {
        const dragging = at.length === 1 && Date.now() - at[0] < DRAG_MS; // the press is held for 2.5 s after the refusal
        if (dragging) dragSeen = true;
        return { previewEditing: true, previewSelection: sel(0, 0, { scene: 'scene-1', layer: 'game' }, null, { H: dragging }) };
      },
      hostCall: (m, x) => {
        if (m !== 'preview.select' || x.layer !== 'cam') return undefined;
        at.push(Date.now());
        if (at.length === 1) throw Object.assign(new Error('a drag is running on that preview'), { code: -32009 });
        return { layer: 'cam' };
      },
    });
    assert.equal(at.length, 2, 'refused once, sent again once');
    assert.ok(dragSeen, 'the drag was in the status');
    assert.ok(at[1] - at[0] >= DRAG_MS, `the retry waited for the drag to end (${at[1] - at[0]} ms)`);
    assert.equal(p.selectedLayer, 'cam', 'the list keeps the selection the preview now has');
  });
  test('preview selection (Codex review of 23e5289): a refused retry puts the list back to the host\'s selection', async () => {
    const p = await probe([], 9000, 'select-layer:cam', null, {}, {
      hostStatus: () => ({ previewEditing: true, previewSelection: sel(0, 0, { scene: 'scene-1', layer: 'game' }, null) }),
      hostCall: (m, x) => { if (m === 'preview.select' && x.layer === 'cam') throw Object.assign(new Error('busy: try again'), { code: -32009 }); return undefined; },
    });
    assert.equal(selects(p.calls, 'cam').length, 2, 'one retry, no more');
    assert.equal(p.selectedLayer, 'game', 'the list shows the layer the preview edits');
    assert.equal(selects(p.calls, 'game').length, 0, 'the restored selection is not sent back');
  });
  test('Settings (D332): closing with unsaved edits asks Save changes / Discard / Cancel', async () => {
    const ask = await probe([], 7000, 'settings-open,settings-flag:transitions:on,settings-cancel');
    assert.equal(ask.settings?.unsavedAsked, true, 'the question is open and Settings stays open');
    assert.equal(ask.store.isOn('transitions'), false);
    const keep = await probe([], 8000, 'settings-open,settings-flag:transitions:on,settings-cancel,settings-unsaved:cancel');
    assert.ok(keep.actions.every((a) => a.done), JSON.stringify(keep.actions));
    assert.deepEqual([keep.settings?.unsavedAsked, keep.settings?.dirty], [false, true], 'Cancel: back to Settings with the edits');
    const discard = await probe([], 8000, 'settings-open,settings-flag:transitions:on,settings-motion:off,settings-cancel,settings-unsaved:discard');
    assert.ok(discard.actions.every((a) => a.done), JSON.stringify(discard.actions));
    assert.equal(discard.settings, undefined, 'Settings closed');
    assert.equal(discard.store.isOn('transitions'), false, 'Discard: nothing applied');
    assert.equal(existsSync(path.join(discard.dataDir, 'settings.json')), false, 'Discard: nothing saved');
    const save = await probe([], 9000, 'settings-open,settings-flag:transitions:on,settings-motion:off,settings-cancel,settings-unsaved:save');
    assert.ok(save.actions.every((a) => a.done), JSON.stringify(save.actions));
    assert.equal(save.settings, undefined, 'Settings closed');
    assert.equal(save.store.isOn('transitions'), true, 'Save changes: the flag applied');
    assert.equal(JSON.parse(readFileSync(path.join(save.dataDir, 'settings.json'), 'utf8')).ui.motion, 'off', 'Save changes: settings saved');
    const clean = await probe([], 6000, 'settings-open,settings-cancel');
    assert.equal(clean.settings, undefined, 'no edits: Cancel closes at once, no question');
  });
  test('motion setting (D290): settings.json ui.motion is read at start; UJWALAM_REDUCE_MOTION still overrides it', async () => {
    const prep = (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { motion: 'off' } }));
    const off = await probe([], 4000, '', prep);
    assert.deepEqual([off.motionMode, off.motion], ['off', false]);
    const env = await probe([], 4000, '', prep, { UJWALAM_REDUCE_MOTION: '0' });
    assert.deepEqual([env.motionMode, env.motion], ['off', true], 'the environment wins');
    const on = await probe([], 4000, '', (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { motion: 'on' } })), { UJWALAM_REDUCE_MOTION: '' });
    assert.deepEqual([on.motionMode, on.motion], ['on', true]);
  });
  // --- end Look panel, Settings, motion ---

  // --- layer and scene context menus (D292) ---
  const names = (p) => p.layerNames.map((n) => n.slice(3));
  test('layer menu (D292, D330): items, shortcuts and tips; Delete needs no flag; keys sit on the list', async () => {
    const p = await probe([], 5000, 'select-layer:game,layer-menu:show', null, {}, { project: true });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['select-layer:game', true], ['layer-menu:show', true]]);
    assert.equal(p.menu.kind, 'layer');
    assert.deepEqual(p.menu.items.map((i) => i.text), ['Add layer…', 'Duplicate', 'Rename…', 'Hide', 'Move up', 'Move down', 'Move to top', 'Move to bottom', 'Copy look', 'Paste look', 'Look…', 'Delete…']);
    const by = Object.fromEntries(p.menu.items.map((i) => [i.id, i]));
    assert.deepEqual([by.duplicate.keys, by.rename.keys, by.delete.keys, by.copylook.keys, by.pastelook.keys], ['Ctrl+D', 'F2', 'Del', 'Ctrl+Shift+C', 'Ctrl+Shift+V']);
    assert.equal(by.duplicate.enabled, true, 'duplicate needs no flag');
    assert.equal(by.rename.enabled, true);
    assert.deepEqual([by.delete.enabled, by.delete.tip], [true, ''], 'D330: delete needs no flag (it still asks first)');
    assert.deepEqual([by.pastelook.enabled, by.pastelook.tip], [false, 'Copy a look first']);
    assert.deepEqual([by.down.enabled, by.up.enabled, by.bottom.enabled, by.top.enabled], [false, true, false, true], 'game is the bottom layer');
    assert.deepEqual(p.listKeys.layers.sort(), ['Ctrl+D', 'Ctrl+Shift+C', 'Ctrl+Shift+V', 'Del', 'F2']);
    assert.deepEqual(p.listKeys.scenes.sort(), ['Del', 'F2']);
  });
  test('layer menu (D292): Duplicate with scene editing off puts the copy right above the source, saves the project and selects the copy', async () => {
    const p = await probe([], 6500, 'select-layer:game,layer-menu:duplicate', null, {}, { project: true });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['select-layer:game', true], ['layer-menu:duplicate', true]]);
    assert.deepEqual(names(p), ['Chat overlay', 'Camera', 'Game capture copy', 'Game capture'], 'top first: the copy sits directly above Game capture');
    assert.equal(p.selectedLayer, 'game-copy');
    assert.deepEqual(p.calls.map(([m]) => m).filter((m) => m.endsWith('FromProject')), ['layers.addFromProject', 'layers.orderFromProject']);
    const doc = JSON.parse(readFileSync(p.file, 'utf8'));
    assert.deepEqual(doc.scenes[0].layers.map((l) => l.id), ['game', 'game-copy', 'cam', 'chat']);
    assert.equal(validateProject(doc).ok, true);
    assert.match(p.note, /layer\.duplicate/, p.note);
  });
  test('layer menu (D292): Rename opens a name box; the new name shows in the list and is saved', async () => {
    const p = await probe([], 7000, 'select-layer:cam,layer-menu:rename,type:Facecam%20big', null, {}, { project: true });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['select-layer:cam', true], ['layer-menu:rename', true], ['type:Facecam%20big', true]]);
    assert.deepEqual(names(p), ['Chat overlay', 'Facecam big', 'Game capture']);
    assert.equal(JSON.parse(readFileSync(p.file, 'utf8')).scenes[0].layers[1].name, 'Facecam big');
  });
  test('layer menu (D292, D330): Move to top / bottom are saved into the project (layer.move to a target); Show/Hide uses the host call', async () => {
    const p = await probe([], 8000, 'select-layer:game,layer-menu:top,layer-menu:visible,select-layer:chat,layer-menu:bottom', null, {}, { project: true });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.equal(p.calls.filter(([m]) => m === 'layers.move').length, 0, 'project layers: no live-only move');
    assert.equal(p.calls.filter(([m]) => m === 'layers.orderFromProject').length, 2, 'the host takes the saved order each time');
    assert.deepEqual(JSON.parse(readFileSync(p.file, 'utf8')).scenes[0].layers.map((l) => l.id), ['chat', 'cam', 'game'], 'bottom first: game on top, chat at the bottom');
    assert.deepEqual(names(p), ['Game capture', 'Camera', 'Chat overlay']);
    assert.deepEqual(p.calls.filter(([m]) => m === 'layers.setVisible').map(([, x]) => [x.layer, x.visible]), [['game', false]]);
  });
  test('layer list (D330): press-and-drag a row reorders the layers and saves the order; a layer the project lacks moves live-only', async () => {
    // rows top first: Chat overlay (0), Camera (1), Game capture (2). Drag Game capture to the top; the rows are then
    // Game capture, Chat overlay, Camera, and Chat overlay (row 1) goes to the bottom.
    const p = await probe([], 8000, 'layer-drag:2:0,layer-drag:1:2', null, { UJWALAM_STUDIO_PROBE_SHOW: '1' }, { project: true });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['layer-drag:2:0', true], ['layer-drag:1:2', true]]);
    assert.deepEqual(JSON.parse(readFileSync(p.file, 'utf8')).scenes[0].layers.map((l) => l.id), ['chat', 'cam', 'game']);
    assert.deepEqual(names(p), ['Game capture', 'Camera', 'Chat overlay']);
    assert.equal(p.calls.filter(([m]) => m === 'layers.orderFromProject').length, 2);
    const q = await probe([], 6000, 'layer-drag:2:0', null, { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    assert.deepEqual(q.actions.map((a) => a.done), [true]);
    assert.equal(q.calls.filter(([m]) => m === 'layers.move').length, 1, 'no project file: the live-only host move, as before');
  });
  test('layer list (D330 review): a host-only fallback that answers late moves the dragged layer, not the one selected since', async () => {
    // The project lacks chat, so the structure route answers unknown-layer, 1.5 s late; Camera is selected meanwhile.
    const p = await probe([], 8000, 'layer-drag:0:2,select-layer:cam', null, { UJWALAM_STUDIO_PROBE_SHOW: '1' },
      { project: true, slowStatusMs: 1500, editProject: (doc) => { doc.scenes[0].layers = doc.scenes[0].layers.filter((l) => l.id !== 'chat'); } });
    assert.deepEqual(p.actions.map((a) => a.done), [true, true]);
    assert.equal(p.selectedLayer, 'cam');
    assert.deepEqual(p.calls.filter(([m]) => m === 'layers.move').map(([, x]) => [x.scene, x.layer, x.index]), [['scene-1', 'chat', 0]]);
  });
  test('layer list (D330, D332): the trash button deletes on the click, no question and no flag; the button has its icon', async () => {
    const p = await probe([], 8000, 'select-layer:chat,delete-button', null, { UJWALAM_STUDIO_PROBE_SHOW: '1' }, { project: true });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.deepEqual([p.addButtons.delete.enabled, p.addButtons.delete.icon], [true, true]);
    assert.deepEqual(names(p), ['Camera', 'Game capture']);
    assert.equal(p.calls.filter(([m]) => m === 'layers.remove').length, 1, 'one click, one delete');
    assert.deepEqual(JSON.parse(readFileSync(p.file, 'utf8')).scenes[0].layers.map((l) => l.id), ['game', 'cam']);
  });
  test('layer list (D330): while live the trash button is greyed and says why', async () => {
    const p = await probe([], 5000, 'select-layer:chat,delete-button', null, {}, { project: true, live: true });
    assert.deepEqual(p.actions.map((a) => a.done), [true, false]);
    assert.deepEqual([p.addButtons.delete.enabled, p.addButtons.delete.tip], [false, 'Not while live']);
    assert.equal(p.calls.filter(([m]) => m === 'layers.remove').length, 0);
  });
  test('shared slider (D330): a click jumps to the value, a typed value + Enter sets it, keys step; each reaches the host', async () => {
    // rounded radius: range from the effect table; a click at the middle, then typed 12, then Right (+1 step), then PageUp.
    const p = await probe([], 12000, 'select-layer:cam,look:rounded:on,look-slider:rounded:radius:click:0.9,look-slider:rounded:radius:type:12,look-slider:rounded:radius:key:right',
      null, { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    const radii = p.calls.filter(([m]) => m === 'layers.setEffects').map(([, x]) => x.effects.find((e) => e.type === 'rounded')?.radius);
    assert.ok(radii.some((r) => r > 12 + 1), `the click jumped far along the track: ${radii}`);
    assert.ok(radii.includes(12), `typed 12: ${radii}`);
    assert.equal(radii.at(-1), 13, `Right stepped one up from 12: ${radii}`);
  });
  test('shared slider (D330): volume click sends mixer.setVolume once on release; the wheel does nothing without focus and steps with it', async () => {
    const p = await probe([], 9000, 'volume-slider:scene-1/cam:wheel-nofocus:3,volume-slider:scene-1/cam:click:0.25,volume-slider:scene-1/cam:type:-6,volume-slider:scene-1/cam:wheel:-2',
      null, { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    const sent = p.calls.filter(([m, x]) => m === 'mixer.setVolume' && x.id === 'scene-1/cam').map(([, x]) => x.db);
    assert.equal(sent[0], -45, `the click at a quarter of -60..0 dB: ${sent}`);
    assert.ok(sent.includes(-6), `typed -6: ${sent}`);
    // one notch = one step (1 dB), not Windows' 3 lines per notch (D330 review)
    assert.equal(sent.at(-1), -8, `two wheel notches down from -6 with focus: ${sent}`);
    assert.equal(sent.length, 3, `the unfocused wheel sent nothing: ${sent}`);
    assert.equal(p.volumes['scene-1/cam'], -8);
  });
  test('shared slider (D330 review): press, hold and drag commits once on release; held box steps commit once after the pause', async () => {
    const p = await probe([], 9000, 'volume-slider:scene-1/cam:hold-drag:0.25~0.75,volume-slider:scene-1/cam:box-up:3', null, { UJWALAM_STUDIO_PROBE_SHOW: '1' });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    const sent = p.calls.filter(([m, x]) => m === 'mixer.setVolume' && x.id === 'scene-1/cam').map(([, x]) => x.db);
    assert.deepEqual(sent, [-15, -12], `only the released value (-15), then one send for three box steps (-12): ${sent}`);
  });
  test('layer menu (D292): Copy look then Paste look sets the same effects on another layer through layers.setEffects', async () => {
    const p = await probe([], 11000, 'select-layer:cam,look:rounded:on,look-set:rounded:radius:40,layer-menu:copylook,select-layer:game,layer-menu:pastelook', null, {}, { project: true });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.deepEqual(p.lookClip, [{ type: 'rounded', radius: 40 }]);
    const list = (await p.fake.call('layers.list', { scene: 'scene-1' })).layers;
    assert.deepEqual(list.find((l) => l.id === 'game').effects, [{ type: 'rounded', radius: 40 }]);
    assert.deepEqual(list.find((l) => l.id === 'cam').effects, [{ type: 'rounded', radius: 40 }]);
  });
  test('layer menu (D292, D332): Delete removes the layer from the host and the project on the click (scene editing on)', async () => {
    const p = await probe(['scene-edit'], 8000, 'select-layer:chat,layer-menu:delete', null, {}, { project: true });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.deepEqual(names(p), ['Camera', 'Game capture']);
    assert.equal(p.calls.filter(([m]) => m === 'layers.remove').length, 1, 'one click, one delete');
    assert.deepEqual(JSON.parse(readFileSync(p.file, 'utf8')).scenes[0].layers.map((l) => l.id), ['game', 'cam']);
  });
  test('layer menu (D330): Delete works with scene editing off', async () => {
    const p = await probe([], 6000, 'select-layer:chat,layer-menu:delete', null, {}, { project: true });
    assert.deepEqual(p.actions.map((a) => a.done), [true, true]);
    assert.equal(p.layers, 2);
    assert.deepEqual(JSON.parse(readFileSync(p.file, 'utf8')).scenes[0].layers.map((l) => l.id), ['game', 'cam']);
  });
  test('scene menu (D292): Duplicate scene copies it with its layers; Rename changes the name; both without the flag', async () => {
    const p = await probe([], 8000, 'select-scene:scene-2,scene-menu:duplicate,select-scene:scene-2,scene-menu:rename,type:Intro', null, {}, { project: true });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.equal(p.sceneNames.length, 4);
    assert.ok(p.sceneNames.some((n) => n.startsWith('Intro')), JSON.stringify(p.sceneNames));
    assert.ok(p.sceneNames.some((n) => n.startsWith('Starting soon copy')), JSON.stringify(p.sceneNames));
    const doc = JSON.parse(readFileSync(p.file, 'utf8'));
    assert.deepEqual(doc.scenes.map((s) => s.id), ['scene-1', 'scene-2', 'scene-2-copy']);
    assert.equal(doc.scenes[2].layers.length, 1);
    assert.equal((await p.fake.call('layers.list', { scene: 'scene-2-copy' })).layers.length, 1, 'the layers reached the host');
  });
  test('scene menu (D292): Delete is greyed for the active scene and without the flag; with the flag the click removes another scene', async () => {
    const off = await probe([], 5000, 'select-scene:scene-2,scene-menu:show', null, {}, { project: true });
    assert.deepEqual(off.menu.items.map((i) => [i.text, i.enabled]), [['Add scene…', true], ['Add layer…', true], ['Rename…', true], ['Duplicate scene', true], ['Delete…', false]]);
    assert.equal(off.menu.items[4].tip, 'Turn on scene editing in Settings > Advanced');
    const on = await probe(['scene-edit'], 8000, 'select-scene:scene-1,scene-menu:delete,select-scene:scene-2,scene-menu:delete', null, {}, { project: true });
    assert.deepEqual(on.actions.map((a) => a.done), [true, false, true, true], 'the active scene cannot be deleted');
    assert.equal(on.sceneNames.length, 2);
    assert.deepEqual(JSON.parse(readFileSync(on.file, 'utf8')).scenes.map((s) => s.id), ['scene-1']);
  });
  // --- end context menus ---

  // --- Add layer / Add scene (D292) ---
  test('add buttons (D292): a + above the scene list and the layer list opens the add windows; no flag needed', async () => {
    const p = await probe([], 6500, 'add-button:layer', null, {}, { project: true });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['add-button:layer', true]]);
    assert.deepEqual(p.addButtons, { scene: { enabled: true, tip: 'Add scene', icon: true }, layer: { enabled: true, tip: 'Add layer', icon: true },
      delete: { enabled: true, tip: 'Delete the selected layer (Del). Asks first.', icon: true } }); // the trash beside + (D330)
    assert.equal(p.addDialog.kind, 'layer');
    assert.match(p.addDialog.title, /^Add layer to "Gameplay"$/);
    const by = Object.fromEntries(p.addDialog.kinds.map((k) => [k.kind, k]));
    assert.deepEqual(Object.keys(by), ['copy', 'color', 'text', 'capture', 'overlay', 'image', 'media']);
    assert.deepEqual(['copy', 'color', 'text', 'capture'].map((k) => by[k].enabled), [true, true, true, true]);
    assert.deepEqual(['overlay', 'image', 'media'].map((k) => by[k].enabled), [false, false, false], 'kinds the project cannot supply are greyed');
    assert.match(by.overlay.about, /Nothing to pick/);
    assert.equal(p.addDialog.current, 'copy');
  });
  test('Add layer (D292): a text layer and a camera layer are added with scene editing off; saved, sent to the host, and selected', async () => {
    const p = await probe([], 11000, 'add-layer:open,add-layer:kind:text,add-layer:text:Be%20right%20back,add-layer:send,add-layer:open,add-layer:kind:capture,add-layer:choice:0,add-layer:send', null, {}, { project: true });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.deepEqual(names(p), ['Face camera', 'Be right back', 'Chat overlay', 'Camera', 'Game capture']);
    assert.equal(p.addDialog, undefined, 'the window closed after Add');
    const doc = JSON.parse(readFileSync(p.file, 'utf8'));
    assert.deepEqual(doc.scenes[0].layers.slice(3).map((l) => [l.type, l.name]), [['text', 'Be right back'], ['capture', 'Face camera']]);
    assert.equal(validateProject(doc).ok, true);
    assert.equal(p.calls.filter(([m]) => m === 'layers.addFromProject').length, 2);
    assert.equal(p.layers, 5);
  });
  test('Add layer (D292): a colour needs #RRGGBB; a wrong entry keeps the window open with the reason', async () => {
    const p = await probe([], 8000, 'add-layer:open,add-layer:kind:color,add-layer:send,add-layer:text:red,add-layer:send', null, {}, { project: true });
    assert.deepEqual(p.actions.map((a) => a.done), [true, true, true, true, true]);
    assert.equal(p.layers, 3, 'nothing was added');
    assert.equal(p.addDialog?.kind, 'layer', 'the window is still open after "red" (the server refuses it)');
  });
  test('Add scene (D292): the + opens a name box that says which canvases it is made on; the scene appears, is saved and reaches the host', async () => {
    const p = await probe([], 8500, 'add-button:scene,add-scene:name:Brand%20new,add-scene:send', null, {}, { project: true });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.equal(p.sceneNames.length, 4);
    assert.ok(p.sceneNames.some((n) => n.startsWith('Brand new')), JSON.stringify(p.sceneNames));
    const doc = JSON.parse(readFileSync(p.file, 'utf8'));
    assert.deepEqual(doc.scenes.map((x) => x.name), ['Gameplay', 'Starting soon', 'Brand new']);
    assert.ok((await p.fake.call('scenes.list', {})).scenes.some((x) => x.name === 'Brand new'));
    const q = await probe([], 5500, 'add-scene:open', null, {}, { project: true });
    assert.deepEqual(q.addDialog, { kind: 'scene', where: 'The scene is made on every canvas of the project: H + V.', canAdd: false }, 'Add stays off until a name is typed');
  });
  test('context menus (D292): Add layer and Add scene are in the menus; right-click on empty space offers only the add items', async () => {
    const a = await probe([], 5000, 'select-layer:game,layer-menu:show', null, {}, { project: true });
    assert.equal(a.menu.items[0].id, 'add');
    assert.deepEqual([a.menu.items[0].text, a.menu.items[0].enabled], ['Add layer…', true]);
    const b = await probe([], 5000, 'select-scene:scene-2,scene-menu:show', null, {}, { project: true });
    assert.deepEqual(b.menu.items.map((i) => [i.id, i.text, i.enabled]), [['addscene', 'Add scene…', true], ['add', 'Add layer…', true], ['rename', 'Rename…', true], ['duplicate', 'Duplicate scene', true], ['delete', 'Delete…', false]]);
    const c = await probe([], 6500, 'select-scene:scene-2,scene-menu:add,add-layer:kind:text,add-layer:text:Hi,add-layer:send', null, {}, { project: true });
    assert.ok(c.actions.every((x) => x.done), JSON.stringify(c.actions));
    const doc = JSON.parse(readFileSync(c.file, 'utf8'));
    assert.equal(doc.scenes[1].layers.length, 2, 'the scene menu added to the scene it was opened on (Starting soon), not the active one');
    assert.equal(doc.scenes[0].layers.length, 3);
  });
  test('while live (D292): the + buttons and every structure menu item are greyed with "Not while live"; Show/Hide and Move stay on', async () => {
    const p = await probe([], 6500, 'select-layer:game,layer-menu:show,add-button:layer,layer-menu:duplicate', null, {}, { project: true, live: true });
    assert.equal(p.live, true);
    assert.deepEqual(p.addButtons, { scene: { enabled: false, tip: 'Not while live', icon: true }, layer: { enabled: false, tip: 'Not while live', icon: true },
      delete: { enabled: false, tip: 'Not while live', icon: true } });
    const by = Object.fromEntries(p.menu.items.map((i) => [i.id, i]));
    for (const id of ['add', 'duplicate', 'rename', 'delete']) assert.deepEqual([id, by[id].enabled, by[id].tip], [id, false, 'Not while live']);
    for (const id of ['visible', 'up', 'copylook', 'look']) assert.equal(by[id].enabled, true, id);
    assert.deepEqual(p.actions.map((a) => a.done), [true, true, false, false], 'a greyed button or item does nothing');
    assert.equal(p.layers, 3);
    const q = await probe([], 5000, 'select-scene:scene-2,scene-menu:show', null, {}, { project: true, live: true });
    assert.deepEqual(q.menu.items.map((i) => [i.id, i.enabled]), [['addscene', false], ['add', false], ['rename', false], ['duplicate', false], ['delete', false]]);
  });
  // --- end add ---

  // --- tips, tour and help (D294 proposed) ---
  const settingsOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const guideFile = (dir) => { try { return settingsOf(dir).ui?.guide; } catch { return undefined; } };
  const prepGuide = (guide) => (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { guide } }));
  const done = (p) => p.actions.map((a) => [a.action, a.done]);

  test('guide: text and choices load; the window registers its anchors; nothing starts by itself on a window that is not shown', async () => {
    const p = await probe([]);
    assert.equal(p.guide.ready, true);
    assert.deepEqual(p.guide.tours, ['welcome', 'clips', 'posting']);
    assert.equal(p.guide.hintDefs, 6);
    assert.deepEqual([p.guide.tips, p.guide.tourDone, p.guide.dismissed], [true, false, []]);
    assert.equal(p.guide.coach.active, false);
    assert.equal(p.guide.help.open, false);
    for (const a of ['scenes', 'layers', 'previewH', 'previewV', 'mixer', 'ctlStream', 'ctlRecord', 'ctlClip', 'ctlMark', 'chips', 'chipClips', 'taskChip', 'myClips', 'settings', 'more', 'help', 'layerAdd', 'sceneAdd']) assert.ok(p.guide.anchors.includes(a), a);
  });
  test('guide: the welcome tour starts, steps forward and back, and skips a step whose anchor is missing', async () => {
    const p = await probe([], 7000, 'guide-tour:start,guide-tour:next,guide-tour:next,guide-tour:back');
    assert.deepEqual(done(p), [['guide-tour:start', true], ['guide-tour:next', true], ['guide-tour:next', true], ['guide-tour:back', true]]);
    const c = p.guide.coach;
    assert.equal(c.active, true);
    assert.equal(c.tour, 'welcome');
    assert.equal(c.step, 2, 'forward twice, back once');
    assert.ok(c.of >= 12 && c.of <= 16, `steps shown: ${c.of} (16, or fewer if a part is hidden)`);
    assert.equal(c.count, `STEP 2 OF ${c.of}`);
    assert.equal(c.stepId, 'layers');
    assert.equal(c.neverOffered, true);
    assert.ok(c.hole.w > 5 && c.hole.h > 5, 'a spotlight on the step widget');
  });
  test('guide: the whole welcome tour, to Done, marks it done in settings.json', async () => {
    const acts = ['guide-tour:start', ...Array(17).fill('guide-tour:next')].join(',');
    const p = await probe([], 15500, acts);
    assert.equal(p.actions[0].done, true);
    assert.equal(p.guide.coach.active, false, 'the last Done closes it');
    assert.deepEqual(p.guide.coach.overlaps, [], 'on no step does the card cover the control it points at');
    assert.equal(guideFile(p.dataDir).tourDone, true);
    assert.equal(p.guide.tourDone, true);
  });
  test('guide: Skip with the box ticked is remembered; Skip without it is not', async () => {
    const a = await probe([], 6500, 'guide-tour:start,guide-tour:tick,guide-tour:skip');
    assert.deepEqual(done(a), [['guide-tour:start', true], ['guide-tour:tick', true], ['guide-tour:skip', true]]);
    assert.equal(a.guide.coach.active, false);
    assert.equal(guideFile(a.dataDir).tourDone, true);
    const b = await probe([], 5500, 'guide-tour:start,guide-tour:close');
    assert.equal(b.guide.coach.active, false);
    assert.equal(b.guide.tourDone, false);
    assert.equal(guideFile(b.dataDir), undefined, 'nothing written: it comes back next time');
  });
  test('guide: a focused tour (clips) runs on the related controls and does not touch the welcome choice', async () => {
    const p = await probe([], 8500, 'guide-tour:start:clips,guide-tour:next,guide-tour:next,guide-tour:next,guide-tour:next,guide-tour:next');
    const c = p.guide.coach;
    assert.deepEqual([c.tour, c.of, c.step, c.next, c.neverOffered], ['clips', 6, 6, 'Done', false]);
    assert.equal(c.anchor, 'settings');
    assert.deepEqual(c.overlaps, [], 'the card never covers its target');
    assert.equal(p.guide.tourDone, false);
  });
  test('guide: the help panel opens with its two sections; Show me runs the related tour; Replay runs the welcome tour', async () => {
    const o = await probe(['posting'], 6500, 'guide-help:open');
    assert.deepEqual(done(o), [['guide-help:open', true]]);
    assert.equal(o.guide.help.open, true);
    assert.deepEqual(o.guide.help.sections, ['How clips are made', 'Posting your clips']);
    assert.match(o.guide.help.facts, /posting is ON, automatic posting is OFF/);
    const s = await probe([], 7000, 'guide-help:open,guide-help:show-posting');
    assert.equal(s.guide.help.open, false, 'the panel closes to show the controls');
    assert.deepEqual([s.guide.coach.active, s.guide.coach.tour], [true, 'posting']);
    assert.match(s.guide.help.facts, /posting is OFF, automatic posting is OFF/);
    const r = await probe([], 7000, 'guide-help:open,guide-help:replay');
    assert.deepEqual([r.guide.coach.active, r.guide.coach.tour, r.guide.help.open], [true, 'welcome', false]);
  });
  test('guide: a hint shows once its thing happens; the box saves "do not show again" and it stays away, also in the next run', async () => {
    const p = await probe([], 8000, 'guide-hint:went-live,guide-hint:tick-gotit,guide-hint:went-live');
    assert.deepEqual(done(p), [['guide-hint:went-live', true], ['guide-hint:tick-gotit', true], ['guide-hint:went-live', false]]);
    assert.equal(p.guide.hint.showing, false);
    assert.deepEqual(guideFile(p.dataDir).dismissed, ['went-live']);
    const again = await probe([], 5000, 'guide-hint:went-live', prepGuide({ dismissed: ['went-live'] }));
    assert.deepEqual(done(again), [['guide-hint:went-live', false]], 'dismissed for good');
    assert.equal(again.guide.hint.seen, 0);
  });
  test('guide: a hint closed without the box is not saved; only one hint at a time; none while a tour runs', async () => {
    const p = await probe([], 8500, 'guide-hint:went-live,guide-hint:clip-run-started,guide-hint:close,guide-tour:start,guide-hint:clip-run-started');
    assert.deepEqual(done(p), [['guide-hint:went-live', true], ['guide-hint:clip-run-started', false], ['guide-hint:close', true], ['guide-tour:start', true], ['guide-hint:clip-run-started', false]]);
    assert.equal(guideFile(p.dataDir)?.dismissed?.length ?? 0, 0);
  });
  test('guide: a hint hides itself after its time (UJWALAM_GUIDE_HINT_MS stands in for 8 s) and is not saved', async () => {
    const p = await probe([], 6500, 'guide-hint:went-live', null, { UJWALAM_GUIDE_HINT_MS: '400' });
    assert.equal(p.actions[0].done, true);
    assert.equal(p.guide.hint.seen, 1);
    assert.equal(p.guide.hint.showing, false, 'gone by itself');
    assert.equal(guideFile(p.dataDir), undefined);
  });
  test('guide: tips off in Settings stops hints and is saved; Reset clears the dismissed list and the tour choice', async () => {
    const off = await probe([], 8500, 'settings-open,guide-settings:tips-off,guide-hint:went-live');
    assert.deepEqual(done(off), [['settings-open', true], ['guide-settings:tips-off', true], ['guide-hint:went-live', false]]);
    assert.equal(guideFile(off.dataDir).tips, false);
    assert.equal(off.guide.tips, false);
    const reset = await probe([], 8500, 'settings-open,guide-settings:reset,guide-hint:went-live', prepGuide({ dismissed: ['went-live', 'first-task'], tourDone: true, tips: true }));
    assert.deepEqual(done(reset), [['settings-open', true], ['guide-settings:reset', true], ['guide-hint:went-live', true]]);
    assert.deepEqual(guideFile(reset.dataDir), { tips: true, dismissed: [], tourDone: false });
    assert.equal(reset.guide.hint.id, 'went-live', 'shows again after the reset');
  });
  test('guide: Settings > Help & tips: Replay closes Settings and starts the tour', async () => {
    const p = await probe([], 8000, 'settings-open,guide-settings:replay', prepGuide({ tourDone: true }));
    assert.equal(p.guide.coach.tour, 'welcome');
    assert.equal(p.guide.coach.active, true);
  });
  // --- end tips, tour and help ---
  test('no typed confirms (D332): a flag switched on is on at once; no text window opens; an unknown flag is refused', async () => {
    const p = await probe([], 8000, 'flag-on:transitions,type:yes,flag-on:no-such-flag');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['flag-on:transitions', true], ['type:yes', false], ['flag-on:no-such-flag', false]]);
    assert.equal(p.store.isOn('transitions'), true, 'on at once through /ui/api/flags/set');
    assert.equal(p.shown.transitions, true, 'the transitions box follows the flag');
    assert.equal(p.confirmBox, undefined, 'no confirm window');
  });
});
