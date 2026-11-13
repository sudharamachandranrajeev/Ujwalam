// SPDX-License-Identifier: GPL-3.0-or-later
// The Qt Quick studio window (D355/D360, flag studio-qml; plan Q2). Headless probe (UJWALAM_HEADLESS=1, offscreen,
// software drawing, never on a screen) against a real UI server and the fake host: the window's tree (on-air bar,
// scenes, layers with eye buttons, mixer strips with full names), real clicks through the same routes as the widget
// studio, and a picture of the window. Skipped when the shell is not built (npm run build:studio) or no Qt kit is set.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject } from '../services/project/index.mjs';
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

describe('QML studio window (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = 4500, shot = null, project = null } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    flags.set('mixer-routing', true);
    const fake = createFakeHost({ outputsReady: true });
    const calls = [];
    const host = { describe: () => fake.describe(), call: (m, p) => { calls.push(m); return fake.call(m, p); } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'q'.repeat(40);
    let projectSync, file;
    if (project) {
      file = path.join(dataDir, 'test.project.json');
      writeFileSync(file, JSON.stringify(project));
      projectSync = createProjectSync({ file, delayMs: 5 });
    }
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, ...(projectSync ? { projectSync } : {}),
      limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...(shot ? { UJWALAM_STUDIO_PROBE_SHOT: shot } : {}) });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError)/, 'no QML errors');
      return { p: JSON.parse(m[1]), fake, calls, file };
    } finally { srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);

  test('the window shows the bar, scenes, layers and mixer from the host, with words on every control', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-shot-')); dirs.push(dir);
    const shot = path.join(dir, 'qml.png');
    const { p } = await probe({ shot });
    assert.equal(p.ui, 'qml');
    assert.deepEqual(p.state.scenes, ['Gameplay', 'Starting soon', 'Gameplay V']);
    assert.equal(p.state.activeScene, 'scene-1');
    assert.deepEqual(p.state.layers.map((l) => l.id), ['game', 'cam', 'chat']);
    for (const n of ['onAirBar', 'scenesPanel', 'layersPanel', 'mixerPanel', 'previewH', 'previewV', 'scene:scene-2', 'layer:chat', 'eye:chat', 'strip:scene-1/game', 'vol:scene-1/game'])
      assert.ok(node(p, n), `${n} in the tree`);
    assert.equal(node(p, 'streamBtn').text, 'Go live');
    assert.equal(node(p, 'streamBtn').enabled, true, 'outputs ready');
    assert.equal(node(p, 'recordBtn').text, 'Record');
    assert.equal(node(p, 'chipLive').text, 'Offline');
    assert.equal(node(p, 'stripName:scene-1/game').text, 'Game', 'the full mixer name');
    assert.equal(node(p, 'cue:scene-1/game').checked, true);
    assert.equal(node(p, 'mute:scene-2/text').text, 'Muted');
    assert.ok(node(p, 'track:scene-1/game:t2'), 'track buttons with routing on');
    assert.equal(p.shot, true);
    assert.ok(statSync(shot).size > 10_000, 'a picture of the window');
  });

  test('clicks go through the same routes: show a layer, mute, record, switch scene', async () => {
    const { p, fake } = await probe({ actions: ['click:eye:chat', 'click:mute:scene-1/cam', 'click:recordBtn', 'click:scene:scene-2'], ms: 7000 });
    assert.deepEqual(p.actions.map((a) => a.done), [true, true, true, true], JSON.stringify(p.actions));
    const chat = (await fake.call('layers.list', { scene: 'scene-1' })).layers.find((l) => l.id === 'chat');
    assert.equal(chat.visible, true, 'the eye showed the layer');
    assert.equal((await fake.call('mixer.list')).sources.find((m) => m.id === 'scene-1/cam').muted, true);
    assert.equal((await fake.call('host.status')).recording, true);
    assert.equal(p.state.activeScene, 'scene-2');
    assert.deepEqual(p.state.layers.map((l) => l.id), ['text']);
    assert.equal(node(p, 'recordBtn').text, 'Stop recording');
  });

  test('one Add/Delete place: add a scene and a text layer through their windows, delete the layer, scene delete needs scene editing', async () => {
    // A project whose one scene is the fake host's scene-2, so a layer added to it reaches both.
    const project = createProject({ name: 'QML test' });
    project.scenes[0].id = 'scene-2';
    project.activeScene = 'scene-2';
    const { p, fake, calls, file } = await probe({ project, ms: 10_500, actions: [
      'click:scene:scene-2',
      'click:addScene', 'type:addSceneName=Probe scene', 'click:addSceneOk',
      'click:addLayer', 'click:kind:text', 'type:addText=Probe text', 'click:addLayerOk',
      'click:deleteLayer',
      'click:deleteScene:scene-1',
    ] });
    assert.deepEqual(p.actions.map((a) => a.done), Array(10).fill(true), JSON.stringify(p.actions));
    assert.ok(p.state.scenes.includes('Probe scene'), 'the new scene is listed');
    assert.ok((await fake.call('scenes.list')).scenes.some((s) => s.name === 'Probe scene'), 'the host made the scene');
    assert.ok(calls.includes('layers.addFromProject'), 'the text layer was added');
    assert.ok(calls.includes('layers.remove'), 'and deleted again');
    assert.deepEqual((await fake.call('layers.list', { scene: 'scene-2' })).layers.map((l) => l.id), ['text']);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(saved.scenes.some((s) => s.name === 'Probe scene'), 'saved to the project file');
    assert.deepEqual(saved.scenes.find((s) => s.id === 'scene-2').layers, [], 'the deleted layer is gone from the file');
    assert.ok(!calls.includes('scenes.remove'), 'scene editing is off: nothing deleted');
    assert.match(p.state.note, /scene editing/);
  });
});
