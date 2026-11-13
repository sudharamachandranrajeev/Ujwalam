// SPDX-License-Identifier: GPL-3.0-or-later
// AN1b (D372): the Growth numbers window in the Qt studio shell (headless probe, real UI server, fake host, fake Google,
// seeded analytics.db with placeholder videos in a temp data dir). Flag growth off (default): no menu entry, the window
// says it is switched off. On: the menu entry shows, the table lists the videos with their 24 h checkpoint, Refresh
// within the hour is skipped with a plain note; not signed in: a clear note and Refresh disabled. Skipped when the
// shell is not built. Never shows a window (UJWALAM_HEADLESS=1, offscreen). Set GROWTH_SHOT_DIR to also save a picture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { DB_NAME, openStore } from '../services/analytics/index.mjs';
import { ANALYTICS_SCOPE, READONLY_SCOPE, SCOPE } from '../services/posting/oauth.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const NOW = Date.parse('2026-11-13T10:30:00Z');

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

function seed(dataDir) {
  const st = openStore(path.join(dataDir, DB_NAME));
  st.upsertVideo({ videoId: 'vidA', postId: 'p1', kind: 'montage', clipId: 'C01', title: 'Sample montage A', uploadedAt: '2026-11-10T10:00:00Z' });
  st.setState('vidA', 'public', '2026-11-11T12:00:00Z');
  st.addSnapshot({ videoId: 'vidA', fetchedAt: '2026-11-12T12:30:00.000Z', ageHours: 24.5, data: { views: 100, likes: 8 }, analytics: { views: 98, likes: 8, averageViewPercentage: 61.2, shares: 3, subscribersGained: 2 } });
  st.addSnapshot({ videoId: 'vidA', fetchedAt: '2026-11-13T10:00:00.000Z', ageHours: 46, data: { views: 150, likes: 12 }, analytics: { views: 148, likes: 12, averageViewPercentage: 58.4, shares: 4, subscribersGained: 3 } });
  st.upsertVideo({ videoId: 'vidB', postId: 'p2', kind: 'won-reel', clipId: 'C02', title: 'Sample reel B', uploadedAt: '2026-11-12T10:00:00Z' });
  st.setState('vidB', 'public', '2026-11-12T20:00:00Z');
  st.addSnapshot({ videoId: 'vidB', fetchedAt: '2026-11-13T10:00:00.000Z', ageHours: 14, data: { views: 40, likes: 5 }, analytics: null });
  st.close();
}

describe('Qt studio: Growth numbers window (AN1b, D372)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ flagOn, signedIn = true, seeded = true, actions, ms = 9000, shotDir }) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtgr-')); dirs.push(dataDir);
    if (seeded) seed(dataDir);
    const flags = createFlags({ dataDir });
    if (flagOn) flags.set('growth', true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    let fetches = 0;
    const growth = {
      auth: { status: async () => ({ signedIn, hasClient: true }), grantedScopes: async () => [SCOPE, READONLY_SCOPE, ANALYTICS_SCOPE], accessToken: async () => 'tok' },
      fetchImpl: async () => { fetches += 1; throw new Error('no network in tests'); },
    };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), now: () => NOW, growth });
    const { port } = await srv.listen();
    try {
      const env = { UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') };
      if (shotDir) env.UJWALAM_STUDIO_SETTINGS_SHOT_DIR = shotDir;
      const r = await runShell(env);
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { p: JSON.parse(m[1]), fetches };
    } finally { await srv.close(); }
  }

  test('flag off: no menu entry, and the window says it is switched off', async () => {
    const r = await probe({ flagOn: false, seeded: false, actions: ['growth-open'] });
    assert.equal(r.p.growthMenu, false);
    assert.equal(r.p.growth.rows, 0);
    assert.match(r.p.growth.info, /switched off/);
    assert.equal(r.p.growth.refreshEnabled, false);
  });

  test('flag on: menu entry, the videos with their numbers and checkpoints, Refresh within the hour is skipped', async () => {
    const r = await probe({ flagOn: true, actions: ['growth-open', 'growth-refresh'], ms: 10000 });
    assert.equal(r.p.growthMenu, true);
    assert.equal(r.p.growth.rows, 2);
    const byTitle = Object.fromEntries(r.p.growth.cells.map((c) => [c[0], c]));
    const a = byTitle['Sample montage A'];
    assert.equal(a[1], 'Montage');
    assert.deepEqual(a.slice(3, 8), ['148', '12', '58.4', '4', '3'], 'latest views, likes, avg viewed %, shares, subs');
    assert.match(a[8], /98 views, 8 likes, 61\.2% viewed, \+2 subs/, 'the 24 h checkpoint');
    assert.equal(a[9], 'not reached yet');
    const b = byTitle['Sample reel B'];
    assert.equal(b[1], 'Won-round reel');
    assert.deepEqual(b.slice(3, 8), ['40', '5', '-', '-', '-'], 'no statistics yet: dashes, not zeros');
    assert.match(r.p.growth.fetched, /Last read from YouTube/);
    assert.match(r.p.growth.info, /less than an hour ago/);
    assert.equal(r.fetches, 0, 'the skipped refresh made no call to Google');
  });

  test('flag on, not signed in: a plain note and Refresh disabled', async () => {
    const r = await probe({ flagOn: true, signedIn: false, seeded: false, actions: ['growth-open'] });
    assert.equal(r.p.growth.rows, 0);
    assert.match(r.p.growth.info, /Not signed in to YouTube/);
    assert.equal(r.p.growth.refreshEnabled, false);
  });

  test('flag on, signed in, nothing posted: the empty state points to the Posts window', async () => {
    const r = await probe({ flagOn: true, seeded: false, actions: ['growth-open'] });
    assert.match(r.p.growth.info, /No posted videos yet/);
    assert.equal(r.p.growth.refreshEnabled, true);
  });

  test('a picture of the window (only when GROWTH_SHOT_DIR is set; not committed)', { skip: !process.env.GROWTH_SHOT_DIR }, async () => {
    mkdirSync(process.env.GROWTH_SHOT_DIR, { recursive: true });
    const r = await probe({ flagOn: true, actions: ['growth-open', 'growth-shot:growth-window'], ms: 10000, shotDir: process.env.GROWTH_SHOT_DIR });
    assert.equal(r.p.actions[1].done, true);
    assert.ok(existsSync(path.join(process.env.GROWTH_SHOT_DIR, 'growth-window.png')));
  });
});
