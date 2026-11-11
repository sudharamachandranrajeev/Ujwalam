// SPDX-License-Identifier: GPL-3.0-or-later
// LL1 + LL3 (D340): the review of low-confidence reads. services/learning/review.mjs over review.jsonl items (written
// here as fixtures and, in the fixture run, by the real Python writer services/clip/learning_capture.py), the cap of
// the shared store over those session folders, and the studio UI server routes behind the flag learning-review.
// Synthetic items and placeholder texts only; temp folders; no OCR, no GPU, no network, no windows.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as reviewMod from '../services/learning/review.mjs';
import { createLearningStore } from '../services/learning/store.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createFlags } from '../services/flags/index.mjs';

const { createReview } = reviewMod;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const dirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-lr-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const S = 'live-20261111-120000';
const JPEG = Buffer.from([0xff, 0xd8, 0x46, 0x41, 0x4b, 0x45, 0xff, 0xd9]);
function seed(dataDir, session = S, items = null) {
  const dir = path.join(dataDir, 'learning-store', session);
  mkdirSync(path.join(dir, 'frames'), { recursive: true });
  writeFileSync(path.join(dir, 'session.json'), `${JSON.stringify({ v: 1, createdAt: '2026-11-11T12:00:00.000Z' })}\n`);
  const list = items ?? [
    { v: 1, id: 'live-00001', at: '2026-11-11T12:10:00.000Z', t: 600, kind: 'unclassified-banner', detector: 'W1', label: 'VICTORY', mode: 'mp', ocrScore: 0.97, threshold: null, value: null, choices: ['round', 'match', 'not a banner'], frame: 'frames/live-00001.jpg', texts: [{ text: 'PLACEHOLDER', score: 0.9, g: [0, 0, 1, 1] }] },
    { v: 1, id: 'live-00002', at: '2026-11-11T12:20:00.000Z', t: 1200, kind: 'ocr-low', detector: 'M3', label: 'PLACEHOLDER MEDAL', mode: 'mp', ocrScore: 0.41, threshold: 0.5, value: 'PLACEHOLDER MEDAL', choices: ['PLACEHOLDER MEDAL', 'wrong read'], frame: 'frames/live-00002.jpg', texts: [] },
    { v: 1, id: 'mode-002', at: '2026-11-11T13:00:00.000Z', t: 740, kind: 'unknown-mode', detector: null, label: null, mode: 'mp', ocrScore: null, threshold: null, value: null, choices: ['domination', 'hardpoint'], match: 2, frame: null, modeReason: 'no mode evidence', modeEvidence: [], texts: [] },
  ];
  writeFileSync(path.join(dir, 'review.jsonl'), `${list.map((x) => JSON.stringify(x)).join('\n')}\n{"torn`);
  for (const it of list) if (it.frame) writeFileSync(path.join(dir, it.frame), JPEG);
  return dir;
}

describe('LL3 review (services/learning/review.mjs)', async () => {
  test('lists queued items, a confirm writes a "confirmed" label row and the item leaves the list', async () => {
    const dataDir = mk(); seed(dataDir);
    const r = createReview({ dataDir, now: () => new Date('2026-11-11T15:00:00Z') });
    const l = await r.list();
    assert.equal(l.total, 3);
    assert.deepEqual(l.items.map((i) => [i.id, i.kind, i.hasFrame]), [['live-00001', 'unclassified-banner', true], ['live-00002', 'ocr-low', true], ['mode-002', 'unknown-mode', false]]);
    assert.equal(l.items[0].texts, undefined, 'OCR texts stay in the store; the list does not carry them');
    const row = await r.confirm({ session: S, id: 'live-00001', value: 'round' });
    assert.equal(typeof row, 'object');
    assert.deepEqual({ action: row.action, source: row.source, session: row.session }, { action: 'confirmed', source: 'review', session: S });
    assert.deepEqual(row.ref, { item: 'live-00001', kind: 'unclassified-banner', detector: 'W1', label: 'VICTORY', value: 'round', corrected: true });
    const stored = readFileSync(path.join(dataDir, 'learning-store', S, 'labels.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].at, '2026-11-11T15:00:00.000Z');
    assert.deepEqual((await r.list()).items.map((i) => i.id), ['live-00002', 'mode-002']);
  });

  test('ocr-low: confirming the read is not a correction; a typed correction is; other kinds take only their choices', async () => {
    const dataDir = mk(); seed(dataDir);
    const r = createReview({ dataDir });
    assert.equal((await r.confirm({ session: S, id: 'live-00002', value: 'PLACEHOLDER MEDAL' })).ref.corrected, false);
    assert.equal((await r.confirm({ session: S, id: 'live-00002', value: 'OTHER MEDAL' })).ref.value, 'OTHER MEDAL');
    assert.equal(await r.confirm({ session: S, id: 'mode-002', value: 'free text' }), 'bad-value');
    assert.equal(await r.confirm({ session: S, id: 'mode-002', value: '' }), 'bad-value');
    assert.equal(await r.confirm({ session: S, id: 'live-00002', value: 'x'.repeat(81) }), 'bad-value');
    assert.equal(await r.confirm({ session: S, id: 'live-00002', value: 'a\u0001b' }), 'bad-value');
    assert.equal(await r.confirm({ session: S, id: 'live-99999', value: 'round' }), 'unknown-item');
    assert.equal(await r.confirm({ session: '../x', id: 'live-00001', value: 'round' }), 'unknown-item');
    assert.equal((await r.confirm({ session: S, id: 'mode-002', value: 'hardpoint' })).ref.kind, 'unknown-mode');
  });

  test('frames: only frames/<id>.jpg of a listed item is read', async () => {
    const dataDir = mk(); const dir = seed(dataDir);
    writeFileSync(path.join(dir, 'secret.jpg'), 'x');
    const r = createReview({ dataDir });
    assert.deepEqual(await r.frame(S, 'live-00001'), JPEG);
    assert.equal(await r.frame(S, 'mode-002'), null, 'no frame');
    assert.equal(await r.frame(S, '../secret'), null);
    assert.equal(await r.frame('..', 'live-00001'), null);
    assert.equal(await r.frame(S, 'secret'), null);
  });

  test('no store, no items: an empty list', async () => {
    assert.deepEqual(await createReview({ dataDir: mk() }).list(), { items: [], total: 0 });
  });
});

// Codex review of D340: each test failed on the code before its fix.
describe('LL3 review: Codex review fixes', () => {
  const BOUND = reviewMod.MAX_READ_BYTES ?? 2 * 1024 * 1024;

  test('P2: a frames/ junction that leads out of the store is refused (realpath inside the store root)', async () => {
    const dataDir = mk(); const dir = seed(dataDir);
    const outside = mk();
    writeFileSync(path.join(outside, 'live-00001.jpg'), JPEG);
    rmSync(path.join(dir, 'frames'), { recursive: true, force: true });
    symlinkSync(outside, path.join(dir, 'frames'), 'junction');
    assert.equal(await createReview({ dataDir }).frame(S, 'live-00001'), null);
  });

  test('P2: list, frame and confirm are async (no blocking read on the server\'s event loop)', async () => {
    const dataDir = mk(); seed(dataDir);
    const r = createReview({ dataDir });
    for (const p of [r.list(), r.frame(S, 'live-00001'), r.confirm({ session: S, id: 'mode-002', value: 'hardpoint' })]) {
      assert.ok(p instanceof Promise);
      await p;
    }
  });

  test('P2: an unchanged review.jsonl (same mtime and size) is not read again; a changed one is', async () => {
    const dataDir = mk(); const dir = seed(dataDir);
    const f = path.join(dir, 'review.jsonl');
    const T = 1_800_000_000; // a whole second: restored exactly after the rewrite
    utimesSync(f, T, T);
    const r = createReview({ dataDir });
    assert.deepEqual((await r.list()).items.map((i) => i.id), ['live-00001', 'live-00002', 'mode-002']);
    writeFileSync(f, readFileSync(f, 'utf8').replace('"mode-002"', '"mode-009"'));
    utimesSync(f, T, T);
    assert.deepEqual((await r.list()).items.map((i) => i.id), ['live-00001', 'live-00002', 'mode-002'], 'cached');
    appendFileSync(f, '\n');
    assert.deepEqual((await r.list()).items.map((i) => i.id), ['live-00001', 'live-00002', 'mode-009'], 'read again');
  });

  test('P2: reads are bounded: review items past the bound are not listed; answers are read from the end', async () => {
    const dataDir = mk();
    const it = (id) => ({ v: 1, id, kind: 'unknown-mode', choices: ['domination', 'hardpoint'], frame: null });
    const dir = seed(dataDir, S, [it('mode-001'), it('mode-002')]);
    const f = path.join(dir, 'review.jsonl');
    writeFileSync(f, `${JSON.stringify(it('mode-001'))}\n${'x'.repeat(BOUND)}\n${JSON.stringify(it('mode-002'))}\n`);
    const r = createReview({ dataDir });
    assert.deepEqual((await r.list()).items.map((i) => i.id), ['mode-001']);
    writeFileSync(path.join(dir, 'labels.jsonl'), `${'y'.repeat(BOUND)}\n${JSON.stringify({ action: 'confirmed', source: 'review', ref: { item: 'mode-001' } })}\n`);
    assert.deepEqual((await r.list()).items, [], 'the newest answers (end of labels.jsonl) are within the bound');
  });
});

// The fixture run: the real Python writer (LiveCapture, as the live worker uses it) writes a session; Node lists it,
// a confirm writes a label, and the store's cap (LL1, shared with LL2) still removes old sessions, never the newest.
const PY = process.env.UJWALAM_TEST_PYTHON || 'python';
const havePy = spawnSync(PY, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() === '3';
describe('LL1 fixture run: Python writer -> store -> review -> cap', { skip: havePy ? false : 'python not found' }, () => {
  test('store written, items listed, confirm writes a label, the cap still holds', async () => {
    const dataDir = mk();
    const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'services', 'clip'))})
import game_pack, learning_capture as lc
pack = game_pack.load_pack(${JSON.stringify(path.join(REPO, 'data', 'games', 'codm'))})
pack["ocr"] = dict(pack["ocr"], minConfidence=0.5)  # fixture value; game.json keeps null
c = lc.LiveCapture(sys.argv[1], "${S}", pack, print, encode=lambda img: b"\\xff\\xd8FAKE\\xff\\xd9")
def hit(d, label, score=0.95, **kw):
    return dict(detector=d, label=label, role="positive", signal=True, why=[], clipReason=True, weight=None, detectorStatus="unverified", mode="mp", ocrScore=score, **kw)
boxes = [{"text": "PLACEHOLDER", "score": 0.9, "g": [0.1, 0.1, 0.2, 0.2]}]
for i in range(30):
    rows = [hit("M3", "PLACEHOLDER MEDAL")]
    if i == 10: rows.append(hit("W1", "VICTORY", banner=None, subtitle=None))
    if i == 20: rows.append(hit("M3", "OTHER MEDAL", score=0.3))
    c.frame(float(i), "IMG", rows, boxes, "mp", True)
    c.q.join()  # the live loop samples about once a second; here each frame waits for the writer (no burst drops)
c.close()
print(json.dumps(c.stats))`;
    const p = spawnSync(PY, ['-I', '-c', script, dataDir], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(p.status, 0, p.stderr);
    const stats = JSON.parse(p.stdout.trim().split('\n').at(-1));
    assert.deepEqual(stats, { evidence: 30, items: 2, dropped: 0 });
    const dir = path.join(dataDir, 'learning-store', S);
    assert.equal(readFileSync(path.join(dir, 'evidence.jsonl'), 'utf8').trim().split('\n').length, 30);
    const r = createReview({ dataDir });
    const l = await r.list();
    assert.deepEqual(l.items.map((i) => [i.kind, i.hasFrame]), [['unclassified-banner', true], ['ocr-low', true]]);
    assert.deepEqual(await r.frame(S, l.items[0].id), Buffer.from([0xff, 0xd8, 0x46, 0x41, 0x4b, 0x45, 0xff, 0xd9]));
    assert.equal((await r.confirm({ session: S, id: l.items[0].id, value: 'match' })).action, 'confirmed');
    assert.equal((await r.list()).total, 1);
    // Cap: two older sessions (by session.json createdAt) of 4 KB each; a cap that fits only the live one plus one.
    for (const [name, at] of [['live-20261101-100000', '2026-11-01T10:00:00Z'], ['live-20261105-100000', '2026-11-05T10:00:00Z']]) {
      const d = path.join(dataDir, 'learning-store', name);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, 'session.json'), JSON.stringify({ v: 1, createdAt: at }));
      writeFileSync(path.join(d, 'evidence.jsonl'), 'x'.repeat(4096));
    }
    const du = (d) => readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? du(path.join(d, e.name)) : statSync(path.join(d, e.name)).size), 0);
    const liveBytes = du(dir);
    const cap = createLearningStore({ dataDir, capBytes: liveBytes + 6000 }).enforceCap();
    assert.deepEqual(cap.removed, ['live-20261101-100000'], 'oldest first');
    assert.ok(cap.total <= liveBytes + 6000);
    assert.ok(existsSync(dir), 'the newest session is kept');
    const all = createLearningStore({ dataDir, capBytes: 1 }).enforceCap();
    assert.deepEqual(all.removed, ['live-20261105-100000']);
    assert.ok(existsSync(dir), 'the newest session is never removed, even alone over the cap');
  });
});

// ---- studio UI server routes ----
function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), json() { return JSON.parse(this.text); } }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function boot(flagOn) {
  const dataDir = mk(); seed(dataDir);
  const flags = createFlags({ dataDir });
  if (flagOn) flags.set('learning-review', true);
  const fake = createFakeHost({ outputsReady: true });
  const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, flags, limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  const r = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const get = (url) => raw(port, { url, headers: { cookie } });
  const post = (url, b) => raw(port, { method: 'POST', url, body: JSON.stringify(b), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  return { srv, dataDir, get, post };
}

describe('studio UI server: /ui/api/learning/* (flag learning-review)', () => {
  test('flag off (the default): every route answers 404 learning-review-off and nothing is written', async () => {
    const c = await boot(false);
    try {
      assert.equal(createFlags({ dataDir: c.dataDir }).isOn('learning-review'), false, 'off by default');
      for (const r of [await c.get('/ui/api/learning/review'), await c.get(`/ui/api/learning/frame?session=${S}&id=live-00001`), await c.post('/ui/api/learning/confirm', { session: S, id: 'live-00001', value: 'round' })]) {
        assert.equal(r.status, 404);
        assert.equal(r.json().error, 'learning-review-off');
      }
      assert.equal(existsSync(path.join(c.dataDir, 'learning-store', S, 'labels.jsonl')), false);
    } finally { c.srv.close(); }
  });

  test('flag on: list, frame, confirm (one label row), bad params refused', async () => {
    const c = await boot(true);
    try {
      const l = await c.get('/ui/api/learning/review');
      assert.equal(l.status, 200);
      assert.equal(l.json().total, 3);
      const f = await c.get(`/ui/api/learning/frame?session=${S}&id=live-00001`);
      assert.equal(f.status, 200);
      assert.deepEqual(Buffer.from(f.json().jpeg, 'base64'), JPEG);
      assert.equal((await c.get(`/ui/api/learning/frame?session=${S}&id=mode-002`)).status, 404);
      const ok = await c.post('/ui/api/learning/confirm', { session: S, id: 'mode-002', value: 'hardpoint' });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json().label.ref, { item: 'mode-002', kind: 'unknown-mode', detector: null, label: null, value: 'hardpoint', corrected: true });
      assert.equal((await c.get('/ui/api/learning/review')).json().total, 2);
      assert.equal((await c.post('/ui/api/learning/confirm', { session: S, id: 'mode-002', value: 'nope' })).status, 400);
      assert.equal((await c.post('/ui/api/learning/confirm', { session: S, id: 'zzz', value: 'round' })).status, 404);
      assert.equal((await c.post('/ui/api/learning/confirm', { session: S, id: 'live-00001', value: 'round', extra: 1 })).status, 400);
    } finally { c.srv.close(); }
  });
});
