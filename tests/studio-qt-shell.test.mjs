// SPDX-License-Identifier: GPL-3.0-or-later
// Qt studio shell (P5a step 1) smoke test: headless (UJWALAM_HEADLESS=1, no window), the shell logs in to a real
// studio UI server (fake host, stub core, 127.0.0.1) with the one-time launch key from its environment, calls
// scenes.list through the server and prints one line. Also: the key is single use, a bad URL is refused.
// Skipped when the shell is not built (npm run build:studio) or no Qt kit is configured.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(EXE, [], {
      windowsHide: true,
      env: { ...process.env, PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}`, UJWALAM_HEADLESS: '1', ...env },
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
describe('Qt studio shell panels (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe(on, ms = 5000, actions = '') {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtp-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of on) flags.set(id, true);
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'p'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), limits: { statusPollMs: 50 } });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { ...JSON.parse(m[1]), fake, store: flags };
    } finally { srv.close(); }
  }

  test('defaults: every flag listed and off, flag-gated panels hidden, scenes and layers loaded', async () => {
    const p = await probe([]);
    const ids = JSON.parse(readFileSync(path.join(UI, '..', 'data', 'flags.json'), 'utf8')).flags.map((f) => f.id);
    assert.deepEqual(p.flags.map((f) => f.id), ids);
    assert.ok(p.flags.every((f) => f.on === false));
    assert.deepEqual(p.shown, { structure: false, transitions: false, bots: false, report: false, posts: false });
    assert.equal(p.scenes, 3);
    assert.ok(p.layers > 0, 'the active scene\'s layers are listed');
    assert.equal(p.undoEnabled, false, 'empty history');
    assert.equal(p.live, false);
    assert.equal(p.trackButtons, 0, 'no track routing buttons while mixer-routing is off');
  });

  test('flags on: structure, transitions, bots, report and posts appear; bots listed with their buttons; mixer track buttons', async () => {
    const p = await probe(['scene-edit', 'transitions', 'bot-manager', 'report-button', 'posting', 'mixer-routing']);
    for (const id of ['scene-edit', 'transitions', 'bot-manager', 'report-button', 'posting']) assert.equal(p.flags.find((f) => f.id === id)?.on, true, id);
    assert.deepEqual(p.shown, { structure: true, transitions: true, bots: true, report: true, posts: true });
    assert.equal(p.botButtons, 4, 'Start and Stop for Streamer.bot and Speaker.bot');
    assert.equal(p.trackButtons, 6, 'mixer-routing: a button per project track (2) on each of the 3 fake mixer strips (D273)');
  });
  test('probe actions click the real widgets: Mute, a track button, a flag off; undo with no history does nothing (D275)', async () => {
    const p = await probe(['mixer-routing', 'scene-edit'], 7000, 'mute:0,track:0:1,flag-off:scene-edit,undo');
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['mute:0', true], ['track:0:1', true], ['flag-off:scene-edit', true], ['undo', false]]);
    const cam = (await p.fake.call('mixer.list')).sources.find((s) => s.id === 'scene-1/cam');
    assert.equal(cam.muted, true, 'Mute clicked: mixer.setMute reached the host');
    assert.deepEqual(cam.tracks, ['t1', 't2'], 'second track clicked: mixer.setTracks with both tracks');
    assert.equal(p.store.isOn('scene-edit'), false, 'flag unticked: off at once, no phrase');
    assert.equal(p.shown.structure, false, 'the structure box follows the flag');
    assert.equal(p.trackButtons, 6);
  });
});
