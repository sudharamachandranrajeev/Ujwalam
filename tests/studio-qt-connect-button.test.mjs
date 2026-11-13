// SPDX-License-Identifier: GPL-3.0-or-later
// D327: Edit output > Connect in the Qt studio shell (headless probe, real UI server, fake host, in-memory credential
// store). Flag platform-connect off: the button is disabled and its tooltip says how to turn it on. On: it is enabled,
// the window and the output row show the connection state (at most the last 4 of a key), and a click opens the
// Connections flow for that one output. A new, unsaved output cannot be connected yet (tooltip says why).
// Pictures go to %TEMP%\ujwalam-connect-shots (never into the repo). Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createMemoryStores } from '../services/platform-connect/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const SHOTS = path.join(os.tmpdir(), 'ujwalam-connect-shots');
const TWITCH_KEY = 'live_123456789_MockTwitchStreamKeyZZ9'; // lint-allow: secret (a made-up test marker, not a credential)

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(EXE, [], {
      windowsHide: true,
      env: { ...process.env, PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}`, UJWALAM_HEADLESS: '1', QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
function allFiles(dir) { return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; }); }

describe('Qt studio: Edit output > Connect (D327)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ connectFlag, actions, shot = null, ms = 9500 }) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtcb-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    flags.set('stream-settings', true);
    if (connectFlag) flags.set('platform-connect', true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => (m === 'outputs.status' ? { configured: true, sinks: [] } : fake.call(m, p)) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const mem = createMemoryStores({ 'Ujwalam/stream/twitch': TWITCH_KEY, 'Ujwalam/stream/twitch-server': 'rtmps://zz9-mock-ingest.example.net:443/app' });
    const key = 't'.repeat(40);
    const logs = [];
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), connect: { storeFor: mem.storeFor, sleep: async () => {} }, log: (m) => logs.push(String(m)) });
    const { port } = await srv.listen();
    try {
      if (shot) mkdirSync(SHOTS, { recursive: true });
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...(shot ? { UJWALAM_STUDIO_PROBE_SHOT: path.join(SHOTS, shot) } : {}) });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      // Leak check: the stored key is in no output of the shell, no log line and no file of the data folder.
      assert.ok(!r.out.includes(TWITCH_KEY) && !r.err.includes(TWITCH_KEY), 'the key reached the shell output');
      assert.ok(!logs.some((l) => l.includes(TWITCH_KEY)), 'the key reached a server log line');
      for (const f of allFiles(dataDir)) assert.ok(!readFileSync(f, 'utf8').includes(TWITCH_KEY), `the key reached ${path.basename(f)}`);
      return { p: JSON.parse(m[1]), err: r.err };
    } finally { await srv.close(); }
  }
  const stream = ['settings-open', 'settings-section:Stream'];

  test('flag off: Connect is disabled with a tooltip saying how to turn it on; no status on the rows', async () => {
    const r = await probe({ connectFlag: false, actions: [...stream, 'stream-output-edit:2'], shot: 'connect-off.png' });
    const b = r.p.streamPage.connectButton;
    assert.ok(b, JSON.stringify(r.p.streamPage));
    assert.equal(b.enabled, false);
    assert.match(b.tooltip, /feature flag platform-connect/);
    assert.match(b.tooltip, /Settings > Connections/);
    assert.equal(r.p.streamPage.connectOn, false);
    assert.deepEqual(r.p.streamPage.rowStatus, []);
    assert.equal(r.p.streamPage.connectFlow, undefined);
    assert.doesNotMatch(r.err, /Could not parse|Unknown property/i);
  });

  test('flag on: enabled, shows the state (last 4 only), the click opens the flow for that output alone', async () => {
    const r = await probe({ connectFlag: true, actions: [...stream, 'stream-output-edit:2', 'stream-output-connect'], shot: 'connect-on.png' });
    const sp = r.p.streamPage;
    assert.equal(sp.outputs[2], 'twitch', JSON.stringify(sp.outputs));
    assert.equal(sp.connectOn, true);
    assert.equal(sp.connectButton.enabled, true);
    assert.match(sp.connectButton.tooltip, /Sign in to the platform, or paste/);
    assert.equal(sp.connectButton.status, `Connected  (key ....${TWITCH_KEY.slice(-4)})`);
    assert.ok(sp.rowStatus.length >= 3, JSON.stringify(sp.rowStatus));
    assert.ok(sp.rowStatus.some((t) => t.includes(`key ....${TWITCH_KEY.slice(-4)}`)), 'the output row shows the state');
    assert.ok(sp.rowStatus.some((t) => t.includes('Not connected')), 'an output without a key shows Not connected');
    assert.ok(sp.connectFlow, 'the Connections flow opened');
    assert.equal(sp.connectFlow.output, 'twitch');
    assert.equal(sp.connectFlow.rows.length, 1, 'only that output');
    assert.match(sp.connectFlow.rows[0], /Twitch/);
    assert.ok(r.p.dialogShots >= 1);
  });

  test('flag on: a new output that is not saved yet cannot be connected, and the tooltip says what to do', async () => {
    const r = await probe({ connectFlag: true, actions: [...stream, 'stream-output-add'] });
    const b = r.p.streamPage.connectButton;
    assert.ok(b, JSON.stringify(r.p.streamPage));
    assert.equal(b.enabled, false);
    assert.match(b.tooltip, /Save this output first/);
    assert.match(b.status, /Not connected/);
  });
});
