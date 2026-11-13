// SPDX-License-Identifier: GPL-3.0-or-later
// Settings in the QML studio (plan Q3, D355): the QML twins of the widget studio's Settings tests
// (studio-qt-shell.test.mjs, studio-qt-themes.test.mjs), with the same probe actions (settings-open, settings-page:<title>,
// settings-flag:<id>:on, settings-save ...). Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a
// real UI server and the fake host; the settings land in the test's own data folder. Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const DEFS = JSON.parse(readFileSync(new URL('../data/flags.json', import.meta.url), 'utf8')).flags;

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

describe('QML studio Settings (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe(actions = [], ms = 6000, env = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-set-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({ outputsReady: true });
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 's'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host: fake, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...env });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError)/, 'no QML errors');
      const p = JSON.parse(m[1]);
      const file = path.join(dataDir, 'settings.json');
      return { p, s: p.state, flags, dataDir, saved: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null, out: r.out };
    } finally { srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => p.actions.map((a) => [a.action, a.done]);

  test('nav groups General / Live / Studio / Clips, the pages in them, Advanced last; each flag on its own page, A-Z, plain words only', async () => {
    const { p, s } = await probe(['settings-open', 'settings-section:Advanced']);
    assert.deepEqual(done(p), [['settings-open', true], ['settings-section:Advanced', true]]);
    assert.deepEqual(s.settings.navGroups, ['GENERAL', 'LIVE', 'STUDIO', 'CLIPS'], 'headings are not pages');
    assert.deepEqual(s.settings.sections, ['Appearance', 'Help & tips', 'Stream', 'Transitions', 'Connections', 'Chat & bots', 'Editing', 'Preview', 'Clips', 'Posting & growth', 'Folders', 'Advanced']);
    assert.equal(s.settings.motionChoices, 3, 'Follow Windows / Always on / Off');
    assert.equal(s.settings.motion, 'system');
    assert.equal(s.flagsInSettings, true);
    const rows = s.settings.flagRows;
    assert.equal(rows.length, s.flags.length, 'a row for every flag the server lists');
    for (const r of rows) {
      const f = { ...DEFS.find((x) => x.id === r.id), ...s.flags.find((x) => x.id === r.id) };
      assert.equal(r.on, f.on, r.id);
      assert.equal(r.label, f.label, r.id);
      assert.equal(r.summary, f.summary, `${r.id}: its plain summary is shown`);
      assert.equal(r.page, f.page, r.id);
      assert.doesNotMatch(`${r.label} ${r.summary}`, /\bD\d{2,}\b|[\\/][\w.-]+\.(json|mjs|cpp|md)\b/, `${r.id}: no decision numbers or file paths`);
      if (r.page === 'advanced') assert.equal(r.visible, true, r.id);
    }
    const byPage = (pg) => rows.filter((r) => r.page === pg).map((r) => r.label);
    for (const pg of new Set(rows.map((r) => r.page))) {
      const labels = byPage(pg);
      assert.deepEqual(labels, [...labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), `${pg}: A-Z by name`);
    }
    assert.ok(byPage('advanced').length >= 1 && byPage('clips').length >= 10 && byPage('editing').includes('Layer effects'));
    assert.equal(s.settings.dirty, false, 'nothing changed yet');
    // the window itself: every flag switch shows its label and no flag id or description
    const sw = p.tree.filter((n) => n.name.startsWith('flag:'));
    assert.equal(sw.length, rows.length);
    for (const n of sw) assert.equal(n.text, rows.find((r) => `flag:${r.id}` === n.name).label);
  });

  test('the Settings button opens the window on Clips; the search box narrows the list and picks a shown page', async () => {
    const { p, s } = await probe(['click:settingsBtn', 'settings-search:snap', 'settings-search:zzqq', 'settings-search:'], 7000);
    assert.deepEqual(done(p).map((x) => x[1]), [true, true, true, true]);
    assert.equal(s.settings.query, '');
    assert.equal(s.settings.shownPages.length, 12, 'an empty search shows every page');
    const q = await probe(['click:settingsBtn', 'settings-search:snap'], 6000);
    assert.deepEqual(q.s.settings.shownPages, ['Preview']);
    assert.equal(q.s.settings.page, 'Preview', 'the page follows the search');
    const f = await probe(['click:settingsBtn', 'settings-search:reel hook'], 6000);
    assert.ok(f.s.settings.shownPages.includes('Clips'), 'a feature row\'s words find its page');
    const none = await probe(['click:settingsBtn', 'settings-search:zzqq'], 6000);
    assert.deepEqual(none.s.settings.shownPages, []);
    assert.equal(node(none.p, 'settingsNothing').visible, true);
  });

  test('no sideways scrolling: every page is as wide as its view; the window has its full size', async () => {
    const { p, s } = await probe(['settings-open', 'settings-page:Clips'], 6000);
    assert.ok(s.settings.size[0] >= 900 && s.settings.size[1] >= 700, `Settings is ${s.settings.size} (a window popup sized only to its footer is a regression)`);
    const page = node(p, 'settingsPage:Clips');
    const title = node(p, 'settingsTitle:Clips');
    assert.ok(page && title, 'the Clips page is in the tree');
    const [px, , pw] = page.rect;
    for (const n of p.tree.filter((x) => x.visible && x.rect && x.rect[2] > 0 && /^(reelMin_|reelMax_|hookOn_|settings(Recording|Live|RecordLive|Top3|TransKind))/.test(x.name)))
      assert.ok(n.rect[0] + n.rect[2] <= px + pw + 1, `${n.name} ends inside the page (${n.rect} vs ${page.rect})`);
  });

  test('layer effects on turns flag layer-effects on at Save, no phrase; animations Off is saved as ui.motion', async () => {
    const { p, s, flags, saved } = await probe(['settings-open', 'settings-flag:layer-effects:on', 'settings-motion:off', 'settings-save'], 8000);
    assert.deepEqual(done(p), [['settings-open', true], ['settings-flag:layer-effects:on', true], ['settings-motion:off', true], ['settings-save', true]]);
    assert.equal(flags.isOn('layer-effects'), true, 'applied on Save through the flags route');
    assert.equal(saved.ui.motion, 'off');
    assert.equal(s.motionMode, 'off');
    assert.equal(s.motion, false, 'no animation while the choice is Off');
    assert.equal(s.flagsInSettings, false, 'the window closed on Save');
  });

  test('a real click on a flag switch changes the draft only; Save applies it', async () => {
    const draft = await probe(['settings-open', 'settings-page:Editing', 'click:flag:layer-effects'], 6000);
    assert.equal(draft.s.settings.flagRows.find((r) => r.id === 'layer-effects').on, true);
    assert.equal(draft.s.settings.dirty, true);
    assert.equal(draft.flags.isOn('layer-effects'), false, 'nothing applied before Save');
    const saved = await probe(['settings-open', 'settings-page:Editing', 'click:flag:layer-effects', 'click:settingsSave'], 7000);
    assert.equal(saved.flags.isOn('layer-effects'), true);
  });

  test('Settings > Clips: reel length rows show the defaults, Save sends the changed type, a shortest over the longest blocks Save', async () => {
    const a = await probe(['settings-open', 'settings-page:Clips', 'settings-reel:montage:10:30', 'settings-save'], 8000);
    assert.deepEqual(done(a.p), [['settings-open', true], ['settings-page:Clips', true], ['settings-reel:montage:10:30', true], ['settings-save', true]]);
    assert.deepEqual(a.saved.clips.reelLengths, { montage: { minSec: 10, maxSec: 30 } });
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(Object.keys(q.s.settings.reelLengths.rows).sort(), ['impact-play', 'live-clip', 'match-reel', 'montage', 'short']);
    assert.deepEqual(q.s.settings.reelLengths.rows.montage, { min: 20, max: 60, maxLimit: 60 });
    assert.equal(q.s.settings.reelLengths.error, '');
    assert.equal(node(q.p, 'reelMin_montage').value, 20, 'the box shows the value');
    const r = await probe(['settings-open', 'settings-page:Clips', 'settings-reel:montage:50:40', 'settings-save'], 8000);
    assert.deepEqual(done(r.p).map((x) => x[1]), [true, true, true, false], 'Save refused');
    assert.match(r.s.settings.reelLengths.error, /montage: the shortest \(50 s\) is longer than the longest \(40 s\)/);
    assert.equal(r.s.settings.dirty, true, 'Settings stayed open with the edit');
    assert.equal(r.saved, null, 'nothing saved');
  });

  test('Settings > Clips: reel opening rows show on and 2 s per type, Save sends only the changed type', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(Object.keys(q.s.settings.reelHooks).sort(), ['impact-play', 'live-clip', 'match-reel', 'montage']);
    assert.deepEqual(q.s.settings.reelHooks.montage, { on: true, teaserSec: 2, teaserEnabled: true, min: 1, max: 3 });
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-hook:match-reel:0:3', 'settings-save'], 8000);
    assert.deepEqual(done(p.p).map((x) => x[1]), [true, true, true, true]);
    assert.deepEqual(p.saved.clips.reelHooks, { 'match-reel': { on: false, teaserSec: 3 } });
  });

  test('Settings > Clips: Transition between pieces shows Cross fade 250 ms (150-500); Save sends the choice; Cut saves no length', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(q.s.settings.reelTransition, { kind: 'fade', label: 'Cross fade', ms: 250, msEnabled: true, min: 150, max: 500 });
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-transition:fade:400', 'settings-save'], 8000);
    assert.deepEqual(p.saved.clips.reelTransition, { kind: 'fade', ms: 400 });
    const c = await probe(['settings-open', 'settings-page:Clips', 'settings-transition:cut:0', 'settings-save'], 8000);
    assert.deepEqual(c.saved.clips.reelTransition, { kind: 'cut', ms: 0 });
  });

  test('Settings > Clips: Record while live is a switch row with its explanation, on by default; off is saved at Save', async () => {
    const p = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(p.s.settings.recordLive, { on: true, text: 'Record while live', visible: true,
      hint: 'Records the stream (H and V) to your recordings folder so reels can be made after it ends. Uses about 10 GB per hour.' });
    assert.equal(node(p.p, 'settingsRecordLive').checked, true);
    assert.equal(p.s.settings.dirty, false);
    const draft = await probe(['settings-open', 'click:settingsRecordLive']);
    assert.deepEqual([draft.s.settings.recordLive.on, draft.s.settings.dirty], [false, true], 'a draft until Save (D332)');
    const saved = await probe(['settings-open', 'settings-record-live:off', 'settings-save'], 8000);
    assert.equal(saved.saved.clips.recordLive, false);
  });

  test('Settings > Appearance: a theme card click previews it, Save stores ui.theme and ui.effects', async () => {
    const p = await probe(['settings-open', 'settings-page:Appearance', 'click:themeCard:retro-wave', 'settings-reduce-effects:on', 'settings-save'], 9000);
    assert.deepEqual(done(p.p).map((x) => x[1]), [true, true, true, true, true]);
    assert.equal(p.p.theme, 'retro-wave');
    assert.equal(p.saved.ui.theme, 'retro-wave');
    assert.equal(p.saved.ui.effects, 'reduced');
  });

  test('Settings > Appearance: Cancel, then Discard in the unsaved-changes question, puts the old look back and saves nothing', async () => {
    const p = await probe(['settings-open', 'settings-theme:neon-arcade', 'settings-reduce-effects:on', 'settings-cancel', 'settings-unsaved:discard'], 9000);
    assert.equal(p.p.actions.every((a) => a.done), true, JSON.stringify(p.p.actions));
    assert.equal(p.p.theme, 'violet-night');
    assert.equal(p.s.effects, 'full');
    assert.equal(p.saved, null);
    assert.equal(p.s.flagsInSettings, false);
  });

  test('unsaved question: Cancel keeps Settings open with the edit; Save changes saves it', async () => {
    const k = await probe(['settings-open', 'settings-snap:on', 'settings-cancel', 'settings-unsaved:cancel']);
    assert.deepEqual([k.s.flagsInSettings, k.s.settings.dirty, k.s.settings.unsavedOpen], [true, true, false]);
    const s = await probe(['settings-open', 'settings-snap:on', 'settings-cancel', 'settings-unsaved:save'], 8000);
    assert.equal(s.saved.ui.snap, true);
    assert.equal(s.s.flagsInSettings, false);
  });

  test('High performance: turning it off gives back the Reduce effects choice the user had; it saves ui.effects "performance"', async () => {
    const b = await probe(['settings-open', 'settings-reduce-effects:on', 'settings-performance:on', 'settings-performance:off']);
    assert.equal(b.s.settings.effects, 'reduced');
    const p = await probe(['settings-open', 'settings-performance:on', 'settings-save'], 8000);
    assert.equal(p.saved.ui.effects, 'performance');
  });

  test('Folders: a typed folder is saved; Default saves none', async () => {
    const dir = path.join(os.tmpdir(), 'ujw-recordings');
    const p = await probe(['settings-open', 'settings-page:Folders', `type:folderRecordings=${dir}`, 'settings-save'], 8000);
    assert.equal(p.saved.folders.recordings, dir);
    assert.equal(p.saved.folders.clips, null);
  });

  test('Save sends what the widget sends: the reel keys and other ui keys only when they changed', async () => {
    const p = await probe(['settings-open', 'settings-snap:on', 'settings-save'], 8000);
    for (const k of ['reelLengths', 'reelHooks', 'reelTransition']) assert.equal(p.saved.clips[k], undefined, k);
    assert.deepEqual([typeof p.saved.clips.recording, typeof p.saved.clips.live], ['string', 'string'], 'both modes, always');
    assert.deepEqual(p.saved.ui, { snap: true });
  });
});
