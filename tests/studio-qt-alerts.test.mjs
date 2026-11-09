// SPDX-License-Identifier: GPL-3.0-or-later
// Qt studio window: the live alert strip (flag live-test-kit, D305 proposed). Headless probe (UJWALAM_HEADLESS=1,
// offscreen, the window is never shown): a real UI server, a fake host that reports an audio warning and a stream
// recovery event of this session. Skipped when the shell is not built (npm run build:studio) or no Qt kit is set.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { LIVE_DIR, STATUS_FILE } from '../services/studio-ui/stream-recovery.mjs';
import { loadTestKitConfig } from '../services/studio-ui/live-test-kit.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const SESSION = 'a'.repeat(32);
const RECOVERY_TEXT = 'Host crashed at 18:02, streams restarted: YouTube H; NOT restarted: Kick (start them from the control page)';

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('Qt studio window: live alert strip (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe(flagOn) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qta-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    if (flagOn) flags.set('live-test-kit', true);
    mkdirSync(path.join(dataDir, LIVE_DIR), { recursive: true });
    writeFileSync(path.join(dataDir, LIVE_DIR, STATUS_FILE), JSON.stringify({ v: 1, events: [
      { session: SESSION, at: '2026-11-09T18:02:30.000Z', crashAt: '2026-11-09T18:02:00.000Z', result: 'partial', reason: 'restart', text: RECOVERY_TEXT },
    ] }));
    const fake = createFakeHost({ outputsReady: true });
    await fake.call('stream.start', {}); // live: the Streamer.bot reminder shows too
    const host = {
      describe: () => fake.describe(),
      async call(m, p) {
        const r = await fake.call(m, p);
        return m === 'host.status' ? { ...r, audioHealth: { warnings: ['Game audio missing'], sources: [{ id: 'audio:game', name: 'Game', state: 'missing', receiving: false }] } } : r;
      },
    };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'q'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, liveSession: SESSION, authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: '4000' });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return JSON.parse(m[1]);
    } finally { srv.close(); }
  }

  test('flag off (the default): the strip stays hidden', async () => {
    const p = await probe(false);
    assert.deepEqual(p.alerts, { shown: false, text: '', level: '' });
  });

  test('flag on: recovery, sound and the Streamer.bot reminder in plain words, worst level error', async () => {
    const p = await probe(true);
    assert.equal(p.alerts.shown, true);
    assert.equal(p.alerts.level, 'error');
    const lines = p.alerts.text.split('\n');
    assert.equal(lines[0], RECOVERY_TEXT);
    assert.match(lines[1], /^Sound problem: Game audio missing\. /);
    assert.ok(lines[2].includes(`"${loadTestKitConfig().streamerbotAction}"`), lines[2]);
    assert.equal(lines.length, 3);
  });
});
