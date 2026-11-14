// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Chat & bots in the QML studio (plan Q3, slice 5): the QML twin of the Integrations test in
// studio-qt-d327.test.mjs (Test goes to the mocked TCP check; Allow remote connections saves, off by default, no token
// stored), plus the page's own rules: the ports keep to their range, Test uses the port being edited, Save sends nothing
// when nothing changed, Cancel / the unsaved question, flag off hides the settings, no sideways scrolling and plain words.
// Same probe actions as the widget (settings-open, settings-page, int-test, int-remote) and int-port for the range.
// Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a real UI server and the fake host, temp data
// dir, no network. Skipped when the shell is not built.
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
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio Settings > Chat & bots (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 700), flagIds = ['integrations'], answered = false } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlchat-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of flagIds) flags.set(id, true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const tcpCalls = [];
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async (port) => { tcpCalls.push(port); return answered; }, botConfig: () => ({}) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, ip: p.state.settings?.integrationsPage, dataDir, tcpCalls, saved: () => path.join(dataDir, 'integrations.json') };
    } finally { await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const PAGE_NAMES = /^(streamerbot|speakerbot|integrations)/;
  const PAGE = 'settings-page:Chat%20%26%20bots';
  const open = ['settings-open', PAGE];
  // the state of a change shows on the next probe; a quiet action gives the page its turn
  const WAIT = [PAGE];
  const exists = (f) => existsSync(f);

  // ---- twin of the Integrations test in studio-qt-d327.test.mjs ----
  test('Test goes to the mocked TCP check; remote connections are off by default', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'int-test:streamerbot', ...WAIT, ...WAIT] });
    assert.ok(r.ip, 'the page is shown');
    assert.equal(r.ip.loaded, true);
    assert.equal(r.ip.remote, false, 'off by default');
    assert.equal(r.ip.dirty, false);
    assert.equal(done(r.p)['int-test:streamerbot'], true);
    assert.match(r.ip.streamerbotStatus, /^Not reachable on 127\.0\.0\.1:\d+\. Is it running, with its WebSocket server on\?$/);
    assert.equal(r.ip.speakerbotStatus, 'Not tested');
    assert.equal(r.tcpCalls.length, 1);
    assert.match(r.ip.remoteInfo, /^Not running/);
    assert.equal(node(r.p, 'integrationsCopy').enabled, false, 'no pairing code while nothing listens');
  });

  test('a bot that answers shows Connected, with the port that was tested', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'int-test:speakerbot', ...WAIT, ...WAIT], answered: true });
    assert.match(r.ip.speakerbotStatus, /^Connected \(127\.0\.0\.1:\d+ answers\)$/);
    assert.equal(r.tcpCalls.length, 1);
    assert.equal(r.ip.streamerbotStatus, 'Not tested');
  });

  test('Allow remote connections saves; no pairing code or token is stored', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'int-remote:on', ...WAIT, 'settings-save'], ms: 12000 });
    assert.ok(Object.values(done(r.p)).every(Boolean), JSON.stringify(r.p.actions));
    const text = readFileSync(r.saved(), 'utf8');
    const v = JSON.parse(text);
    assert.equal(v.remote.enabled, true);
    assert.equal(v.remote.address, null);
    assert.ok(!/token/i.test(text), 'no token stored');
    assert.equal(r.s.flagsInSettings, false, 'Settings closed');
    assert.match(r.s.note, /Settings saved\.|Integrations saved; they apply at the next start\./);
  });

  // ---- the page's own rules ----
  test('ports are edited and kept to 1024-65535; Test uses the port being edited; Save writes both ports', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'int-port:streamerbot:70000', 'int-port:speakerbot:80', ...WAIT, 'int-port:streamerbot:7123', 'int-test:streamerbot', ...WAIT, ...WAIT, 'settings-save'], ms: 12000 });
    assert.ok(Object.values(done(r.p)).every(Boolean), JSON.stringify(r.p.actions));
    assert.deepEqual(r.tcpCalls, [7123], 'the edited port, not the saved one');
    const v = JSON.parse(readFileSync(r.saved(), 'utf8'));
    assert.deepEqual(v.bots, { streamerbot: { port: 7123 }, speakerbot: { port: 1024 } });
    assert.equal(v.remote.enabled, false);
  });

  test('the ranges alone: too big gives 65535, too small gives 1024, a name that is not a bot is refused', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'int-port:streamerbot:70000', 'int-port:speakerbot:80', 'int-port:nobody:5000', 'int-test:nobody', 'int-remote:maybe', ...WAIT] });
    const d = done(r.p);
    assert.equal(d['int-port:nobody:5000'], false);
    assert.equal(d['int-test:nobody'], false);
    assert.equal(d['int-remote:maybe'], false);
    assert.equal(r.ip.streamerbotPort, 65535);
    assert.equal(r.ip.speakerbotPort, 1024);
    assert.equal(r.ip.dirty, true);
    assert.equal(r.s.settings.dirty, true);
    assert.equal(r.tcpCalls.length, 0, 'a refused Test asks nothing');
  });

  test('a change put back to what was loaded is no change', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'int-remote:on', 'int-port:streamerbot:7123', ...WAIT, 'int-remote:off', ...WAIT] });
    assert.equal(r.ip.remote, false);
    assert.equal(r.ip.dirty, true, 'the port is still changed');
    const k = await probe({ actions: [...open, ...WAIT, 'int-remote:on', ...WAIT, 'int-remote:off', ...WAIT] });
    assert.equal(k.ip.dirty, false);
    assert.equal(k.s.settings.dirty, false);
  });

  test('flag off: the page says how to switch it on and shows no settings; nothing is written', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'int-remote:on', 'settings-save'], flagIds: [] });
    assert.ok(!r.ip, 'no page state with the flag off');
    assert.equal(done(r.p)['int-remote:on'], false, 'no page, no change');
    assert.equal(node(r.p, 'streamerbotTest')?.visible ?? false, false);
    assert.equal(node(r.p, 'integrationsRemote')?.visible ?? false, false);
    assert.equal(exists(r.saved()), false);
    const lead = node(r.p, 'settingsLead:Chat & bots');
    assert.match(lead.text, /^Switch on .+ below and click Save to use these settings\.$/);
    assert.doesNotMatch(lead.text, /classic studio window/);
  });

  test('flag on: the page has no lead line and no sideways scrolling; plain words only; every control inside the page', async () => {
    const r = await probe({ actions: [...open, ...WAIT] });
    const page = node(r.p, 'settingsPage:Chat & bots');
    assert.ok(page && page.visible);
    assert.equal(node(r.p, 'settingsLead:Chat & bots')?.visible ?? false, false, 'no "not shown yet" line any more');
    const [px, , pw] = page.rect;
    const mine = r.p.tree.filter((x) => x.visible && x.rect && x.rect[2] > 0 && PAGE_NAMES.test(x.name));
    assert.ok(mine.length >= 9, `${mine.length} named controls on the page`);
    for (const n of mine) assert.ok(n.rect[0] >= px - 1 && n.rect[0] + n.rect[2] <= px + pw + 1, `${n.name} ends inside the page (${n.rect} vs ${page.rect})`);
    const words = r.p.tree.filter((x) => (PAGE_NAMES.test(x.name) || /^settings(Title|Lead|Note):Chat & bots$/.test(x.name)) && typeof x.text === 'string').map((x) => x.text).join('\n');
    assert.match(words, /Allow remote connections/);
    assert.match(words, /Copy pairing code/);
    assert.match(words, /Automatic \(first home network address\)/);
    assert.doesNotMatch(words, /\bD\d{2,}\b|[\\/][\w.-]+\.(json|mjs|cpp|md)\b/, 'no decision numbers or file paths in the words');
  });

  // ---- Save / Cancel / the unsaved question ----
  test('with nothing changed, Save writes no integrations file', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'settings-save'] });
    assert.equal(r.s.flagsInSettings, false, 'Settings closed');
    assert.equal(exists(r.saved()), false);
  });

  test('Cancel with a change asks Save changes / Discard / Cancel; Discard writes nothing, Save changes writes it', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'int-remote:on', ...WAIT, 'settings-cancel', 'settings-unsaved:discard'], ms: 12000 });
    assert.equal(done(r.p)['settings-cancel'], true);
    assert.equal(r.s.flagsInSettings, false);
    assert.equal(exists(r.saved()), false, 'nothing written');
    const k = await probe({ actions: [...open, ...WAIT, 'int-remote:on', ...WAIT, 'settings-cancel'] });
    assert.deepEqual([k.s.settings.unsavedOpen, k.s.settings.dirty], [true, true]);
    const sv = await probe({ actions: [...open, ...WAIT, 'int-remote:on', ...WAIT, 'settings-cancel', 'settings-unsaved:save'], ms: 12000 });
    assert.equal(JSON.parse(readFileSync(sv.saved(), 'utf8')).remote.enabled, true, 'Save changes writes it');
  });
});
