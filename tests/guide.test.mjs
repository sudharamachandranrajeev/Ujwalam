// SPDX-License-Identifier: GPL-3.0-or-later
// Tips, tour and help (D294 proposed): the data files (schema, anchors, plain words), the ui.guide settings
// (checks, defaults, merging, file round trip) and the UI server routes (GET ui/api/guide, POST ui/api/settings
// with ui.guide, allowed while live without a task or toast). The Qt side is tested in studio-qt-shell.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { DEFAULTS, GUIDE_DEFAULTS, GUIDE_MAX_IDS, guideOnly, guideProblems, readSettings, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const readJson = (f) => JSON.parse(readFileSync(path.join(REPO, f), 'utf8'));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-guide-'));

// Anchor names the studio window registers (app/studio/src/main_window.cpp, "guide_->anchor"), plus names other
// branches may add; a data file may only use these.
const ANCHORS = new Set(['scenes', 'layers', 'layerAdd', 'previewH', 'previewV', 'look', 'mixer', 'ctlStream', 'ctlRecord', 'ctlClip', 'ctlMark',
  'chips', 'chipClips', 'taskChip', 'taskBar', 'myClips', 'settings', 'more', 'help']);

describe('data/guide/*.json', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(readJson('data/guide/guide.schema.json'));
  const tour = readJson('data/guide/tour.json');
  const hints = readJson('data/guide/hints.json');

  test('tour.json and hints.json match the schema', () => {
    assert.ok(validate(tour), JSON.stringify(validate.errors));
    assert.ok(validate(hints), JSON.stringify(validate.errors));
  });
  test('the schema refuses the usual mistakes', () => {
    const bad = [
      { ...tour, tours: [{ id: 'Bad Id', title: 'x y', steps: tour.tours[0].steps }] },
      { ...tour, tours: [{ id: 'a', title: 'ab', steps: [] }] },
      { ...tour, tours: [{ id: 'a', title: 'ab', steps: [{ id: 'a', anchor: 'x', title: 'ab', text: 'too short' }] }] },
      { ...tour, extra: 1 },
      { ...hints, hints: [{ ...hints.hints[0], trigger: 'whenever' }] },
      { ...hints, hints: [{ ...hints.hints[0], id: 'x'.repeat(41) }] },
    ];
    for (const b of bad) assert.equal(validate(b), false, JSON.stringify(b).slice(0, 100));
  });
  test('ids are unique; every anchor is a name the window registers; the welcome tour and two focused tours exist', () => {
    assert.deepEqual(tour.tours.map((t) => t.id), ['welcome', 'clips', 'posting']);
    const ids = [...tour.tours.flatMap((t) => t.steps.map((s) => s.id)), ...hints.hints.map((h) => h.id)];
    assert.equal(new Set(ids).size, ids.length, 'step and hint ids are unique (they share one dismissed list)');
    for (const t of tour.tours) assert.equal(new Set(t.steps.map((s) => s.id)).size, t.steps.length);
    for (const a of [...tour.tours.flatMap((t) => t.steps.map((s) => s.anchor)), ...hints.hints.map((h) => h.anchor)]) assert.ok(ANCHORS.has(a), `unknown anchor ${a}`);
    assert.equal(new Set(hints.hints.map((h) => h.trigger)).size, hints.hints.length, 'one hint per trigger');
  });
  test('the welcome tour covers what the request lists', () => {
    const anchors = tour.tours[0].steps.map((s) => s.anchor);
    for (const a of ['scenes', 'layers', 'layerAdd', 'previewH', 'previewV', 'look', 'mixer', 'ctlStream', 'ctlRecord', 'ctlClip', 'ctlMark', 'chips', 'taskBar', 'myClips', 'settings']) assert.ok(anchors.includes(a), a);
  });
  test('plain words: no jargon, no decision numbers, no names or paths', () => {
    const all = JSON.stringify([tour.tours, hints.hints].flat());
    for (const bad of [/\bD\d{3}\b/, /\bAPI\b/, /\bJSON\b/, /\blibobs\b/i, /\bOBS\b/, /\bGPU\b/, /\bflag\b/i, /\bhost\b/i, /[A-Za-z]:\\\\/, /\.(mjs|cpp|json)\b/]) assert.doesNotMatch(all, bad, String(bad));
  });
  test('the posting help does not claim more than exists', () => {
    const cpp = readFileSync(path.join(REPO, 'app/studio/src/help_panel.cpp'), 'utf8');
    assert.match(cpp, /sends nothing/);
    assert.match(cpp, /private video/);
    assert.match(cpp, /There is no switch for it in this window yet/);
    assert.match(cpp, /You upload those yourself/);
    const rules = readJson('data/posting/auto-post-rules.json');
    assert.deepEqual(rules.rules, [], 'the help says the rule list is empty');
    assert.equal(rules.autoUpload, false);
    const flags = readJson('data/flags.json').flags;
    assert.equal(flags.find((f) => f.id === 'posting').default, false);
    assert.equal(flags.find((f) => f.id === 'auto-post').default, false);
  });
});

describe('ui.guide in settings.json', () => {
  test('defaults: tips on, nothing dismissed, tour not done; nothing written until the user chooses', () => {
    assert.deepEqual(GUIDE_DEFAULTS, { tips: true, dismissed: [], tourDone: false });
    const d = tmp();
    try {
      assert.equal(readSettings(d).ui, undefined);
      assert.deepEqual(DEFAULTS.clips.recording, 'ask');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test('checks: booleans, a list of short slugs, at most 200, nothing else', () => {
    assert.deepEqual(settingsProblems({ ui: { guide: { tips: false, dismissed: ['rec-stopped-ask'], tourDone: true } } }), []);
    assert.deepEqual(settingsProblems({ ui: { guide: {} } }), []);
    assert.deepEqual(guideProblems({ tips: 'no' }), ['ui.guide.tips must be true or false']);
    assert.deepEqual(guideProblems({ tourDone: 1 }), ['ui.guide.tourDone must be true or false']);
    assert.deepEqual(guideProblems({ dismissed: 'a' }), ['ui.guide.dismissed must be a list of ids']);
    for (const bad of ['Upper', 'has space', '1abc', '', 'x'.repeat(41), 'a/b', '../x', 7, null]) assert.equal(guideProblems({ dismissed: [bad] }).length, 1, String(bad));
    assert.deepEqual(guideProblems({ dismissed: Array.from({ length: GUIDE_MAX_IDS }, (_, i) => `id-${i}`) }), []);
    assert.equal(guideProblems({ dismissed: Array.from({ length: GUIDE_MAX_IDS + 1 }, (_, i) => `id-${i}`) }).length, 1);
    assert.deepEqual(guideProblems({ nope: 1 }), ['unknown guide setting nope']);
    assert.deepEqual(guideProblems(null), ['ui.guide must be an object']);
    assert.deepEqual(guideProblems([]), ['ui.guide must be an object']);
    assert.deepEqual(settingsProblems({ ui: { colour: 'red' } }), ['unknown ui setting colour']);
  });
  test('round trip: parts merge, motion is kept, dismissed is replaced whole and de-duplicated, a bad file gives defaults', () => {
    const d = tmp();
    try {
      writeSettings(d, { ui: { motion: 'off' } });
      assert.deepEqual(readSettings(d).ui, { motion: 'off' });
      writeSettings(d, { ui: { guide: { dismissed: ['a-one', 'b-two', 'a-one'] } } });
      assert.deepEqual(readSettings(d).ui, { motion: 'off', guide: { tips: true, dismissed: ['a-one', 'b-two'], tourDone: false } });
      writeSettings(d, { ui: { guide: { tips: false } } });
      assert.deepEqual(readSettings(d).ui.guide, { tips: false, dismissed: ['a-one', 'b-two'], tourDone: false });
      writeSettings(d, { ui: { guide: { tourDone: true, dismissed: [] } } });
      assert.deepEqual(readSettings(d).ui, { motion: 'off', guide: { tips: false, dismissed: [], tourDone: true } });
      writeSettings(d, { ui: { motion: 'on' } });
      assert.equal(readSettings(d).ui.guide.tips, false, 'a motion change keeps the guide choices');
      // a hand-edited file: bad parts fall back one by one
      const f = path.join(d, 'settings.json');
      const j = JSON.parse(readFileSync(f, 'utf8'));
      j.ui.guide = { tips: 'x', dismissed: ['ok-id', 'NOT OK', 5, 'ok-id'], tourDone: true };
      writeFileSync(f, JSON.stringify(j));
      assert.deepEqual(readSettings(d).ui.guide, { tips: true, dismissed: ['ok-id'], tourDone: true });
      j.ui.guide = 'junk';
      writeFileSync(f, JSON.stringify(j));
      assert.deepEqual(readSettings(d).ui.guide, { tips: true, dismissed: [], tourDone: false });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test('guideOnly: only a patch with nothing but ui.guide counts', () => {
    assert.equal(guideOnly({ ui: { guide: { tips: false } } }), true);
    assert.equal(guideOnly({ ui: { guide: { tips: false }, motion: 'on' } }), false);
    assert.equal(guideOnly({ ui: { guide: {} }, clips: { recording: 'off' } }), false);
    assert.equal(guideOnly({ ui: { motion: 'on' } }), false);
    assert.equal(guideOnly(null), false);
    assert.equal(guideOnly({ ui: [] }), false);
  });
});

describe('UI server: guide route and settings', () => {
  const KEY = 'g'.repeat(48);
  let srv, port, dataDir, a, live = false;
  const raw = (o = {}) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    if (o.body !== undefined) h['content-length'] = Buffer.byteLength(o.body);
    const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.url ?? '/', headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', reject); req.end(o.body);
  });
  const post = (route, body) => raw({ method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie: a.cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': a.csrf } });
  const get = (route) => raw({ url: route, headers: { cookie: a.cookie } });
  before(async () => {
    dataDir = tmp();
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: async (m, p) => { const r = await fake.call(m, p); return m === 'host.status' ? { ...r, live } : r; } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, limits: { statusPollMs: 20 } });
    ({ port } = await srv.listen());
    const r = await raw({ url: `/login?k=${KEY}` });
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    const s = await raw({ url: '/ui/api/session', headers: { cookie } });
    a = { cookie, csrf: JSON.parse(s.text).csrf };
  });
  after(() => { srv.close(); rmSync(dataDir, { recursive: true, force: true }); });

  test('GET ui/api/guide serves the tours and hints; needs the login cookie', async () => {
    assert.equal((await raw({ url: '/ui/api/guide' })).status, 401);
    const g = JSON.parse((await get('/ui/api/guide')).text);
    assert.deepEqual(g.tours, readJson('data/guide/tour.json').tours);
    assert.deepEqual(g.hints, readJson('data/guide/hints.json').hints);
  });
  test('POST ui.guide is saved and read back; a bad value is refused', async () => {
    assert.equal((await post('/ui/api/settings', { ui: { guide: { tips: false, dismissed: ['first-task'] } } })).status, 200);
    const r = JSON.parse((await get('/ui/api/settings')).text);
    assert.deepEqual(r.settings.ui.guide, { tips: false, dismissed: ['first-task'], tourDone: false });
    for (const bad of [{ ui: { guide: { tips: 'x' } } }, { ui: { guide: { dismissed: ['A B'] } } }, { ui: { guide: { more: 1 } } }]) {
      const x = await post('/ui/api/settings', bad);
      assert.equal(x.status, 400, JSON.stringify(bad));
      assert.equal(JSON.parse(x.text).error, 'bad-settings');
    }
  });
  test('while live: tips can still be dismissed (no task), other settings stay refused', async () => {
    live = true;
    await new Promise((r) => setTimeout(r, 200));
    try {
      assert.equal((await post('/ui/api/settings', { ui: { guide: { dismissed: ['first-task', 'went-live'] } } })).status, 200);
      assert.deepEqual(readSettings(dataDir).ui.guide.dismissed, ['first-task', 'went-live']);
      assert.equal((await post('/ui/api/settings', { ui: { guide: { tips: true }, motion: 'off' } })).status, 409);
      assert.equal((await post('/ui/api/settings', { clips: { recording: 'off' } })).status, 409);
      const st = JSON.parse((await get('/ui/api/status')).text);
      assert.ok(!(st.tasks ?? []).some((t) => t.kind === 'settings'), 'a dismissed tip is not a task (no task bar entry, no toast)');
    } finally { live = false; }
  });
  test('reset: empty list and tourDone false are saved', async () => {
    assert.equal((await post('/ui/api/settings', { ui: { guide: { dismissed: [], tourDone: false } } })).status, 200);
    assert.deepEqual(readSettings(dataDir).ui.guide, { tips: false, dismissed: [], tourDone: false });
  });
});
