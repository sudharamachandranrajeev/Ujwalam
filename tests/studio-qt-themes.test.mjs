// SPDX-License-Identifier: GPL-3.0-or-later
// Qt studio shell themes (D293), headless probe: every theme pack renders the 1600x900 window without stylesheet
// errors, the saved theme is applied at start, a theme switches live (probe action), Settings > Appearance saves and
// cancels, "reduced" effects remove the depth effects. UJWALAM_THEME_EVIDENCE=<dir> keeps the shots there.
// Skipped when the shell is not built (npm run build:studio) or no Qt kit is configured.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const EVIDENCE = process.env.UJWALAM_THEME_EVIDENCE ? path.resolve(process.env.UJWALAM_THEME_EVIDENCE) : null;
const THEMES = readdirSync(path.join(REPO, 'data', 'themes')).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json').map((f) => f.replace(/\.json$/, ''));

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(EXE, [], {
      windowsHide: true,
      env: { ...process.env, PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}`, UJWALAM_HEADLESS: '1', QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

const pngSize = (f) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

describe('Qt studio themes (headless probe)', { skip }, () => {
  const dirs = [];
  const benches = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ ms = 4500, actions = '', prepare = null, env = {}, shot = null } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtt-')); dirs.push(dataDir);
    if (prepare) prepare(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), limits: { statusPollMs: 50 } });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions, ...(shot ? { UJWALAM_STUDIO_PROBE_SHOT: shot } : {}), ...env });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { ...JSON.parse(m[1]), err: r.err, dataDir };
    } finally { srv.close(); }
  }

  for (const id of THEMES) {
    test(`theme ${id}: renders a 1600x900 shot, applied id reported, no stylesheet errors`, async () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtt-shot-')); dirs.push(tmp);
      const dir = EVIDENCE ?? tmp;
      mkdirSync(dir, { recursive: true });
      const shot = path.join(dir, `${id}.png`);
      const p = await probe({ env: { UJWALAM_THEME: id, ...(EVIDENCE ? { UJWALAM_STUDIO_PROBE_BENCH: '1' } : {}) }, shot, ms: 5000 });
      if (p.bench) { benches.push({ ...p.bench, eligible: p.theme.depthEligible }); writeFileSync(path.join(EVIDENCE, 'repaint-cost.json'), JSON.stringify(benches, null, 2)); }
      assert.equal(p.theme.id, id);
      assert.equal(p.shot, true);
      assert.deepEqual(pngSize(shot), [1600, 900]);
      assert.doesNotMatch(p.err, /Could not parse|Unknown property|stylesheet/i, p.err);
      assert.ok(p.theme.depthWidgets >= 0);
    });
  }

  test('the saved theme and effects (settings.json ui.theme / ui.effects) are applied before the window shows', async () => {
    const p = await probe({ prepare: (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { theme: 'tactical', effects: 'reduced' } })) });
    assert.equal(p.theme.id, 'tactical');
    assert.equal(p.theme.effects, 'reduced');
    assert.equal(p.theme.depthEligible, 0, 'reduced effects: no depth effect on any widget');
    assert.equal(p.theme.depthWidgets, 0);
  });
  test('an unknown saved theme leaves the default (Violet Night)', async () => {
    const p = await probe({ prepare: (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { theme: 'no-such-theme' } })) });
    assert.equal(p.theme.id, 'violet-night');
  });
  test('the default is Violet Night with depth effects on', async () => {
    const p = await probe();
    assert.equal(p.theme.id, 'violet-night');
    assert.equal(p.theme.effects, 'full');
    assert.ok(p.theme.depthEligible > 0, 'cards, round controls or primary buttons would carry an effect');
    for (const id of ['violet-night', 'neon-arcade', 'studio-light', 'tactical', 'retro-wave', 'daylight-blue', 'copper-graphite', 'sand-teal', 'teal-grid']) assert.ok(p.theme.available.includes(id), id);
  });
  test('probe action switches the theme live, an unknown id is refused, effects switch live', async () => {
    const p = await probe({ ms: 6500, actions: 'theme:neon-arcade,theme:nope,effects:reduced,effects:bogus' });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['theme:neon-arcade', true], ['theme:nope', false], ['effects:reduced', true], ['effects:bogus', false]]);
    assert.equal(p.theme.id, 'neon-arcade');
    assert.equal(p.theme.effects, 'reduced');
    assert.equal(p.theme.depthEligible, 0);
  });
  test('Settings > Appearance: sections, a theme card click previews it, Save stores ui.theme and ui.effects', async () => {
    const p = await probe({ ms: 9000, actions: 'settings-open,settings-page:Appearance,settings-theme:retro-wave,settings-reduce-effects:on,settings-save' });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['settings-open', true], ['settings-page:Appearance', true], ['settings-theme:retro-wave', true], ['settings-reduce-effects:on', true], ['settings-save', true]]);
    assert.equal(p.theme.id, 'retro-wave');
    const saved = JSON.parse(readFileSync(path.join(p.dataDir, 'settings.json'), 'utf8'));
    assert.equal(saved.ui.theme, 'retro-wave');
    assert.equal(saved.ui.effects, 'reduced');
  });
  test('Settings > Appearance: Cancel, then Discard in the unsaved-changes question (D332), puts the old look back and saves nothing', async () => {
    const p = await probe({ ms: 9000, actions: 'settings-open,settings-theme:neon-arcade,settings-reduce-effects:on,settings-cancel,settings-unsaved:discard' });
    assert.equal(p.actions.every((a) => a.done), true);
    assert.equal(p.theme.id, 'violet-night');
    assert.equal(p.theme.effects, 'full');
    assert.equal(existsSync(path.join(p.dataDir, 'settings.json')), false);
  });
  // High performance (2026-11-10): any theme drawn flat. The window is shown (offscreen) so hover overlays exist.
  test('High performance: no depth effects, no gradient in the stylesheet, no hover overlays; full mode has them', async () => {
    const full = await probe({ env: { UJWALAM_THEME: 'copper-graphite', UJWALAM_STUDIO_PROBE_SHOW: '1' } });
    assert.equal(full.theme.performance, false);
    assert.equal(full.theme.gradientsInStyle, true, 'Copper Graphite fills cards and buttons with gradients');
    assert.ok(full.theme.depthWidgets > 0 && full.theme.hoverOverlays > 0, JSON.stringify(full.theme));
    const perf = await probe({ env: { UJWALAM_THEME: 'copper-graphite', UJWALAM_EFFECTS: 'performance', UJWALAM_STUDIO_PROBE_SHOW: '1' } });
    assert.equal(perf.theme.id, 'copper-graphite');
    assert.equal(perf.theme.effects, 'performance');
    assert.equal(perf.theme.performance, true);
    assert.equal(perf.theme.gradientsInStyle, false);
    assert.equal(perf.theme.depthWidgets, 0);
    assert.equal(perf.theme.hoverOverlays, 0);
  });
  test('High performance switches live and back (hover overlays return), any theme', async () => {
    const p = await probe({ ms: 7000, actions: 'theme:teal-grid,effects:performance,theme:sand-teal', env: { UJWALAM_STUDIO_PROBE_SHOW: '1' } });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.deepEqual([p.theme.id, p.theme.effects, p.theme.gradientsInStyle, p.theme.hoverOverlays], ['sand-teal', 'performance', false, 0], 'a theme switch keeps the flat mode');
    const back = await probe({ ms: 7000, actions: 'effects:performance,effects:full', env: { UJWALAM_STUDIO_PROBE_SHOW: '1' } });
    assert.equal(back.theme.effects, 'full');
    assert.ok(back.theme.hoverOverlays > 0 && back.theme.depthWidgets > 0, JSON.stringify(back.theme));
  });
  test('High performance on and off in the same event-loop turn: the hover overlays come back (dying ones are not counted as present)', async () => {
    const full = await probe({ env: { UJWALAM_STUDIO_PROBE_SHOW: '1' } });
    const quick = await probe({ ms: 7000, actions: 'effects:performance+full', env: { UJWALAM_STUDIO_PROBE_SHOW: '1' } });
    assert.ok(quick.actions.every((a) => a.done), JSON.stringify(quick.actions));
    assert.equal(quick.theme.effects, 'full');
    assert.ok(quick.theme.hoverOverlays > 0, JSON.stringify(quick.theme));
    // About as many as a fresh start (the count moves by ~2 between runs: a few controls are 0 px wide when first
    // shown). Before the fix, only those few got one: the dying overlays made attachGlow() skip every other control.
    assert.ok(quick.theme.hoverOverlays >= 0.9 * full.theme.hoverOverlays,`every shown control has its overlay again: ${quick.theme.hoverOverlays} vs ${full.theme.hoverOverlays}`);
  });
  test('Settings > Appearance: turning High performance off gives back the Reduce effects choice the user had', async () => {
    const off = await probe({ ms: 9000, actions: 'settings-open,settings-page:Appearance,settings-performance:on,settings-performance:off,settings-save' });
    assert.ok(off.actions.every((a) => a.done), JSON.stringify(off.actions));
    assert.equal(off.theme.effects, 'full', 'Reduce was off before');
    assert.equal(JSON.parse(readFileSync(path.join(off.dataDir, 'settings.json'), 'utf8')).ui?.effects, undefined, 'back where it started: nothing to save (the bug saved "reduced")');
    const on = await probe({ ms: 10000, actions: 'settings-open,settings-page:Appearance,settings-reduce-effects:on,settings-performance:on,settings-performance:off,settings-save' });
    assert.ok(on.actions.every((a) => a.done), JSON.stringify(on.actions));
    assert.equal(JSON.parse(readFileSync(path.join(on.dataDir, 'settings.json'), 'utf8')).ui.effects, 'reduced', 'Reduce was on before');
  });
  test('Settings > Appearance: the High performance switch saves ui.effects "performance"; it is applied at the next start', async () => {
    const p = await probe({ ms: 9000, actions: 'settings-open,settings-page:Appearance,settings-theme:daylight-blue,settings-performance:on,settings-save' });
    assert.deepEqual(p.actions.map((a) => a.done), [true, true, true, true, true]);
    const saved = JSON.parse(readFileSync(path.join(p.dataDir, 'settings.json'), 'utf8'));
    assert.deepEqual([saved.ui.theme, saved.ui.effects], ['daylight-blue', 'performance']);
    const next = await probe({ prepare: (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: saved.ui })) });
    assert.deepEqual([next.theme.id, next.theme.effects, next.theme.depthEligible], ['daylight-blue', 'performance', 0]);
  });
  test('a custom theme file in UJWALAM_THEMES_DIR is listed and can be used; a broken one is ignored', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtt-custom-')); dirs.push(dir);
    const base = JSON.parse(readFileSync(path.join(REPO, 'data', 'themes', 'tactical.json'), 'utf8'));
    writeFileSync(path.join(dir, 'my-theme.json'), JSON.stringify({ ...base, id: 'my-theme', name: 'My Theme', colors: { ...base.colors, accent: '#ff8800' } }));
    writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const p = await probe({ env: { UJWALAM_THEMES_DIR: dir, UJWALAM_THEME: 'my-theme' } });
    assert.equal(p.theme.id, 'my-theme');
    assert.equal(p.theme.custom, true);
    assert.ok(p.theme.available.includes('my-theme') && !p.theme.available.includes('broken'));
  });
});

describe('Qt studio themes: evidence pictures', { skip: skip || (EVIDENCE ? false : 'set UJWALAM_THEME_EVIDENCE=<dir>') }, () => {
  test('Settings > Appearance picture (theme cards)', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtt-ev-'));
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'e'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags: createFlags({ dataDir }), bots: createFakeBots(), limits: { statusPollMs: 50 } });
    const { port } = await srv.listen();
    try {
      mkdirSync(EVIDENCE, { recursive: true });
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: '7000', UJWALAM_STUDIO_PROBE_ACTIONS: 'settings-open,settings-page:Appearance', UJWALAM_STUDIO_PROBE_SHOT: path.join(EVIDENCE, 'appearance.png') });
      assert.equal(r.code, 0, r.err);
      assert.ok(existsSync(path.join(EVIDENCE, 'appearance-settings.png')));
    } finally { srv.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
});
