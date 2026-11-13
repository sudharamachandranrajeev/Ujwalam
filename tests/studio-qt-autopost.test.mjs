// SPDX-License-Identifier: GPL-3.0-or-later
// D375: Settings > Posting & growth > Auto-post in the Qt studio shell (headless probe, real UI server, fake host, temp
// data dir, no network). The card shows the defaults (upload on, every kind, as many a day as the quota fits, 1 h apart,
// 60 days ahead, fill the gaps), the next posting times saying Scheduled, and Save writes the user's files in the data
// folder. Skipped when the shell is not built. Never shows a window (UJWALAM_HEADLESS=1, offscreen). Set
// AUTOPOST_SHOT_DIR to also save a picture of the page (evidence only, not committed).
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
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { userRulesFile } from '../services/posting/auto-post.mjs';
import { userScheduleFile } from '../services/posting/schedule.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const NOW = Date.parse('2026-11-13T10:00:00Z');
const PAGE = 'settings-page:Posting%20%26%20growth';

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

describe('Qt studio: Settings > Posting & growth > Auto-post (D375)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions, ms = 9000, shotDir = null, flagIds = ['posting', 'auto-post', 'post-schedule'] }) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtap-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of flagIds) flags.set(id, true);
    const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => NOW);
    q.add('clip1'); q.patch('clip1', { state: 'queued', publishAt: '2026-11-13T12:00:00.000Z' });
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const youtube = { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, fetchImpl: async () => { throw new Error('no network in tests'); } };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), now: () => NOW, youtube });
    const { port } = await srv.listen();
    try {
      const env = { UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') };
      if (shotDir) env.UJWALAM_STUDIO_SETTINGS_SHOT_DIR = shotDir;
      const r = await runShell(env);
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { p: JSON.parse(m[1]), dataDir };
    } finally { await srv.close(); }
  }
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));

  test('the card shows the defaults, the quota fit and the next posting times, each saying Scheduled', async () => {
    const { p } = await probe({ actions: ['settings-open', PAGE] });
    const c = p.autopostCard;
    assert.ok(c, 'the card is on the page'); assert.equal(c.loaded, true); assert.equal(c.dirty, false);
    assert.deepEqual(c.card, { autoUpload: true, kinds: ['short', 'montage', 'won-reel', 'impact-play'], minScore: 3, maxPerDay: 6, intervalHours: 1, maxAheadDays: 60, placement: 'fill-gaps', quotaUnitsPerDay: 10000 });
    assert.match(c.fit, /About 6 uploads a day fit/);
    assert.match(c.flags, /Auto post and Scheduled posting are on/); assert.match(c.flags, /stay in the clips folder/);
    assert.ok(c.times.length >= 11, c.times.join(' | '));
    assert.match(c.times[0], /queued clip, scheduled/);
    assert.ok(c.times.slice(1).every((t) => /Scheduled/.test(t)), c.times.join(' | '));
    assert.match(c.timesInfo, /not been read yet/);
  });

  test('flags off: the card says nothing uploads by itself; with the posting flag off there is no card', async () => {
    let { p } = await probe({ actions: ['settings-open', PAGE], flagIds: ['posting'] });
    assert.match(p.autopostCard.flags, /Nothing uploads by itself until Auto post and Scheduled posting are switched on/);
    ({ p } = await probe({ actions: ['settings-open', PAGE], flagIds: [] }));
    assert.equal(p.autopostCard, undefined);
  });

  test('edits make the dialog dirty; no kind at all blocks Save with a plain note', async () => {
    const { p } = await probe({ actions: ['settings-open', PAGE, 'ap-gap:6', 'ap-perday:9', 'ap-kind:short:off', 'ap-kind:montage:off', 'ap-kind:won-reel:off', 'ap-kind:impact-play:off', 'settings-save'] });
    const c = p.autopostCard;
    assert.ok(Object.values(done(p)).every(Boolean), JSON.stringify(p.actions));
    assert.equal(c.dirty, true); assert.equal(p.settings.dirty, true);
    assert.match(c.problem, /at least one kind/);
    assert.match(c.fit, /More than that a day stop at the quota/);
  });

  test('Save writes the user files in the data folder (one click, no question)', async () => {
    const { p, dataDir } = await probe({ actions: ['settings-open', PAGE, 'ap-gap:6', 'ap-kind:impact-play:off', 'ap-placement:after-last', 'settings-save'] });
    assert.ok(Object.values(done(p)).every(Boolean), JSON.stringify(p.actions));
    const sched = JSON.parse(readFileSync(userScheduleFile(dataDir), 'utf8'));
    assert.equal(sched.intervalHours, 6); assert.equal(sched.placement, 'after-last'); assert.equal(sched.maxAheadDays, 60);
    const rules = JSON.parse(readFileSync(userRulesFile(dataDir), 'utf8'));
    assert.deepEqual(rules.rules[0].kinds, ['short', 'montage', 'won-reel']); assert.equal(rules.maxUploadsPerDay, 6);
  });

  test('a picture of the page (only when AUTOPOST_SHOT_DIR is set; not committed)', { skip: !process.env.AUTOPOST_SHOT_DIR }, async () => {
    mkdirSync(process.env.AUTOPOST_SHOT_DIR, { recursive: true });
    const { p } = await probe({ actions: ['settings-open', PAGE, 'settings-shot:autopost-card'], shotDir: process.env.AUTOPOST_SHOT_DIR });
    assert.equal(done(p)['settings-shot:autopost-card'], true);
    assert.ok(existsSync(path.join(process.env.AUTOPOST_SHOT_DIR, 'autopost-card.png')));
  });
});
