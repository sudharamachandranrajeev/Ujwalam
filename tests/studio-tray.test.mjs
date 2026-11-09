// SPDX-License-Identifier: GPL-3.0-or-later
// Visible tasks and the tray (user 2026-11-09, D311 proposed): nothing runs on unseen after the window closes.
// The real Qt studio shell, headless (offscreen platform: nothing reaches the screen, nothing takes focus), against the
// real UI server with a fake host. Task files in <dataDir>/tasks/*.json stand in for a clip job or an upload.
//   - closing with a task running asks: keep in the tray / stop / do not close (each answered by a probe action);
//   - "stop" ends the window with exit 0 (the launcher then ends every task's whole process tree: tests/kill-tree);
//   - "tray" hides the window; the tray lists each task with its time, has Open and Stop all; a click opens the list;
//   - the tray ends the studio (exit 0) with an "all finished" notification when the last task finishes;
//   - with nothing running, closing asks nothing;
//   - the taskbar shows elapsed time and time left (an estimate once progress moves).
// No system tray on the offscreen platform: the icon itself is not shown here (UNVERIFIED on a real desktop).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { STOP_TASKS_FILE } from '../services/studio-ui/record-clips.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

const task = (dataDir, o) => writeTaskFile(dataDir, { kind: 'clips', startedAt: Date.now() - 5000, updatedAt: Date.now(), ...o });
const RUNNING = { id: 'clip-practice-h', title: 'Reviewing the moments in practice-h', state: 'running', stage: 'review', done: 1, total: 10 };

describe('Qt studio: close with tasks running, and the tray (D311 proposed)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // Runs the shell once. o.prepare(dataDir) writes task files first; o.onStatus(n, dataDir) runs on each status request;
  // o.onOut(out, dataDir) on each stdout chunk. Returns the exit code, output and both probe lines (null when absent).
  async function run({ ms = 7000, actions = '', show = true, prepare, onStatus, onOut, onRequest, authority, outputsReady = false, env = {} } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-tray-')); dirs.push(dataDir);
    if (prepare) prepare(dataDir);
    const fake = createFakeHost({ outputsReady });
    // ctl.statusFails: host.status throws from then on (the host cannot be read: fail closed)
    const ctl = { statusFails: false };
    const host = { describe: () => fake.describe(), call: (m, p) => (ctl.statusFails && m === 'host.status' ? Promise.reject(new Error('host gone')) : fake.call(m, p)) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags: createFlags({ dataDir }), bots: createFakeBots(), limits: { statusPollMs: 50 }, ...(authority ? { authority } : {}) });
    if (onRequest) srv.server.on('request', (req) => onRequest(req.url?.split('?')[0], dataDir));
    const { port } = await srv.listen();
    if (onStatus) {
      let n = 0;
      srv.server.on('request', (req) => { if (req.method === 'GET' && req.url?.split('?')[0] === '/ui/api/status') onStatus(++n, dataDir); });
    }
    try {
      return await new Promise((resolve) => {
        const child = spawn(SHELL_EXE, [], {
          windowsHide: true,
          env: {
            ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1',
            UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
            UJWALAM_STUDIO_PROBE_ACTIONS: actions, ...(show ? { UJWALAM_STUDIO_PROBE_SHOW: '1' } : {}), ...env,
          },
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; onOut?.(out, dataDir, fake, ctl); });
        child.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => child.kill(), ms + 20_000);
        child.on('close', (code) => {
          clearTimeout(t);
          const line = (re) => { const m = re.exec(out); return m ? JSON.parse(m[1]) : null; };
          resolve({ code, out, err, dataDir, probe: line(/^studio probe: (.+)$/m), trayProbe: line(/^studio tray probe: (.+)$/m) });
        });
      });
    } finally { srv.close(); }
  }

  test('close with a task running: the question names it with its time; "Do not close" keeps the window and the task', async () => {
    const r = await run({ actions: 'close,close-choice:cancel', prepare: (d) => task(d, RUNNING) });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.probe, `no probe line: ${r.out}`);
    assert.deepEqual(r.probe.actions.map((a) => [a.action, a.done]), [['close', true], ['close-choice:cancel', true]]);
    assert.equal(r.probe.tray.closeChoice, 'cancel');
    assert.match(r.probe.tray.closeAsked, /^1 task is still running:\n- Reviewing the moments in practice-h \(\d+:\d\d elapsed · /);
    assert.equal(r.probe.windowShown, true, 'the window stays');
    assert.equal(r.probe.tray.active, false, 'no tray');
  });

  test('close, "Stop them and close": the studio ends with exit 0 at once (the launcher then ends the task trees)', async () => {
    const r = await run({ ms: 15000, actions: 'close,close-choice:stop', prepare: (d) => task(d, RUNNING) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio close: stop tasks \(1\)$/m);
    assert.equal(r.probe, null, 'ended before the probe time: the close itself quit');
  });

  test('close, "Keep running in the tray": window hidden, tray lists the task with its time, Open and Stop all; a click opens the list', async () => {
    const r = await run({ actions: 'close,close-choice:tray,tray:click', prepare: (d) => task(d, RUNNING) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio tray: on \(1 task\(s\)\)$/m);
    const p = r.probe;
    assert.ok(p, `no probe line: ${r.out}`);
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['close', true], ['close-choice:tray', true], ['tray:click', true]]);
    assert.equal(p.windowShown, false, 'the window hid');
    assert.equal(p.tray.closeChoice, 'tray');
    assert.equal(p.tray.active, true);
    assert.equal(p.tray.running, 1);
    assert.match(p.tray.rows[0], /^Reviewing the moments in practice-h \(10%\) - \d+:\d\d elapsed · /);
    assert.match(p.tray.tooltip, /^Ujwalam: 1 task running\nReviewing the moments/);
    assert.deepEqual(p.tray.menu.slice(-2), ['Open Ujwalam', 'Stop all and quit']);
    assert.ok(p.tray.menu[0].startsWith('Reviewing the moments'), 'each task is a line of the menu');
    assert.equal(p.tray.listShows, 1, 'the list opened once: on the click, never by itself');
    assert.equal(p.tray.messages, 1, 'one notification: still working');
    assert.equal(p.tray.iconNull, false, 'an icon (the app icon, or a standard one)');
  });

  test('tray: the last task finishing ends the studio (exit 0) with an "all finished" notification', async () => {
    let finished = false;
    const r = await run({
      ms: 30000, actions: 'close,close-choice:tray', prepare: (d) => task(d, RUNNING),
      // finish the task once the tray is on (tied to the shell's own output, not a wall-clock guess)
      onOut: (out, d) => { if (!finished && /^studio tray: on/m.test(out)) { finished = true; task(d, { ...RUNNING, title: 'Clips ready from practice-h', state: 'done', done: 10 }); } },
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio tray: all tasks finished; exiting$/m);
    assert.equal(r.probe, null, 'ended by the tray, before the probe time');
    const t = r.trayProbe;
    assert.ok(t, r.out);
    assert.deepEqual([t.active, t.running, t.finishing, t.lastMessage, t.messages], [true, 0, true, 'all finished', 2]);
    assert.equal(t.tooltip, 'Ujwalam: all tasks finished');
  });

  // Codex review (2026-11-09): a stream started from the control page while the window is in the tray must never be
  // ended by a tray exit (exit 0 makes the launcher stop the host). Every tray exit asks the host fresh, fail closed.
  const once = (re, fn) => { let done = false; return (out, ...a) => { if (!done && re.test(out)) { done = true; fn(...a); } }; };
  test('tray: the last task finishing while a stream runs (started in tray mode) does not quit; the window comes back', async () => {
    const r = await run({
      ms: 12000, outputsReady: true, actions: 'close,close-choice:tray', prepare: (d) => task(d, RUNNING),
      onOut: once(/^studio tray: on/m, async (d, fake) => { await fake.call('stream.start', {}); task(d, { ...RUNNING, state: 'done', done: 10 }); }),
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio tray: all tasks finished; staying open \(live\)$/m);
    assert.doesNotMatch(r.out, /all tasks finished; exiting/);
    assert.ok(r.probe, 'still running at the probe time');
    assert.deepEqual([r.probe.tray.active, r.probe.tray.stay], [false, 'live'], 'out of the tray: the window is back');
  });
  test('tray: a host that cannot be read counts as live (fail closed): no quit', async () => {
    const r = await run({
      ms: 12000, actions: 'close,close-choice:tray', prepare: (d) => task(d, RUNNING),
      onOut: once(/^studio tray: on/m, (d, fake, ctl) => { ctl.statusFails = true; task(d, { ...RUNNING, state: 'done', done: 10 }); }),
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio tray: all tasks finished; staying open \(unreadable\)$/m);
    assert.ok(r.probe);
    assert.equal(r.probe.tray.stay, 'unreadable');
  });
  test('tray: Stop all while live stops the tasks only (a request to the launcher); the studio and host stay', async () => {
    const r = await run({
      ms: 9000, outputsReady: true, actions: 'close,close-choice:tray,tray:stop', prepare: (d) => task(d, RUNNING),
      onOut: once(/^studio tray: on/m, (d, fake) => { void fake.call('stream.start', {}); }),
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio tray: stop tasks only \(live\)$/m);
    assert.doesNotMatch(r.out, /^studio tray: stop all$/m);
    assert.ok(r.probe, 'the studio did not quit');
    const req = JSON.parse(readFileSync(path.join(r.dataDir, 'clips', STOP_TASKS_FILE), 'utf8'));
    assert.ok(Number.isFinite(req.atMs), 'the stop request for the launcher (record-clips reads it)');
    assert.equal(r.probe.tray.active, true, 'the tray stays until the stopped tasks show as ended');
  });
  test('tray: a task that starts during the "all finished" countdown cancels it; the tray stays', async () => {
    let doneAt = 0;
    const r = await run({
      ms: 14000, actions: 'close,close-choice:tray', prepare: (d) => task(d, RUNNING), env: { UJWALAM_TRAY_FINISH_MS: '6000' },
      onOut: once(/^studio tray: on/m, (d) => { task(d, { ...RUNNING, state: 'done', done: 10 }); doneAt = 1; }),
      // two status polls after the finish (the tray has seen "done" and is counting down): a new upload starts
      onStatus: (n, d) => { if (doneAt && ++doneAt === 3) task(d, { id: 'upload-x', kind: 'upload', title: 'Uploading a clip to YouTube (private)', state: 'running' }); },
    });
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /all tasks finished/);
    const t = r.probe.tray;
    assert.deepEqual([t.active, t.finishing, t.running, t.lastMessage], [true, false, 1, 'still working']);
    assert.ok(t.cancels >= 1, JSON.stringify(t));
  });

  test('tray: a task that starts while the quit request is on its way: no exit, and the closing lock is released', async () => {
    const seen = [];
    let restarted = false;
    const r = await run({
      ms: 14000, actions: 'close,close-choice:tray', prepare: (d) => task(d, RUNNING),
      onOut: once(/^studio tray: on/m, (d) => task(d, { ...RUNNING, state: 'done', done: 10 })),
      // the grant is slow (the go-live authority answers after 5 s); the task starts again as soon as the quit is asked
      authority: { begin: async () => 0, arm: async () => true, revoke: () => new Promise((res) => setTimeout(() => res(true), 5000)) },
      onRequest: (url, d) => {
        seen.push(url);
        if (url === '/ui/api/quit/begin' && !restarted) { restarted = true; task(d, { ...RUNNING, state: 'running', done: 2 }); }
      },
    });
    assert.equal(r.code, 0, r.err);
    assert.ok(restarted, 'the quit was asked');
    assert.match(r.out, /^studio tray: not quitting \(a task started or the window came back meanwhile\)$/m);
    assert.doesNotMatch(r.out, /all tasks finished; exiting/);
    assert.ok(seen.includes('/ui/api/quit/cancel'), 'the granted lock was released (going live is not blocked)');
    assert.ok(r.probe, 'still running');
    assert.deepEqual([r.probe.tray.active, r.probe.tray.running], [true, 1]);
  });

  test('tray: Stop all ends the studio with exit 0', async () => {
    const r = await run({ ms: 15000, actions: 'close,close-choice:tray,tray:stop', prepare: (d) => task(d, RUNNING) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio tray: on/m);
    assert.match(r.out, /^studio tray: stop all$/m);
    assert.equal(r.probe, null);
  });

  test('tray: Open Ujwalam leaves the tray and keeps running', async () => {
    const r = await run({ actions: 'close,close-choice:tray,tray:open', prepare: (d) => task(d, RUNNING) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^studio tray: off \(window open again\)$/m);
    assert.equal(r.probe.tray.active, false);
  });

  test('nothing running: closing asks nothing and ends the studio', async () => {
    const r = await run({ ms: 15000, actions: 'close', prepare: (d) => task(d, { id: 'clip-old', title: 'Clips ready from practice-1', state: 'done' }) });
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /studio close: stop tasks|studio tray: on/);
    assert.equal(r.probe, null, 'the close quit at once');
  });

  test('taskbar: elapsed time, then an estimate of the time left once progress moves', async () => {
    const r = await run({
      ms: 9000, prepare: (d) => task(d, { ...RUNNING, done: 1, total: 100 }),
      onStatus: (n, d) => task(d, { ...RUNNING, done: 1 + n, total: 100 }),
    });
    assert.equal(r.code, 0, r.err);
    const i = r.probe.tasks.titles.indexOf(RUNNING.title);
    assert.ok(i >= 0, JSON.stringify(r.probe.tasks.titles));
    assert.match(r.probe.tasks.times[i], /^\d+:\d\d elapsed · this step: (about \d+ min left|less than a minute left)$/);
    assert.equal(r.probe.tasks.startToasts, 0, 'already running when the window started: no start toast');
  });
});
