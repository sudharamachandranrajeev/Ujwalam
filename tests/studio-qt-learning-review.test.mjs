// SPDX-License-Identifier: GPL-3.0-or-later
// LL3 (D340): Review reads beside My clips in the Qt studio shell (headless probe, real UI server, fake host). Flag
// learning-review off (the default): no button, nothing written. On, with queued items (synthetic fixtures): the button
// shows the count, the window lists the items with the pack's answers, and Confirm writes one "confirmed" label row.
// Skipped when the shell is not built. Never shows a window (UJWALAM_HEADLESS=1, offscreen).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const S = 'live-20261111-120000';

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
  const dir = path.join(dataDir, 'learning-store', S);
  mkdirSync(path.join(dir, 'frames'), { recursive: true });
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ v: 1, createdAt: '2026-11-11T12:00:00.000Z' }));
  const items = [
    { v: 1, id: 'live-00001', at: '2026-11-11T12:10:00.000Z', t: 600, kind: 'unclassified-banner', detector: 'W1', label: 'VICTORY', mode: 'mp', ocrScore: 0.97, threshold: null, value: null, choices: ['round', 'match', 'not a banner'], frame: null },
    { v: 1, id: 'mode-002', at: '2026-11-11T13:00:00.000Z', t: 740, kind: 'unknown-mode', detector: null, label: null, mode: 'mp', ocrScore: null, threshold: null, value: null, choices: ['domination', 'hardpoint'], match: 2, frame: null, modeReason: 'no mode evidence', modeEvidence: [] },
  ];
  writeFileSync(path.join(dir, 'review.jsonl'), `${items.map((x) => JSON.stringify(x)).join('\n')}\n`);
  return dir;
}

describe('Qt studio: Review reads (LL3, D340)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ flagOn, actions, ms = 9000 }) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtlr-')); dirs.push(dataDir);
    const storeDir = seed(dataDir);
    const flags = createFlags({ dataDir });
    if (flagOn) flags.set('learning-review', true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      const lf = path.join(storeDir, 'labels.jsonl');
      return { p: JSON.parse(m[1]), labels: existsSync(lf) ? readFileSync(lf, 'utf8').trim().split('\n').map((x) => JSON.parse(x)) : [] };
    } finally { await srv.close(); }
  }

  test('flag off: no Review reads button, and the window cannot list anything', async () => {
    const r = await probe({ flagOn: false, actions: ['review-open', 'review-confirm:0'] });
    assert.equal(r.p.shown.review, false);
    assert.equal(r.p.review.items, 0, 'the server refuses the list while the flag is off');
    assert.equal(r.p.actions[1].done, false);
    assert.deepEqual(r.labels, []);
  });

  test('flag on: the button shows, the window lists both items, Confirm writes one confirmed label', async () => {
    const r = await probe({ flagOn: true, actions: ['review-open', 'review-confirm:1'] });
    assert.equal(r.p.shown.review, true);
    assert.deepEqual(r.p.actions.map((a) => a.done), [true, true]);
    assert.equal(r.p.review.items, 1, 'the confirmed item left the list');
    assert.equal(r.labels.length, 1);
    assert.deepEqual({ action: r.labels[0].action, source: r.labels[0].source, ref: r.labels[0].ref },
      { action: 'confirmed', source: 'review', ref: { item: 'live-00001', kind: 'unclassified-banner', detector: 'W1', label: 'VICTORY', value: 'match', corrected: true } });
    assert.deepEqual(r.p.review.choices, ['domination', 'hardpoint'], 'the next item and its answers are shown');
  });
});
