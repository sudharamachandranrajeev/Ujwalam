// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Transitions in the QML studio (plan Q3, slice 3): the QML twin of the widget TransitionsPage test in
// studio-qt-d327.test.mjs (easing per canvas saved into the project, Force complete calls the host), plus the page's own
// rules: the portrait canvas mirrors the main one, nothing changes while live (Force complete still works), the flags,
// Save / Cancel / the unsaved question, no sideways scrolling and plain words. Same probe actions as the widget (settings-open,
// settings-page:Transitions, tr-type, tr-ease, tr-ms, tr-mirror, tr-force). Headless probe (UJWALAM_HEADLESS=1, offscreen,
// never on a screen) against a real UI server and the fake host. Skipped when the shell is not built.
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

describe('QML studio Settings > Transitions (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 700), flagsOn = ['stream-settings', 'transitions'], live = false } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-tr-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of flagsOn) flags.set(id, true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    if (live) await fake.call('stream.start', {});
    const calls = [];
    const host = { describe: () => fake.describe(), call: (m, p) => { if (!['host.status', 'outputs.status'].includes(m)) calls.push([m, p]); return fake.call(m, p); } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      const doc = () => JSON.parse(readFileSync(file, 'utf8'));
      return { p, s: p.state, tp: p.state.settings?.transitionsPage, file, doc, calls };
    } finally { await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const PAGE_NAMES = /^(tr(Type|Ease|Ms|Force):|transitions(Mirror|Status))/;
  const open = ['settings-open', 'settings-page:Transitions'];
  // the state of a change shows on the next probe; a quiet action gives the page its turn
  const WAIT = ['settings-page:Transitions'];
  const canvasOf = (doc, id) => doc.canvases.find((c) => c.id === id).transition ?? { type: 'cut' };

  // ---- twin of studio-qt-d327.test.mjs ----
  test('Settings > Transitions: easing per canvas saved into the project; Force complete calls the host', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'tr-type:h:fade', ...WAIT, 'tr-ease:h:in-out-cubic', 'tr-ms:h:800', 'tr-mirror:on', 'tr-force:h', ...WAIT], ms: 12000 });
    const d = done(r.p);
    assert.equal(d['settings-page:Transitions'], true);
    assert.equal(d['tr-type:h:fade'], true, JSON.stringify(r.p.actions));
    assert.equal(d['tr-ease:h:in-out-cubic'], true, JSON.stringify(r.p.actions));
    assert.equal(d['tr-ms:h:800'], true);
    assert.ok(r.tp.h.easingChoices >= 20, `${r.tp.h.easingChoices} easings`);
    assert.equal(r.tp.mirror, true);
    assert.match(r.tp.forced, /^h:(completed|idle)$/);
    assert.deepEqual(r.calls.find(([m]) => m === 'transitions.forceComplete'), ['transitions.forceComplete', { canvas: 'H' }]);
    assert.equal(r.s.settings.dirty, true, 'a change makes the window ask before it closes');
    // Save (a second run, as the widget twin does)
    const s = await probe({ actions: [...open, ...WAIT, 'tr-type:h:fade', ...WAIT, 'tr-ease:h:in-out-cubic', 'tr-ms:h:800', 'tr-mirror:on', 'settings-save'], ms: 12000 });
    const doc = s.doc();
    assert.deepEqual(canvasOf(doc, 'h'), { type: 'fade', durationMs: 800, easing: 'in-out-cubic' });
    assert.deepEqual(canvasOf(doc, 'v'), { type: 'fade', durationMs: 800, easing: 'in-out-cubic', mirror: true });
    assert.equal(s.s.flagsInSettings, false, 'Settings closed');
    assert.match(s.s.note, /Settings saved\.|Transitions saved; the host follows within a few seconds\./);
  });

  // ---- the page's own rules (the widget's TransitionsPage) ----
  test('the page loads the project: both canvases, plenty of easings, easing and duration only for a fade, no stinger in the Type list', async () => {
    const r = await probe({ actions: [...open, ...WAIT] });
    assert.equal(r.tp.loaded, true);
    assert.ok(r.tp.h.easingChoices >= 20 && r.tp.v.easingChoices >= 20);
    assert.equal(r.tp.mirror, false);
    assert.equal(r.tp.h.easingEnabled, r.tp.h.type === 'fade', 'easing follows the type');
    assert.equal(r.s.settings.dirty, false, 'nothing changed, nothing to save');
    for (const n of ['trType:h', 'trEase:h', 'trMs:h', 'trForce:h', 'trType:v', 'trEase:v', 'trMs:v', 'trForce:v', 'transitionsMirror']) assert.ok(node(r.p, n)?.visible, n);
    const f = await probe({ actions: [...open, ...WAIT, 'tr-type:h:fade', ...WAIT] });
    assert.equal(f.tp.h.type, 'fade');
    assert.equal(f.tp.h.easingEnabled, true, 'a fade has an easing');
    assert.equal(node(f.p, 'trEase:h').enabled, true);
    assert.equal(node(f.p, 'trMs:h').enabled, true);
    const bad = await probe({ actions: [...open, ...WAIT, 'tr-type:h:stinger', 'tr-type:h:nope', 'tr-ease:h:nope'] });
    const bd = done(bad.p);
    assert.deepEqual([bd['tr-type:h:stinger'], bd['tr-type:h:nope'], bd['tr-ease:h:nope']], [false, false, false], 'a stinger is set in the main window; unknown values are refused');
    assert.equal(bad.s.settings.dirty, false);
  });

  test('Mirror main canvas transitions: the portrait canvas follows the main one and its boxes switch off; off gives them back', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'tr-type:h:fade', ...WAIT, 'tr-type:v:fade', ...WAIT, 'tr-mirror:on', ...WAIT] });
    assert.equal(r.tp.mirror, true);
    assert.equal(node(r.p, 'transitionsMirror').checked, true);
    assert.equal(node(r.p, 'trType:v').enabled, false, 'the portrait type follows the main canvas');
    assert.equal(node(r.p, 'trEase:v').enabled, false);
    assert.equal(node(r.p, 'trMs:v').enabled, false);
    assert.equal(node(r.p, 'trType:h').enabled, true, 'the main canvas stays editable');
    const off = await probe({ actions: [...open, ...WAIT, 'tr-mirror:on', ...WAIT, 'tr-mirror:off', ...WAIT] });
    assert.equal(off.tp.mirror, false);
    assert.equal(node(off.p, 'trType:v').enabled, true);
    assert.equal(off.s.settings.dirty, false, 'back to what was loaded');
  });

  test('Force complete on the portrait canvas calls the host for V; the page says what happened', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'tr-force:v', ...WAIT] });
    assert.equal(done(r.p)['tr-force:v'], true);
    assert.match(r.tp.forced, /^v:(completed|idle)$/);
    assert.deepEqual(r.calls.find(([m]) => m === 'transitions.forceComplete'), ['transitions.forceComplete', { canvas: 'V' }]);
    assert.match(r.tp.status, /The running transition was completed\.|No transition was running on that canvas\./);
    assert.equal(r.s.settings.dirty, false, 'Force complete changes no setting');
  });

  test('live: nothing can be changed (boxes off, probe refused, Save writes nothing); Force complete still works', async () => {
    const r = await probe({ live: true, actions: [...open, ...WAIT, ...WAIT, 'tr-type:h:fade', 'tr-mirror:on', 'tr-force:h', ...WAIT, 'settings-save'], ms: 12000 });
    const d = done(r.p);
    assert.equal(d['tr-type:h:fade'], false, 'refused while live');
    assert.equal(d['tr-mirror:on'], false);
    assert.equal(d['tr-force:h'], true, 'Force complete works any time');
    assert.ok(r.calls.some(([m]) => m === 'transitions.forceComplete'));
    const l = await probe({ live: true, actions: [...open, ...WAIT, ...WAIT] });
    assert.equal(l.tp.live, true);
    assert.equal(l.s.settings.dirty, false);
    const doc = r.doc();
    assert.equal(canvasOf(doc, 'h').type, 'cut', 'the project is unchanged');
  });

  test('flag transitions off: the page says which switch to turn on and shows no transition settings', async () => {
    const r = await probe({ flagsOn: ['stream-settings'], actions: ['settings-open', 'settings-page:Transitions'] });
    assert.match(node(r.p, 'settingsLead:Transitions').text, /^Switch on .+ below and click Save to use these settings\.$/);
    assert.equal(r.s.settings.transitionsPage, null);
    assert.equal(node(r.p, 'trType:h').visible, false);
    assert.equal(r.s.settings.dirty, false);
  });

  test('flag stream-settings off: the page names it and says where to switch it on', async () => {
    const r = await probe({ flagsOn: ['transitions'], actions: ['settings-open', 'settings-page:Transitions'] });
    assert.match(node(r.p, 'settingsLead:Transitions').text, /^These settings also need .+: switch it on in Settings > Stream and click Save\.$/);
    assert.equal(r.s.settings.transitionsPage, null);
    assert.equal(node(r.p, 'trType:h').visible, false);
  });

  test('flags on: no sideways scrolling, plain words only (no decision numbers, no file paths), every control inside the page', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'tr-force:h', ...WAIT] });
    const page = node(r.p, 'settingsPage:Transitions');
    assert.ok(page && page.visible);
    const [px, , pw] = page.rect;
    const mine = r.p.tree.filter((x) => x.visible && x.rect && x.rect[2] > 0 && PAGE_NAMES.test(x.name));
    assert.ok(mine.length >= 9, `${mine.length} named controls on the page`);
    for (const n of mine) assert.ok(n.rect[0] >= px - 1 && n.rect[0] + n.rect[2] <= px + pw + 1, `${n.name} ends inside the page (${n.rect} vs ${page.rect})`);
    const words = r.p.tree.filter((x) => (PAGE_NAMES.test(x.name) || /^settings(Title|Lead|Note):Transitions$/.test(x.name)) && typeof x.text === 'string').map((x) => x.text).join('\n');
    assert.match(words, /Force complete transition/);
    assert.doesNotMatch(words, /\bD\d{2,}\b|[\\/][\w.-]+\.(json|mjs|cpp|md)\b|\btransitions\b-?flag/, 'no decision numbers or file paths in the words');
  });

  // ---- Save / Cancel / the unsaved question ----
  test('with nothing changed, Save sends no transition to the host', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'settings-save'] });
    assert.equal(r.s.flagsInSettings, false, 'Settings closed');
    assert.ok(!r.calls.some(([m]) => /transition/i.test(m) && m !== 'transitions.forceComplete'), JSON.stringify(r.calls));
  });

  test('Cancel with a Transitions change asks Save changes / Discard / Cancel; Discard saves nothing', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'tr-type:h:fade', ...WAIT, 'settings-cancel', 'settings-unsaved:discard'], ms: 12000 });
    assert.equal(done(r.p)['settings-cancel'], true);
    assert.equal(r.s.flagsInSettings, false);
    assert.equal(canvasOf(r.doc(), 'h').type, 'cut', 'nothing written');
    const k = await probe({ actions: [...open, ...WAIT, 'tr-type:h:fade', ...WAIT, 'settings-cancel'] });
    assert.deepEqual([k.s.settings.unsavedOpen, k.s.settings.dirty], [true, true]);
    const sv = await probe({ actions: [...open, ...WAIT, 'tr-type:h:fade', ...WAIT, 'settings-cancel', 'settings-unsaved:save'], ms: 12000 });
    assert.equal(canvasOf(sv.doc(), 'h').type, 'fade', 'Save changes writes it');
  });
});
