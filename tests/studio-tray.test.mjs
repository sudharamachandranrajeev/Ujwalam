// SPDX-License-Identifier: GPL-3.0-or-later
// Visible tasks and the tray (user 2026-11-09, D310 proposed): nothing runs on unseen after the window closes.
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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

const task = (dataDir, o) => writeTaskFile(dataDir, { kind: 'clips', startedAt: Date.now() - 5000, updatedAt: Date.now(), ...o });
const RUNNING = { id: 'clip-practice-h', title: 'Reviewing the moments in practice-h', state: 'running', stage: 'review', done: 1, total: 10 };

describe('Qt studio: close with tasks running, and the tray (D310 proposed)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // Runs the shell once. o.prepare(dataDir) writes task files first; o.onStatus(n, dataDir) runs on each status request;
  // o.onOut(out, dataDir) on each stdout chunk. Returns the exit code, output and both probe lines (null when absent).
  async function run({ ms = 7000, actions = '', show = true, prepare, onStatus, onOut } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-tray-')); dirs.push(dataDir);
    if (prepare) prepare(dataDir);
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags: createFlags({ dataDir }), bots: createFakeBots(), limits: { statusPollMs: 50 } });
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
            UJWALAM_STUDIO_PROBE_ACTIONS: actions, ...(show ? { UJWALAM_STUDIO_PROBE_SHOW: '1' } : {}),
          },
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; onOut?.(out, dataDir); });
        child.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => child.kill(), ms + 20_000);
        child.on('close', (code) => {
          clearTimeout(t);
          const line = (re) => { const m = re.exec(out); return m ? JSON.parse(m[1]) : null; };
          resolve({ code, out, err, probe: line(/^studio probe: (.+)$/m), trayProbe: line(/^studio tray probe: (.+)$/m) });
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
