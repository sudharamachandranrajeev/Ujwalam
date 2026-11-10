// SPDX-License-Identifier: GPL-3.0-or-later
// D327 in the Qt studio shell (headless probe, real UI server, fake host, mocked TCP test): Settings > Stream (values,
// a value over a platform limit refused with the limit, the Edit output window with its Connect button (tests/studio-qt-connect-button.test.mjs)),
// Settings > Transitions (type, easing, duration per canvas, Force complete), Settings > Integrations (Test, Allow
// remote connections), and the main-window Outputs panel (offline switch saves; live switch acts on the click, D331).
// Pictures go to %TEMP%\ujwalam-d327-shots (never into the repo). Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const SHOTS = path.join(os.tmpdir(), 'ujwalam-d327-shots');

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

describe('Qt studio D327 pages (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = 9000, shot = null, live = false } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qt327-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of ['stream-settings', 'outputs-panel', 'integrations', 'transitions']) flags.set(id, true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    if (live) await fake.call('stream.start', {});
    const calls = [];
    const host = { describe: () => fake.describe(), call: (m, p) => { if (!['host.status', 'outputs.status'].includes(m)) calls.push([m, p]); return fake.call(m, p); } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const tcpCalls = [];
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async (port) => { tcpCalls.push(port); return false; }, botConfig: () => ({}) });
    const { port } = await srv.listen();
    try {
      if (shot) mkdirSync(SHOTS, { recursive: true });
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...(shot ? { UJWALAM_STUDIO_PROBE_SHOT: path.join(SHOTS, shot) } : {}) });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { p: JSON.parse(m[1]), err: r.err, dataDir, file, calls, tcpCalls };
    } finally { srv.close(); }
  }
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));

  test('Settings > Stream: the seed is shown; a bitrate over a platform limit is refused with the limit; Edit has Connect', async () => {
    const r = await probe({ actions: ['settings-open', 'settings-section:Stream', 'stream-kbps:60000', 'settings-save', 'stream-output-edit:0'],
      shot: 'stream.png', ms: 9000 });
    const d = done(r.p);
    assert.equal(d['settings-section:Stream'], true);
    assert.ok(r.p.settings.sections.includes('Stream') && r.p.settings.sections.includes('Transitions') && r.p.settings.sections.includes('Integrations'), JSON.stringify(r.p.settings.sections));
    assert.equal(r.p.streamPage.loaded, true);
    assert.ok(r.p.streamPage.outputs.length >= 3, JSON.stringify(r.p.streamPage.outputs));
    assert.match(r.p.streamPage.problems, /50000/, 'the limit is shown on the page');
    assert.match(r.p.note, /Not saved: Settings > Stream has a value over a platform limit/, r.p.note);
    assert.ok(!existsSync(path.join(r.dataDir, 'stream-setup.json')), 'the refused setup was not written');
    assert.ok(r.p.dialogShots >= 1, 'the Edit output window was open for its picture');
    assert.doesNotMatch(r.err, /Could not parse|Unknown property/i);
  });

  test('Settings > Stream: a valid change saves', async () => {
    const r = await probe({ actions: ['settings-open', 'settings-section:Stream', 'stream-kbps:12000', 'settings-save'] });
    const setup = JSON.parse(readFileSync(path.join(r.dataDir, 'stream-setup.json'), 'utf8'));
    assert.equal(setup.video.bitrateKbps, 12000);
    assert.equal(r.p.settings, undefined, 'Settings closed');
  });

  test('Settings > Transitions: easing per canvas saved into the project; Force complete calls the host', async () => {
    const r = await probe({ actions: ['settings-open', 'settings-section:Transitions', 'tr-type:h:fade', 'tr-ease:h:in-out-cubic', 'tr-ms:h:800', 'tr-mirror:on', 'tr-force:h', 'settings-section:Transitions'],
      shot: 'transitions.png', ms: 10000 });
    const d = done(r.p);
    assert.equal(d['tr-ease:h:in-out-cubic'], true, JSON.stringify(r.p.actions));
    assert.ok(r.p.transitionsPage.h.easingChoices >= 20);
    assert.equal(r.p.transitionsPage.mirror, true);
    assert.match(r.p.transitionsPage.forced, /^h:(completed|idle)$/);
    assert.deepEqual(r.calls.find(([m]) => m === 'transitions.forceComplete'), ['transitions.forceComplete', { canvas: 'H' }]);
    // Save (a second run so the picture above shows the page before saving)
    const s = await probe({ actions: ['settings-open', 'settings-section:Transitions', 'tr-type:h:fade', 'tr-ease:h:in-out-cubic', 'tr-ms:h:800', 'tr-mirror:on', 'settings-save'] });
    const doc = JSON.parse(readFileSync(s.file, 'utf8'));
    const h = doc.canvases.find((c) => c.id === 'h').transition, v = doc.canvases.find((c) => c.id === 'v').transition;
    assert.deepEqual(h, { type: 'fade', durationMs: 800, easing: 'in-out-cubic' });
    assert.deepEqual(v, { type: 'fade', durationMs: 800, easing: 'in-out-cubic', mirror: true });
  });

  test('Settings > Integrations: Test goes to the mocked TCP check; Allow remote connections saves (off by default)', async () => {
    const r = await probe({ actions: ['settings-open', 'settings-section:Integrations', 'int-test:streamerbot', 'settings-section:Integrations'], shot: 'integrations.png' });
    assert.equal(r.p.integrationsPage.remote, false, 'off by default');
    assert.match(r.p.integrationsPage.streamerbotStatus, /Not reachable on 127\.0\.0\.1:\d+/);
    assert.equal(r.tcpCalls.length, 1);
    const s = await probe({ actions: ['settings-open', 'settings-section:Integrations', 'int-remote:on', 'settings-save'] });
    const v = JSON.parse(readFileSync(path.join(s.dataDir, 'integrations.json'), 'utf8'));
    assert.equal(v.remote.enabled, true);
    assert.equal(v.remote.address, null);
    assert.ok(!/token/i.test(readFileSync(path.join(s.dataDir, 'integrations.json'), 'utf8')), 'no token stored');
  });

  test('Outputs panel: rows with switches and Virtual Camera (not available); offline switch saves; live switch acts on the click (D331)', async () => {
    const r = await probe({ actions: ['output-toggle:twitch:off'], shot: 'outputs-panel.png' });
    assert.equal(r.p.outputsPanel.shown, true);
    assert.equal(r.p.outputsPanel.virtualCamera, false, 'Virtual Camera row shown, switched off and disabled');
    assert.ok(r.p.outputsPanel.rows.some((x) => x.id === 'twitch'));
    assert.equal(done(r.p)['output-toggle:twitch:off'], true);
    const setup = JSON.parse(readFileSync(path.join(r.dataDir, 'stream-setup.json'), 'utf8'));
    assert.equal(setup.outputs.find((o) => o.id === 'twitch').enabled, false);

    const l = await probe({ live: true, actions: ['output-toggle:twitch:off'], shot: 'outputs-panel-live.png' });
    assert.equal(done(l.p)['output-toggle:twitch:off'], true);
    assert.equal(l.p.outputsPanel.live, true);
    // D331: no typed phrase and no confirm window; that one output stops at once, the others keep running.
    assert.deepEqual(l.calls.filter(([m]) => m === 'stream.stop').map(([, x]) => x), [{ sinks: ['twitch'] }], 'only twitch stopped, on the click');
    assert.ok(!l.calls.some(([m]) => m === 'stream.start'), 'nothing else started');
  });
});
