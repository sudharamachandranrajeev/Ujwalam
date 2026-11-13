// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Posting & growth > Auto-post in the QML studio (plan Q3, slice 4): the QML twin of studio-qt-autopost.test.mjs
// (defaults, quota fit, next posting times each saying Scheduled, flags, edits, no kind blocks Save, Save writes the user's
// files in the data folder), plus the card's own rules: Move and Remove act on their own click, Save sends nothing when
// nothing changed, Cancel / the unsaved question, no sideways scrolling and plain words. Same probe actions as the widget
// (settings-open, settings-page, ap-upload, ap-kind, ap-score, ap-perday, ap-gap, ap-days, ap-placement, ap-quota,
// ap-refresh, ap-move, ap-remove). Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a real UI
// server and the fake host, temp data dir, no network. Skipped when the shell is not built.
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
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { userRulesFile } from '../services/posting/auto-post.mjs';
import { userScheduleFile } from '../services/posting/schedule.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const NOW = Date.parse('2026-11-13T10:00:00Z');

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

describe('QML studio Settings > Posting & growth > Auto-post (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 700), flagIds = ['posting', 'auto-post', 'post-schedule'] } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlap-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of flagIds) flags.set(id, true);
    const queueFile = path.join(dataDir, 'posting', QUEUE_NAME);
    const q = createUploadQueue(queueFile, () => NOW);
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
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, ap: p.state.settings?.postingPage, dataDir, item: () => createUploadQueue(queueFile).get('clip1') };
    } finally { await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const PAGE_NAMES = /^autopost/;
  const PAGE = 'settings-page:Posting%20%26%20growth';
  const open = ['settings-open', PAGE];
  // the state of a change shows on the next probe; a quiet action gives the page its turn
  const WAIT = [PAGE];
  const exists = (f) => existsSync(f);

  // ---- twin of studio-qt-autopost.test.mjs ----
  test('the card shows the defaults, the quota fit and the next posting times, each saying Scheduled', async () => {
    const { ap, s } = await probe({ actions: [...open, ...WAIT] });
    assert.ok(ap, 'the card is on the page');
    assert.equal(ap.loaded, true);
    assert.equal(ap.dirty, false);
    assert.equal(s.settings.dirty, false);
    assert.deepEqual(ap.card, { autoUpload: true, kinds: ['short', 'montage', 'won-reel', 'impact-play'], minScore: 3, maxPerDay: 6, intervalHours: 1, maxAheadDays: 60, placement: 'fill-gaps', quotaUnitsPerDay: 10000 });
    assert.match(ap.fit, /About 6 uploads a day fit/);
    assert.match(ap.flags, /Auto post and Scheduled posting are on/);
    assert.match(ap.flags, /stay in the clips folder/);
    assert.ok(ap.times.length >= 11, ap.times.join(' | '));
    assert.match(ap.times[0], /queued clip, scheduled/);
    assert.ok(ap.times.slice(1).every((t) => /Scheduled/.test(t)), ap.times.join(' | '));
    assert.match(ap.timesInfo, /not been read yet/);
  });

  test('flags off: the card says nothing uploads by itself; with the posting flag off there is no card', async () => {
    let r = await probe({ actions: [...open, ...WAIT], flagIds: ['posting'] });
    assert.match(r.ap.flags, /Nothing uploads by itself until Auto post and Scheduled posting are switched on/);
    r = await probe({ actions: [...open, ...WAIT], flagIds: [] });
    assert.equal(r.ap, null);
    assert.equal(node(r.p, 'autopostUpload')?.visible ?? false, false);
    assert.match(node(r.p, 'settingsLead:Posting & growth').text, /^Posts are reviewed in the Posts window, in the More menu, once Posts window is switched on below\.$/);
  });

  test('edits make the dialog dirty; no kind at all blocks Save with a plain note and keeps Settings open', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'ap-gap:6', 'ap-perday:9', 'ap-kind:short:off', 'ap-kind:montage:off', 'ap-kind:won-reel:off', 'ap-kind:impact-play:off', ...WAIT, 'settings-save'] });
    const d = done(r.p);
    for (const a of ['ap-gap:6', 'ap-perday:9', 'ap-kind:short:off', 'ap-kind:impact-play:off']) assert.equal(d[a], true, a);
    assert.equal(d['settings-save'], false, 'Save is refused');
    assert.equal(r.ap.dirty, true);
    assert.equal(r.s.settings.dirty, true);
    assert.equal(r.s.flagsInSettings, true, 'Settings stays open on the card');
    assert.equal(r.s.settings.page, 'Posting & growth');
    assert.match(r.ap.problem, /at least one kind/);
    assert.equal(node(r.p, 'autopostProblem').visible, true);
    assert.match(r.ap.fit, /More than that a day stop at the quota/);
    assert.match(r.s.note, /^Not saved: Settings > Posting & growth > Auto-post needs at least one kind of clip\.$/);
    assert.equal(exists(userRulesFile(r.dataDir)), false, 'nothing written');
  });

  test('a quota below one upload: the card says plainly that nothing uploads', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'ap-quota:1000', ...WAIT] });
    assert.equal(done(r.p)['ap-quota:1000'], true);
    assert.match(r.ap.fit, /No upload fits in a quota of 1,?000 units a day \(one upload needs 1,?750\): nothing uploads until the quota is raised/);
  });

  test('Save writes the user files in the data folder (one click, no question)', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'ap-gap:6', 'ap-kind:impact-play:off', 'ap-placement:after-last', ...WAIT, 'settings-save'], ms: 12000 });
    assert.ok(Object.values(done(r.p)).every(Boolean), JSON.stringify(r.p.actions));
    const sched = JSON.parse(readFileSync(userScheduleFile(r.dataDir), 'utf8'));
    assert.equal(sched.intervalHours, 6);
    assert.equal(sched.placement, 'after-last');
    assert.equal(sched.maxAheadDays, 60);
    const rules = JSON.parse(readFileSync(userRulesFile(r.dataDir), 'utf8'));
    assert.deepEqual(rules.rules[0].kinds, ['short', 'montage', 'won-reel']);
    assert.equal(rules.maxUploadsPerDay, 6);
    assert.equal(r.s.flagsInSettings, false, 'Settings closed');
    assert.match(r.s.note, /Settings saved\.|Auto-post settings saved; the next upload pass uses them\./);
  });

  // ---- the card's own rules ----
  test('every value is edited and refused out of its range; unknown kinds and placements are refused', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'ap-upload:off', 'ap-score:50', 'ap-perday:2', 'ap-gap:99', 'ap-days:5', 'ap-quota:20000', 'ap-placement:after-last',
      'ap-kind:nope:on', 'ap-placement:nope', ...WAIT] });
    const d = done(r.p);
    assert.equal(d['ap-kind:nope:on'], false);
    assert.equal(d['ap-placement:nope'], false);
    assert.deepEqual(r.ap.card, { autoUpload: false, kinds: ['short', 'montage', 'won-reel', 'impact-play'], minScore: 50, maxPerDay: 2, intervalHours: 48, maxAheadDays: 5, placement: 'after-last', quotaUnitsPerDay: 20000 });
    assert.equal(r.ap.dirty, true);
    assert.equal(node(r.p, 'autopostUpload').checked, false);
    assert.equal(node(r.p, 'autopostPlacement').text, 'Always after the last scheduled post');
    assert.equal(node(r.p, 'autopostKind_short').checked, true);
  });

  test('a change put back to what was loaded is no change', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'ap-gap:6', 'ap-kind:short:off', ...WAIT, 'ap-gap:1', 'ap-kind:short:on', ...WAIT] });
    assert.equal(r.ap.dirty, false);
    assert.equal(r.s.settings.dirty, false);
  });

  test('Move and Remove act on their own click: the queued clip moves, then is taken out of the queue', async () => {
    const mv = await probe({ actions: [...open, ...WAIT, 'ap-move:clip1:2026-11-13T20:00:00Z', ...WAIT, ...WAIT] });
    assert.equal(done(mv.p)['ap-move:clip1:2026-11-13T20:00:00Z'], true);
    assert.match(mv.ap.message, /^Moved to .+\.$/);
    assert.equal(mv.item().publishAt, '2026-11-13T20:00:00.000Z');
    assert.equal(mv.s.settings.dirty, false, 'moving changes no setting');
    assert.ok(node(mv.p, 'autopostMove:clip1')?.visible, 'a queued clip has Move and Remove buttons');
    const bad = await probe({ actions: [...open, ...WAIT, 'ap-move:nope:2026-11-13T20:00:00Z', ...WAIT] });
    assert.match(bad.ap.message, /^Not moved: /);
    assert.equal(bad.item().publishAt, '2026-11-13T12:00:00.000Z', 'unchanged');
    const rm = await probe({ actions: [...open, ...WAIT, 'ap-remove:clip1', ...WAIT, ...WAIT] });
    assert.equal(rm.ap.message, 'Taken out of the upload queue.');
    assert.equal(rm.item().state, 'removed');
    const again = await probe({ actions: [...open, ...WAIT, 'ap-remove:nope', ...WAIT] });
    assert.match(again.ap.message, /^Not removed: /);
  });

  test('Check the channel again reads the channel (no network here: the card says so in plain words)', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'ap-refresh', ...WAIT, ...WAIT] });
    assert.equal(done(r.p)['ap-refresh'], true);
    assert.match(r.ap.timesInfo, /Could not read the channel/);
    assert.ok(node(r.p, 'autopostRefresh')?.visible);
  });

  test('flags on: no sideways scrolling, plain words only (no decision numbers, no file paths), every control inside the page', async () => {
    const r = await probe({ actions: [...open, ...WAIT] });
    const page = node(r.p, 'settingsPage:Posting & growth');
    assert.ok(page && page.visible);
    const [px, , pw] = page.rect;
    const mine = r.p.tree.filter((x) => x.visible && x.rect && x.rect[2] > 0 && PAGE_NAMES.test(x.name));
    assert.ok(mine.length >= 12, `${mine.length} named controls on the page`);
    for (const n of mine) assert.ok(n.rect[0] >= px - 1 && n.rect[0] + n.rect[2] <= px + pw + 1, `${n.name} ends inside the page (${n.rect} vs ${page.rect})`);
    const words = r.p.tree.filter((x) => (PAGE_NAMES.test(x.name) || /^settings(Title|Lead|Note):Posting & growth$/.test(x.name)) && typeof x.text === 'string').map((x) => x.text).join('\n');
    assert.match(words, /Upload clips automatically/);
    assert.match(words, /Check the channel again/);
    assert.doesNotMatch(words, /\bD\d{2,}\b|[\\/][\w.-]+\.(json|mjs|cpp|md)\b/, 'no decision numbers or file paths in the words');
  });

  // ---- Save / Cancel / the unsaved question ----
  test('with nothing changed, Save writes no rules or schedule file', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'settings-save'] });
    assert.equal(r.s.flagsInSettings, false, 'Settings closed');
    assert.equal(exists(userRulesFile(r.dataDir)), false);
    assert.equal(exists(userScheduleFile(r.dataDir)), false);
  });

  test('Cancel with a card change asks Save changes / Discard / Cancel; Discard writes nothing, Save changes writes it', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'ap-gap:6', ...WAIT, 'settings-cancel', 'settings-unsaved:discard'], ms: 12000 });
    assert.equal(done(r.p)['settings-cancel'], true);
    assert.equal(r.s.flagsInSettings, false);
    assert.equal(exists(userScheduleFile(r.dataDir)), false, 'nothing written');
    const k = await probe({ actions: [...open, ...WAIT, 'ap-gap:6', ...WAIT, 'settings-cancel'] });
    assert.deepEqual([k.s.settings.unsavedOpen, k.s.settings.dirty], [true, true]);
    const sv = await probe({ actions: [...open, ...WAIT, 'ap-gap:6', ...WAIT, 'settings-cancel', 'settings-unsaved:save'], ms: 12000 });
    assert.equal(JSON.parse(readFileSync(userScheduleFile(sv.dataDir), 'utf8')).intervalHours, 6, 'Save changes writes it');
  });
});
