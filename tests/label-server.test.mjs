// SPDX-License-Identifier: GPL-3.0-or-later
// A6: labelling page server, export validator and page rules. No corpus or real cache is used:
// a temp fake cache, corpus and profile are built per test run.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, symlinkSync, utimesSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { startServer, claimLock, placeExclusive } from '../tools/label/server.mjs';
import { validate as liteValidate } from '../tools/label/schema-lite.mjs';
import { loadPackSummary, loadTagIds, validateLabelFile, buildLabelFile, checkDraft, diffLabelFiles } from '../tools/label/labels-export.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(readFileSync(path.join(...p), 'utf8'));
const schema = readJson(repo, 'data', 'labels.schema.json');

const SID = 's-test-0001';
const BAD = 's-test-0002'; // manifest with a hostile clip name
const REAL = 's-test-0003'; // real tiny mp4s for the ffmpeg endpoints
const ZERO = 's-test-0004'; // zero-byte proxy and clip
const LOCKS = 's-test-0005'; // lock tests
const REV = 's-test-0006'; // revision, backups and empty-overwrite tests
const ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
const TAB = 'a'.repeat(32); // this test "tab"
const TAB2 = 'b'.repeat(32); // a second tab

const tmp = mkdtempSync(path.join(os.tmpdir(), 'label-test-'));
const dirs = { cache: path.join(tmp, 'cache'), corpus: path.join(tmp, 'corpus'), labels: path.join(tmp, 'labels'), drafts: path.join(tmp, 'drafts'), notes: path.join(tmp, 'notes'), sugg: path.join(tmp, 'sugg') };
const proxyBytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7 + 3) % 256));
const clipA = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 5 + 1) % 256));
const clipB = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 11 + 9) % 256));

function seg(clip, inSec, outSec, start) { return { clip, clipInSec: inSec, clipOutSec: outSec, sessionStartSec: start, durationSec: outSec - inSec, trimMethod: null, wallStartUtc: '2026-01-01T00:00:00.000Z' }; }
function writeSession(id, segments, proxy) {
  mkdirSync(path.join(dirs.cache, id), { recursive: true });
  writeFileSync(path.join(dirs.cache, id, 'manifest.json'), JSON.stringify({ version: 1, session: id, expectedDurationSec: segments.reduce((a, s) => a + s.durationSec, 0), segments }));
  writeFileSync(path.join(dirs.cache, id, 'proxy-540x960-30p.mp4'), proxy);
}
let srv, port;
let profileFile;
const serverOpts = (o = {}) => ({ repo, cacheDir: dirs.cache, corpusDir: dirs.corpus, labelsDir: dirs.labels, draftsRoot: dirs.drafts, notesRoot: dirs.notes, suggestionsRoot: dirs.sugg, sessionGamesFile: path.join(tmp, 'session-games.json'), port: 0, ...o });

function snapshotTree(root) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else out[path.relative(root, p)] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}
const allFiles = (root) => Object.keys(snapshotTree(root));

// ---------------------------------------------------------------- request helpers
// Every request carries this launch's token and the test tab id unless told otherwise.
function req(method, p, { headers = {}, body, raw, at, token, tab = TAB } = {}) {
  const tok = token === undefined ? (at ? servers.get(at)?.token : srv.token) : token;
  const h = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(tok ? { 'X-Label-Token': tok } : {}), ...(tab ? { 'X-Label-Tab': tab } : {}), ...headers };
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: at ?? port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(raw ? body : JSON.stringify(body));
    r.end();
  });
}
const servers = new Map(); // port -> server (for the token of extra servers)
const put = (p, body, o = {}) => req('PUT', p, { body, ...o });
const post = (p, body, o = {}) => req('POST', p, { body, ...o });
const lock = (sid, o = {}) => post(`/api/session/${sid}/lock`, o.takeover ? { takeover: true } : {}, o);
// Export as the page does it (review M10): preview first, then export with the preview's hashes.
async function exportNow(sid, body = {}, o = {}) {
  const p = await post(`/api/session/${sid}/export-preview`, {}, o);
  if (p.status !== 200) return p;
  return post(`/api/session/${sid}/export`, { ...body, sha256: p.json.sha256, existingSha256: p.json.existingSha256 }, o);
}
const start = async (o) => { const s = await startServer(serverOpts(o)); servers.set(s.port, s); return s; };

const label = (id, a, b, extra = {}) => ({ id, windowStartSec: a, windowEndSec: b, label: 'keep', rating: 4, reasonTags: ['multi-kill'], createdAt: '2026-10-28T10:00:00Z', ...extra });
async function saveDraft(sid, patch, o = {}) {
  const cur = (await req('GET', `/api/session/${sid}/draft`, o)).json;
  const d = { ...cur, ...patch };
  return put(`/api/session/${sid}/draft`, d, o);
}
const draftFile = (sid) => path.join(dirs.drafts, `${sid}.json`);
const pass2File = (sid) => path.join(dirs.drafts, `${sid}.pass2.json`);
const backupsOf = (sid) => path.join(dirs.drafts, 'backups', sid);
// A fresh draft: the stored draft and the pass-2 record are removed first.
const resetDraft = async (sid, patch) => {
  rmSync(draftFile(sid), { force: true });
  rmSync(pass2File(sid), { force: true });
  return saveDraft(sid, patch);
};
// Writes a stored draft directly (as an old or hand-edited file), to test what export does with it.
const writeStoredDraft = (sid, d) => writeFileSync(draftFile(sid), JSON.stringify({ version: 1, sessionId: sid, game: 'codm', revision: 1, labels: [], events: [], ...d }));

before(async () => {
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(dirs.corpus, 'clipA.mp4'), clipA);
  writeFileSync(path.join(dirs.corpus, 'clipB.mp4'), clipB);
  writeFileSync(path.join(tmp, 'secret.bin'), 'outside the corpus');
  writeSession(SID, [seg('clipA.mp4', 0.5, 30.5, 0), seg('clipB.mp4', 2, 32, 30)], proxyBytes);
  writeSession(BAD, [seg('../secret.bin', 0, 10, 0), seg('sub\\x.mp4', 0, 10, 10), seg('C:/Windows/win.ini', 0, 10, 20)], proxyBytes);
  writeSession(LOCKS, [seg('clipA.mp4', 0, 30, 0)], proxyBytes);
  writeSession(REV, [seg('clipA.mp4', 0, 30, 0)], proxyBytes);
  if (ffmpegOk) {
    const mk = (f) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x96:rate=30', '-t', '3', '-pix_fmt', 'yuv420p', f], { windowsHide: true });
    mk(path.join(dirs.corpus, 'real.mp4'));
    writeSession(REAL, [seg('real.mp4', 0, 3, 0)], readFileSync(path.join(dirs.corpus, 'real.mp4')));
  }
  writeFileSync(path.join(dirs.corpus, 'empty.mp4'), Buffer.alloc(0));
  writeSession(ZERO, [seg('empty.mp4', 0, 10, 0)], Buffer.alloc(0));
  const games = { version: 1, sessions: { [SID]: 'codm', [BAD]: 'codm', [ZERO]: 'codm', [LOCKS]: 'codm', [REV]: 'codm', ...(ffmpegOk ? { [REAL]: 'codm' } : {}) } };
  writeFileSync(path.join(tmp, 'session-games.json'), JSON.stringify(games));
  srv = await start();
  port = srv.port;
  // The test tab is the writer of every session except LOCKS (the lock tests take that one).
  for (const sid of [SID, BAD, ZERO, REV]) assert.equal((await lock(sid)).json.writer, true);
  // test profile with FAKE terms only
  profileFile = path.join(tmp, 'profile.test.json');
  writeFileSync(profileFile, JSON.stringify({ version: '0.1.0', streamer: { name: 'Zorblax Quimby', variants: ['Zorbq-Fake'] }, games: { codm: { ign: 'Wibblefrotz99' } }, paths: {}, private_terms: [] }));
});
after(async () => { await srv.close(); rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- network
test('binds to 127.0.0.1 only', async () => {
  assert.equal(srv.server.address().address, '127.0.0.1');
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const other = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (other) {
    const err = await new Promise((resolve) => {
      const s = net.connect({ host: other.address, port, timeout: 1000 });
      s.on('connect', () => { s.destroy(); resolve(null); });
      s.on('error', (e) => resolve(e.code));
      s.on('timeout', () => { s.destroy(); resolve('TIMEOUT'); });
    });
    assert.ok(err === 'ECONNREFUSED' || err === 'TIMEOUT', `LAN address must not accept connections, got ${err}`);
  }
});

test('Host, Origin and Referer are checked; POST needs JSON', async () => {
  assert.equal((await req('GET', '/api/sessions', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await req('GET', '/api/sessions', { headers: { Host: `localhost:${port}` } })).status, 200);
  assert.equal((await req('GET', '/api/sessions', { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await req('GET', '/api/sessions', { headers: { Referer: 'http://evil.example/page' } })).status, 403);
  assert.equal((await req('GET', `/media/proxy/${SID}`, { headers: { Referer: `http://127.0.0.1:${port + 1}/` } })).status, 403);
  assert.equal((await req('GET', '/api/sessions', { headers: { Referer: `http://127.0.0.1:${port}/?t=x` } })).status, 200);
  assert.equal((await req('POST', `/api/session/${SID}/export`, { headers: { 'Content-Type': 'text/plain' }, body: '{}', raw: true })).status, 415);
});

// ---------------------------------------------------------------- Range
test('Range responses are correct', async () => {
  const url = `/media/proxy/${SID}`;
  const full = await req('GET', url);
  assert.equal(full.status, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-length'], String(proxyBytes.length));
  assert.deepEqual(full.buf, proxyBytes);

  const mid = await req('GET', url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers['content-range'], `bytes 100-199/${proxyBytes.length}`);
  assert.equal(mid.headers['content-length'], '100');
  assert.deepEqual(mid.buf, proxyBytes.subarray(100, 200));

  const open = await req('GET', url, { headers: { Range: 'bytes=4900-' } });
  assert.equal(open.status, 206);
  assert.deepEqual(open.buf, proxyBytes.subarray(4900));

  const suffix = await req('GET', url, { headers: { Range: 'bytes=-50' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], `bytes 4950-4999/${proxyBytes.length}`);
  assert.deepEqual(suffix.buf, proxyBytes.subarray(4950));

  const clamp = await req('GET', url, { headers: { Range: 'bytes=4990-99999' } });
  assert.equal(clamp.status, 206);
  assert.equal(clamp.headers['content-range'], `bytes 4990-4999/${proxyBytes.length}`);

  for (const bad of ['bytes=5000-', 'bytes=9999-10000', 'bytes=5-2', 'bytes=-']) {
    const r = await req('GET', url, { headers: { Range: bad } });
    assert.equal(r.status, 416, bad);
    assert.equal(r.headers['content-range'], `bytes */${proxyBytes.length}`);
  }
  const head = await req('HEAD', url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.buf.length, 0);
});

test('original clips stream through the manifest by index', async () => {
  const a = await req('GET', `/media/clip/${SID}/0`, { headers: { Range: 'bytes=10-29' } });
  assert.equal(a.status, 206);
  assert.deepEqual(a.buf, clipA.subarray(10, 30));
  const b = await req('GET', `/media/clip/${SID}/1`);
  assert.deepEqual(b.buf, clipB);
  assert.equal((await req('GET', `/media/clip/${SID}/2`)).status, 404);
});

test('manifest and session list expose ids and times, not clip file names or paths', async () => {
  const m = await req('GET', `/api/session/${SID}/manifest`);
  assert.equal(m.status, 200);
  assert.equal(m.json.segments.length, 2);
  assert.ok(!m.buf.toString().includes('clipA'));
  assert.ok(!m.buf.toString().includes(tmp.replace(/\\/g, '\\\\')));
  const l = await req('GET', '/api/sessions');
  assert.ok(l.json.sessions.some((s) => s.id === SID && s.durationSec === 60));
  assert.ok(!l.buf.toString().includes('clipA'));
});

// ---------------------------------------------------------------- traversal
test('traversal and raw-path requests are refused', async () => {
  const refused = [
    `/media/clip/${SID}/..%2f..%2fsecret.bin`,
    `/media/clip/${SID}/..%5csecret.bin`,
    `/media/clip/${SID}/%2e%2e`,
    `/media/clip/${SID}/0%00`,
    `/media/clip/${SID}/abc`,
    `/media/clip/${SID}/-1`,
    `/media/clip/${SID}/99999999`,
    `/media/proxy/..%2f${SID}`,
    `/media/proxy/${SID}%2f..%2f..%2fsecret.bin`,
    `/media/proxy/C%3A%5CWindows%5Cwin.ini`,
    `/media/proxy/s-nope`,
    `/media/clip/${SID}`,
    `/media/clip/${BAD}/0`, // manifest clip name "../secret.bin"
    `/media/clip/${BAD}/1`, // name with a backslash
    `/media/clip/${BAD}/2`, // absolute path
    `/api/session/..%2f${SID}/manifest`,
    `/api/session/${SID}%2f..%2f${SID}/draft`,
    '/server.mjs', '/labels-export.mjs', '/..%2fpackage.json', '/%2e%2e/package.json',
    '/api/file?path=C:/Windows/win.ini', '/media/file?path=../secret.bin',
  ];
  for (const p of refused) {
    const r = await req('GET', p);
    assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
    assert.ok(!r.buf.toString().includes('outside the corpus'), p);
  }
  // A path in the query string is ignored: the clip still comes from the manifest.
  const q = await req('GET', `/media/clip/${SID}/0?path=${encodeURIComponent(path.join(tmp, 'secret.bin'))}`);
  assert.deepEqual(q.buf, clipA);
  // Draft writes cannot be aimed at another file through the session id.
  const w = await put(`/api/session/..%2f..%2fx/draft`, { sessionId: '../../x' });
  assert.ok(w.status === 400 || w.status === 404, String(w.status));
});

// ---------------------------------------------------------------- blind protocol
test('suggestions are refused until pass 2 is confirmed; the edited-after flag is server-owned', async () => {
  writeFileSync(path.join(dirs.sugg, `${SID}.json`), JSON.stringify({ version: 1, sessionId: SID, suggestions: [{ id: 'sg-0001', detectorId: 'M3', timeSec: 12, confidence: 0.9, medal: 'Double Kill', ocrText: 'Zorblax Quimby' }] }));
  assert.equal((await req('GET', `/api/session/${SID}/suggestions`)).status, 403);
  assert.equal((await post(`/api/session/${SID}/open-pass2`, {})).status, 400);
  assert.equal((await req('GET', `/api/session/${SID}/suggestions`)).status, 403);

  let r = await saveDraft(SID, { labels: [label('l-0001', 10, 20)] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.pass2, null);
  r = await post(`/api/session/${SID}/open-pass2`, { confirm: true });
  assert.equal(r.status, 200);
  assert.ok(r.json.pass2.openedAt);
  assert.equal(r.json.pass2.highlightsEditedAfter, false);
  const s = await req('GET', `/api/session/${SID}/suggestions`);
  assert.equal(s.status, 200);
  assert.equal(s.json.suggestions.length, 1);

  // saving the same highlights keeps the flag false
  r = await saveDraft(SID, { labels: [label('l-0001', 10, 20)] });
  assert.equal(r.json.pass2.highlightsEditedAfter, false);
  // a client that tries to clear pass2 cannot
  r = await saveDraft(SID, { pass2: null, labels: [label('l-0001', 10, 20)] });
  assert.ok(r.json.pass2.openedAt);
  // editing a highlight after pass 2 sets the flag, and it stays set when the edit is reverted
  r = await saveDraft(SID, { labels: [label('l-0001', 10, 21)] });
  assert.equal(r.json.pass2.highlightsEditedAfter, true);
  r = await saveDraft(SID, { labels: [label('l-0001', 10, 20)] });
  assert.equal(r.json.pass2.highlightsEditedAfter, true);
});

test('event edits alone do not set the edited-after flag', async () => {
  const sid = BAD; // any session in the list; draft area is a temp folder
  await resetDraft(sid, { labels: [label('l-0001', 1, 5)] });
  await post(`/api/session/${sid}/open-pass2`, { confirm: true });
  const r = await saveDraft(sid, { labels: [label('l-0001', 1, 5)], events: [{ id: 'e-0001', detectorId: 'N1', timeSec: 3, verdict: 'added' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.pass2.highlightsEditedAfter, false);
});

// ---------------------------------------------------------------- export
const okDraft = () => ({
  labels: [label('l-0001', 10, 20), label('l-0002', 40, 50, { label: 'reject', rating: undefined, reasonTags: ['quiet'] })],
  events: [
    { id: 'e-0001', suggestionId: 'sg-0001', detectorId: 'M3', timeSec: 12.25, suggestedTimeSec: 12, verdict: 'accept', medal: 'Double Kill' },
    { id: 'e-0002', detectorId: 'N1', timeSec: 33, verdict: 'added' },
    { id: 'e-0003', suggestionId: 'sg-0002', detectorId: 'M1', timeSec: 35, verdict: 'reject' },
  ],
  timing: { highlightPassSec: 1200, eventPassSec: 300 },
});

test('export validates, writes only the label file, and carries no private data', async () => {
  const sid = SID;
  assert.equal((await resetDraft(sid, okDraft())).status, 200);
  await post(`/api/session/${sid}/open-pass2`, { confirm: true });
  rmSync(path.join(dirs.labels, `${sid}.json`), { force: true });
  const r = await exportNow(sid);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const file = path.join(dirs.labels, `${sid}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const v = ajv.compile(schema);
  assert.ok(v(doc), JSON.stringify(v.errors));
  assert.deepEqual(liteValidate(schema, doc), []);
  assert.equal(doc.labels.length, 2);
  assert.ok(doc.labels.every((l) => l.labeller === '<user>'));
  assert.equal(doc.events.length, 3);
  assert.deepEqual(Object.keys(doc.events[0]).sort(), ['detectorId', 'id', 'medal', 'timeSec', 'verdict']);
  assert.deepEqual(doc.timing, { highlightPassSec: 1200, eventPassSec: 300 });
  assert.equal(typeof doc.highlightsEditedAfterSuggestions, 'boolean');
  const text = readFileSync(file, 'utf8');
  assert.ok(!/Zorblax|Quimby|Wibblefrotz|ocrText|suggestionId/.test(text));
  // private scan with a test profile of fake terms: exported file clean, a control file hits
  const scan = (f) => spawnSync(process.execPath, [path.join(repo, 'tools', 'git-hooks', 'private-scan.mjs'), 'scan-files', f, '--profile', profileFile], { encoding: 'utf8', windowsHide: true });
  const clean = scan(file);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const ctl = path.join(tmp, 'control.json');
  writeFileSync(ctl, JSON.stringify({ x: 'zorblax-quimby' }));
  assert.equal(scan(ctl).status, 1);
  assert.equal(statSync(file).isFile(), true);
});

test('export without pass 2 has no events or edited flag, and an existing file needs overwrite', async () => {
  const sid = BAD;
  await resetDraft(sid, { labels: [label('l-0001', 1, 5)], timing: { highlightPassSec: 5, eventPassSec: 0 } });
  const file = path.join(dirs.labels, `${sid}.json`);
  rmSync(file, { force: true });
  assert.equal((await exportNow(sid)).status, 200);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(!('events' in doc) && !('highlightsEditedAfterSuggestions' in doc));
  const again = await exportNow(sid);
  assert.equal(again.status, 409);
  assert.equal((await exportNow(sid, { overwrite: true })).status, 200);
});

// Export of a stored draft that never went through PUT (an old or hand-edited file): refused with 422.
async function expectRefused(patch, needle, { pass2 = true } = {}) {
  const sid = SID;
  rmSync(pass2File(sid), { force: true });
  writeStoredDraft(sid, { timing: { highlightPassSec: 1, eventPassSec: 1 }, ...patch });
  if (pass2) assert.equal((await post(`/api/session/${sid}/open-pass2`, { confirm: true })).status, 200);
  const file = path.join(dirs.labels, `${sid}.json`);
  rmSync(file, { force: true });
  const r = await post(`/api/session/${sid}/export`, {});
  assert.equal(r.status, 422, JSON.stringify(r.json));
  assert.ok(r.json.errors.some((e) => e.includes(needle)), `${needle} in ${JSON.stringify(r.json.errors)}`);
  assert.ok(!existsSync(file), 'refused export must not write a file');
  assert.ok(!JSON.stringify(r.json).includes('Zorblax'));
  const p = await post(`/api/session/${sid}/export-preview`, {});
  assert.equal(p.status, 422, 'the preview refuses it too');
}

test('export refuses invalid labels', async () => {
  await expectRefused({ labels: [label('l-0001', 20, 10)] }, 'not-after-start');
  await expectRefused({ labels: [label('l-0001', 20, 20)] }, 'not-after-start');
  await expectRefused({ labels: [label('l-0001', 5, 9, { rating: 7 })] }, '/labels/0/rating');
  await expectRefused({ labels: [label('l-0001', 5, 9, { reasonTags: ['Bad Tag'] })] }, 'pattern');
  await expectRefused({ labels: [label('l-0001', 5, 99999)] }, 'beyond-session-end');
  // Draft ids are renumbered at export, so duplicate ids are checked on the validator directly.
  const ctx = { schema, pack: loadPackSummary(repo, 'codm'), sessionIds: [SID], durationSec: 60 };
  const doc = buildLabelFile({ labels: [label('x', 5, 9), label('y', 10, 12)], events: [{ detectorId: 'M1', timeSec: 5, verdict: 'added' }, { detectorId: 'N1', timeSec: 6, verdict: 'added' }], timing: { highlightPassSec: 1, eventPassSec: 1 } }, SID, { openedAt: 'x' });
  assert.deepEqual(validateLabelFile(doc, ctx), []);
  const dupL = structuredClone(doc); dupL.labels[1].id = 'l-0001';
  assert.ok(validateLabelFile(dupL, ctx).includes('/labels/1 duplicate-id'));
  const dupE = structuredClone(doc); dupE.events[1].id = 'e-0001';
  assert.ok(validateLabelFile(dupE, ctx).includes('/events/1 duplicate-id'));
  // events without a game pack fail closed
  assert.ok(validateLabelFile(doc, { ...ctx, pack: undefined }).includes('/events no-game-pack-for-session'));
});

test('rating on a reject window never reaches the file; the validator also refuses it', async () => {
  const doc = buildLabelFile({ labels: [label('l-0001', 5, 9, { label: 'reject' })], timing: { highlightPassSec: 1, eventPassSec: 0 } }, SID);
  assert.ok(!('rating' in doc.labels[0]));
  const ctx = { schema, pack: loadPackSummary(repo, 'codm'), sessionIds: [SID], durationSec: 60 };
  assert.deepEqual(validateLabelFile(doc, ctx), []);
  doc.labels[0].rating = 3;
  assert.ok(validateLabelFile(doc, ctx).some((e) => e.includes('forbidden')));
  doc.labels[0].windowEndSec = doc.labels[0].windowStartSec;
  doc.labels[0].rating = undefined;
  assert.ok(validateLabelFile(JSON.parse(JSON.stringify(doc)), ctx).length > 0);
});

test('unknown detectorId and medal are refused at export', async () => {
  const lab = [label('l-0001', 5, 9)];
  await expectRefused({ labels: lab, events: [{ id: 'e-0001', detectorId: 'ZZ9', timeSec: 5, verdict: 'added' }] }, 'detectorId not-in-pack');
  await expectRefused({ labels: lab, events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 5, verdict: 'added', medal: 'Not A Medal' }] }, 'medal not-in-pack');
  await expectRefused({ labels: lab, events: [{ id: 'e-0001', detectorId: 'M1', timeSec: 5, verdict: 'added', medal: 'Double Kill' }] }, 'detector-has-no-catalogue');
  await expectRefused({ labels: lab, events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 5, verdict: 'maybe', medal: 'Double Kill' }] }, 'enum');
  await expectRefused({ labels: lab, events: [{ id: 'e-0001', detectorId: 'm3', timeSec: 5, verdict: 'added' }] }, 'pattern');
  await expectRefused({ labels: lab, events: [{ id: 'e-0001', detectorId: 'M1', timeSec: 99999, verdict: 'added' }] }, 'beyond-session-end');
});

test('the draft cannot become a label file through someone else\'s session id', async () => {
  const r = await put(`/api/session/${SID}/draft`, { sessionId: BAD, labels: [] });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------- writes
test('the server never writes outside the drafts, backups, notes and labels folders', async () => {
  const before = { cache: snapshotTree(dirs.cache), corpus: snapshotTree(dirs.corpus), sugg: snapshotTree(dirs.sugg), top: readdirSync(tmp).sort() };
  const sid = SID;
  await resetDraft(sid, okDraft());
  await post(`/api/session/${sid}/open-pass2`, { confirm: true });
  await req('GET', `/api/session/${sid}/suggestions`);
  await req('GET', `/media/proxy/${sid}`, { headers: { Range: 'bytes=0-99' } });
  await req('GET', `/media/clip/${sid}/0`);
  await req('GET', `/api/session/${sid}/thumb?t=5`);
  await req('GET', `/api/session/${sid}/frame?t=5`);
  await post(`/api/session/${sid}/note`, { ref: 'l-0001', text: 'a note' });
  assert.equal((await exportNow(sid, { overwrite: true })).status, 200);
  assert.equal((await saveDraft(sid, { labels: [], events: [], allowEmpty: true })).status, 200);
  const after = { cache: snapshotTree(dirs.cache), corpus: snapshotTree(dirs.corpus), sugg: snapshotTree(dirs.sugg), top: readdirSync(tmp).sort() };
  assert.deepEqual(after, before);
  // no temp files left behind in the writable folders
  for (const d of [dirs.drafts, dirs.labels, dirs.notes]) assert.ok(allFiles(d).every((n) => !n.endsWith('.tmp')), d);
  assert.ok(allFiles(dirs.drafts).every((n) => /\.(json|lock)$/.test(n)));
  assert.ok(readdirSync(dirs.labels).every((n) => n.endsWith('.json')));
});

// ---------------------------------------------------------------- ffmpeg endpoints
test('frame and thumb endpoints return JPEG from real tiny clips', { skip: !ffmpegOk }, async () => {
  const f = await req('GET', `/api/session/${REAL}/frame?t=1.5`);
  assert.equal(f.status, 200);
  assert.equal(f.headers['content-type'], 'image/jpeg');
  assert.deepEqual([...f.buf.subarray(0, 2)], [0xff, 0xd8]);
  const t = await req('GET', `/api/session/${REAL}/thumb?t=1`);
  assert.equal(t.status, 200);
  assert.deepEqual([...t.buf.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal((await req('GET', `/api/session/${REAL}/frame?t=99`)).status, 400);
  assert.equal((await req('GET', `/api/session/${REAL}/frame?t=abc`)).status, 400);
});

// ---------------------------------------------------------------- schema
test('label schema: fixture validates; events/timing rules; lite validator agrees with ajv', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const v = ajv.compile(schema);
  const fixture = readJson(repo, 'tests', 'fixtures', 'g0', 'labels.example.json');
  const legacy = structuredClone(fixture); delete legacy.events; delete legacy.timing; delete legacy.highlightsEditedAfterSuggestions;
  const cases = [
    [fixture, true], [legacy, true],
    [{ ...fixture, events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 1, verdict: 'accept', medal: 'Double Kill' }] }, true],
    [{ ...fixture, events: [{ id: 'e-12345', detectorId: 'M3', timeSec: 1, verdict: 'accept' }] }, true],
    [{ ...fixture, events: [{ id: 'x-0001', detectorId: 'M3', timeSec: 1, verdict: 'accept' }] }, false],
    [{ ...fixture, events: [{ id: 'e-1', detectorId: 'M3', timeSec: 1, verdict: 'accept' }] }, false],
    [{ ...fixture, events: [{ id: 'e-Name', detectorId: 'M3', timeSec: 1, verdict: 'accept' }] }, false],
    [{ ...fixture, events: [{ id: 'e-0001-x', detectorId: 'M3', timeSec: 1, verdict: 'accept' }] }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[0], id: 'l-Name' }] }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[0], id: 'l-001' }] }, false],
    [{ ...fixture, events: [{ id: 'e-0001', detectorId: 'm3', timeSec: 1, verdict: 'accept' }] }, false],
    [{ ...fixture, events: [{ id: 'e-0001', detectorId: 'M3', timeSec: -1, verdict: 'accept' }] }, false],
    [{ ...fixture, events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 1, verdict: 'skip' }] }, false],
    [{ ...fixture, events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 1, verdict: 'added', text: 'x' }] }, false],
    [{ ...fixture, events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 1, verdict: 'added', medal: 'Bad <name>' }] }, false],
    [{ ...fixture, timing: { highlightPassSec: 1 } }, false],
    [{ ...fixture, timing: { highlightPassSec: -1, eventPassSec: 0 } }, false],
    [{ ...fixture, timing: { highlightPassSec: 1, eventPassSec: 2, other: 3 } }, false],
    [{ ...fixture, highlightsEditedAfterSuggestions: 'yes' }, false],
    [{ ...fixture, version: 2 }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[1], rating: 3 }] }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[0], rating: 6 }] }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[0], labeller: 'jane' }] }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[0], labeller: '<jane>' }] }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[1], note: 'free text' }] }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[1], note: '<nothing-happens>' }] }, false],
    [{ ...fixture, $schema: 'x' }, false],
    [{ ...fixture, labels: [{ ...fixture.labels[0], reasonTags: ['a', 'a'] }] }, false],
  ];
  cases.forEach(([doc, ok], i) => {
    assert.equal(v(doc), ok, `ajv case ${i}`);
    assert.equal(liteValidate(schema, doc).length === 0, ok, `lite case ${i}`);
  });
});

test('label tags file: valid ids, marked unverified', () => {
  const t = readJson(repo, 'data', 'label-tags.json');
  assert.equal(t.status, 'unverified');
  const ids = t.tags.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(t.tags.length <= 12);
  const games = readJson(repo, 'data', 'session-games.json');
  for (const g of Object.values(games.sessions)) assert.ok(existsSync(path.join(repo, 'data', 'games', g, 'game.json')));
});

// ---------------------------------------------------------------- page rules
test('page files follow the overlay rules: plain script, no CDN, no innerHTML, tokens only, licence headers', () => {
  const dir = path.join(repo, 'tools', 'label');
  const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
  const js = readFileSync(path.join(dir, 'label.js'), 'utf8');
  const css = readFileSync(path.join(dir, 'label.css'), 'utf8');
  const coreJs = readFileSync(path.join(dir, 'label-core.js'), 'utf8');
  for (const f of [html, js, css, coreJs]) assert.ok(f.includes('SPDX-License-Identifier: GPL-3.0-or-later'));
  assert.ok(!/https?:\/\//.test(html + css), 'no external URLs in html/css');
  assert.ok(!/type="module"|<script[^>]*src="https?:/.test(html));
  assert.ok(/<script src="\/label-core\.js"><\/script>\s*<script src="\/label\.js"><\/script>/.test(html));
  for (const f of [js, coreJs]) {
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(f));
    assert.ok(!/https?:\/\//.test(f), 'no external URLs in js');
  }
  assert.ok(!/\bdocument\b|\bwindow\b/.test(coreJs), 'label-core.js has no DOM access');
  // colours only inside the :root token block
  const afterRoot = css.slice(css.indexOf('}', css.indexOf(':root')) + 1);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(afterRoot), 'colour literal outside :root');
  // blind protocol in the page: pack and suggestions are fetched only inside loadPass2Data
  const calls = [...js.matchAll(/\/(suggestions|pack)'/g)].length;
  assert.equal(calls, 2);
  const fn = js.slice(js.indexOf('function loadPass2Data'), js.indexOf('// ----', js.indexOf('function loadPass2Data')));
  assert.ok(fn.includes("'/suggestions'") && fn.includes("'/pack'"));
  // keyboard help lists every required shortcut
  for (const k of ['Space', 'J K L', 'I  O', 'Shift+K  Shift+X', 'U  Ctrl+Z', 'Ctrl+S', 'Tab', 'Shift+N']) assert.ok(js.includes(`'${k}'`), k);
});

// ================================================================ review fixes (2026-10-28)
// Condition waits; the cap only ends a hung test. 30 s, not 5 s: spawning node children under a loaded CI machine
// (parallel test files, other apps) took longer than 5 s and failed a correct run.
const waitFor = async (cond, ms = 30000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for: ${String(cond).slice(0, 120)}`); await new Promise((r) => setTimeout(r, 20)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function loadCore() {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(readFileSync(path.join(repo, 'tools', 'label', 'label-core.js'), 'utf8'), ctx);
  return ctx.module.exports;
}
const plain = (x) => JSON.parse(JSON.stringify(x)); // vm-realm arrays to this realm
const deferred = () => { let ok, no; const p = new Promise((a, b) => { ok = a; no = b; }); return { p, ok, no }; };
const labelJs = () => readFileSync(path.join(repo, 'tools', 'label', 'label.js'), 'utf8');
const fnBody = (js, name) => js.slice(js.indexOf(`function ${name}(`), js.indexOf('\n  }\n', js.indexOf(`function ${name}(`)));

test('finding 1 / D1: a draft that cannot be read is a 500 everywhere and is never overwritten', async () => {
  const sid = SID;
  const f = draftFile(sid);
  rmSync(f, { recursive: true, force: true });
  writeFileSync(f, '{"labels": [{"id": "l-0001", "windowStartSec": 1');   // corrupt (truncated) JSON
  const bytes = readFileSync(f);
  assert.equal((await req('GET', `/api/session/${sid}/draft`)).status, 500);
  assert.equal((await put(`/api/session/${sid}/draft`, { sessionId: sid, labels: [], revision: 0 })).status, 500);
  assert.equal((await post(`/api/session/${sid}/open-pass2`, { confirm: true })).status, 500);
  assert.equal((await post(`/api/session/${sid}/export`, { overwrite: true })).status, 500);
  assert.equal((await post(`/api/session/${sid}/export-preview`, {})).status, 500);
  assert.equal((await req('GET', `/api/session/${sid}/suggestions`)).status, 500);
  assert.deepEqual(readFileSync(f), bytes, 'the corrupt draft is left as it was');
  const list = await req('GET', '/api/sessions');
  assert.equal(list.status, 200);
  assert.equal(list.json.sessions.find((s) => s.id === sid).draftError, true);
  // another read error than ENOENT (EISDIR: the draft path is a folder) is treated the same way
  rmSync(f);
  mkdirSync(f);
  assert.equal((await req('GET', `/api/session/${sid}/draft`)).status, 500);
  assert.equal((await put(`/api/session/${sid}/draft`, { sessionId: sid, labels: [], revision: 0 })).status, 500);
  assert.ok(statSync(f).isDirectory());
  rmSync(f, { recursive: true });
  // a parsed draft without a valid revision is not trusted either
  writeFileSync(f, JSON.stringify({ sessionId: sid, labels: [] }));
  assert.equal((await req('GET', `/api/session/${sid}/draft`)).status, 500);
  rmSync(f);
  // only a missing file is an empty draft
  rmSync(pass2File(sid), { force: true });
  const empty = await req('GET', `/api/session/${sid}/draft`);
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.json.labels, empty.json.pass2, empty.json.revision], [[], null, 0]);
});

test('finding 1 / D1 (client): a failed draft load turns autosave off and shows an error', () => {
  const js = labelJs();
  const open = js.slice(js.indexOf('function openSession'), js.indexOf('function loadPass2Data'));
  assert.ok(/function \(e\) \{[\s\S]*saver\.block\(/.test(open), 'the draft-load error path blocks the saver');
  assert.ok(open.includes("class: 'err'"), 'the error is shown in the side panel');
  assert.ok(/canAutosave = function \(\) \{ return S\.draft && saver\.dirty\(\) && !saver\.blocked\(\)/.test(js) && js.includes('setInterval(function () { if (canAutosave()) save(true)'), 'autosave needs a loaded draft and an unblocked saver');
});

test('finding 2 / N1: export renumbers ids in time order and copies only schema fields', async () => {
  const sid = SID;
  const r0 = await resetDraft(sid, {
    timing: { highlightPassSec: 1, eventPassSec: 1 },
    labels: [label('l-0007', 40, 50), label('l-0003', 10, 20)],
    events: [{ id: 'e-0009', detectorId: 'N1', timeSec: 30, verdict: 'added' }, { id: 'e-0002', suggestionId: 'sg-0004', suggestedTimeSec: 11, detectorId: 'M1', timeSec: 12, verdict: 'accept' }],
  });
  assert.equal(r0.status, 200, JSON.stringify(r0.json));
  await post(`/api/session/${sid}/open-pass2`, { confirm: true });
  const file = path.join(dirs.labels, `${sid}.json`);
  rmSync(file, { force: true });
  const r = await exportNow(sid);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(doc.labels.map((l) => [l.id, l.windowStartSec]), [['l-0001', 10], ['l-0002', 40]]);
  assert.deepEqual(doc.events.map((e) => [e.id, e.timeSec]), [['e-0001', 12], ['e-0002', 30]]);
  // every exported field, every level: only these keys, and every string is an id, enum, const, pattern or pack term
  assert.deepEqual(Object.keys(doc).sort(), ['events', 'highlightsEditedAfterSuggestions', 'labels', 'sessionId', 'timing', 'version']);
  for (const l of doc.labels) {
    assert.ok(Object.keys(l).every((k) => ['id', 'windowStartSec', 'windowEndSec', 'label', 'rating', 'reasonTags', 'labeller', 'createdAt'].includes(k)), Object.keys(l).join());
    assert.equal(l.labeller, '<user>');
    assert.ok(l.reasonTags.every((t) => loadTagIds(path.join(repo, 'data', 'label-tags.json')).has(t)));
  }
  for (const e of doc.events) assert.ok(Object.keys(e).every((k) => ['id', 'detectorId', 'timeSec', 'verdict', 'medal'].includes(k)));
  assert.deepEqual(Object.keys(doc.timing).sort(), ['eventPassSec', 'highlightPassSec']);
});

test('finding 2 / N2: a name-shaped id, a labeller or any free-text field is refused by PUT draft (422, pointer)', async () => {
  const sid = BAD;
  await resetDraft(sid, { labels: [label('l-0001', 1, 5)] });
  const bytes = readFileSync(draftFile(sid));
  for (const [patch, at] of [
    [{ labels: [label('l-Zorblax-Quimby', 1, 5)] }, '/labels/0/id pattern'],
    [{ labels: [label('l-0001', 1, 5, { labeller: 'Zorblax' })] }, '/labels/0/labeller unknown-field'],
    [{ labels: [label('l-0001', 1, 5, { note: 'Zorblax Quimby said hi' })] }, '/labels/0/note unknown-field'],
    [{ labels: [label('l-0001', 1, 5)], note: 'Zorblax Quimby said hi' }, '/note unknown-field'],
    [{ labels: [label('l-0001', 1, 5)], local: { anything: 'Wibblefrotz99' } }, '/local unknown-field'],
    [{ labels: [label('l-0001', 1, 5)], events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 2, verdict: 'accept', medal: 'Double Kill', ocrText: 'Zorblax Quimby' }] }, '/events/0/ocrText unknown-field'],
    [{ labels: [label('l-0001', 1, 5)], events: [{ id: 'e-Wibblefrotz99', detectorId: 'N1', timeSec: 2, verdict: 'added' }] }, '/events/0/id pattern'],
    [{ labels: [label('l-0001', 1, 5)], events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 2, verdict: 'accept', medal: 'Zorblax Quimby' }] }, '/events/0/medal not-in-pack'],
    [{ labels: [label('l-0001', 1, 5, { reasonTags: ['zorblax'] })] }, '/labels/0/reasonTags/0 not-in-tags'],
    [{ labels: [label('l-0001', 1, 5)], ui: { t: 3, name: 'Zorblax' } }, '/ui/name unknown-field'],
  ]) {
    const r = await saveDraft(sid, patch);
    assert.equal(r.status, 422, at);
    assert.equal(r.json.error, 'invalid-draft');
    assert.ok(r.json.errors.includes(at), `${at} in ${JSON.stringify(r.json.errors)}`);
    assert.ok(!/Zorblax|Quimby|Wibblefrotz/.test(r.buf.toString()), 'errors never echo values');
  }
  assert.deepEqual(readFileSync(draftFile(sid)), bytes, 'nothing was written');
  assert.ok(!/Zorblax|Quimby|Wibblefrotz/.test(allFiles(dirs.drafts).map((f) => readFileSync(path.join(dirs.drafts, f), 'utf8')).join('\n')));
});

test('finding 2: every reasonTag must be an id in data/label-tags.json (keep and reject ids alike)', async () => {
  await expectRefused({ labels: [label('l-0001', 5, 9, { reasonTags: ['zorblax-quimby'] })] }, '/labels/0/reasonTags/0 not-in-tags');
  const tagsFile = path.join(repo, 'data', 'label-tags.json');
  const ids = readJson(repo, 'data', 'label-tags.json').tags.map((t) => t.id);
  assert.deepEqual([...loadTagIds(tagsFile)].sort(), [...ids].sort());
  const ctx = { schema, pack: loadPackSummary(repo, 'codm'), sessionIds: [SID], durationSec: 60, tagIds: loadTagIds(tagsFile) };
  const doc = buildLabelFile({ labels: [label('a', 5, 9, { reasonTags: ids })], timing: { highlightPassSec: 1, eventPassSec: 0 } }, SID);
  assert.deepEqual(validateLabelFile(doc, ctx), []);
});

test('finding 3 / C3: missing or non-number times are refused at export, never written as 0', async () => {
  await expectRefused({ labels: [label('l-0001', 5, 9, { windowStartSec: undefined })] }, '/labels/0/windowStartSec required');
  await expectRefused({ labels: [label('l-0001', '5', 9)] }, '/labels/0/windowStartSec not-a-finite-number');
  await expectRefused({ labels: [label('l-0001', 5, null)] }, '/labels/0/windowEndSec not-a-finite-number');
  await expectRefused({ labels: [label('l-0001', -2, 9)] }, '/labels/0/windowStartSec negative');
  await expectRefused({ labels: [label('l-0001', 5, 9)], events: [{ id: 'e-0001', detectorId: 'N1', verdict: 'added' }] }, '/events/0/timeSec required');
  await expectRefused({ labels: [label('l-0001', 5, 9)], timing: { highlightPassSec: 'x', eventPassSec: 1 } }, '/timing/highlightPassSec not-a-finite-number');
  await expectRefused({ labels: [label('l-0001', 5, 9)], timing: { highlightPassSec: 1 } }, '/timing/eventPassSec not-a-finite-number');
  const d = buildLabelFile({ labels: [label('l-0001', 5.12345, 9)], timing: { highlightPassSec: 1.23456, eventPassSec: 0 } }, SID);
  assert.deepEqual([d.labels[0].windowStartSec, d.timing.highlightPassSec], [5.123, 1.235]);
});

test('C3: invalid times are a 422 at save time with the field pointer, and nothing is written', async () => {
  const sid = BAD; // 30 s session
  await resetDraft(sid, { labels: [label('l-0001', 1, 5)] });
  const bytes = readFileSync(draftFile(sid));
  for (const [patch, at] of [
    [{ labels: [label('l-0001', 'NaN', 5)] }, '/labels/0/windowStartSec not-a-finite-number'],
    [{ labels: [label('l-0001', 1, null)] }, '/labels/0/windowEndSec not-a-finite-number'],
    [{ labels: [label('l-0001', -1, 5)] }, '/labels/0/windowStartSec negative'],
    [{ labels: [label('l-0001', 1, 31)] }, '/labels/0/windowEndSec beyond-session-end'],
    [{ labels: [label('l-0001', 5, 5)] }, '/labels/0/windowEndSec not-after-start'],
    [{ labels: [label('l-0001', 6, 5)] }, '/labels/0/windowEndSec not-after-start'],
    [{ labels: [label('l-0001', 1, 5, { windowStartSec: undefined })] }, '/labels/0/windowStartSec required'],
    [{ labels: [label('l-0001', 1, 5)], events: [{ id: 'e-0001', detectorId: 'N1', timeSec: -0.5, verdict: 'added' }] }, '/events/0/timeSec negative'],
    [{ labels: [label('l-0001', 1, 5)], events: [{ id: 'e-0001', detectorId: 'N1', timeSec: 99, verdict: 'added' }] }, '/events/0/timeSec beyond-session-end'],
    [{ labels: [label('l-0001', 1, 5)], timing: { highlightPassSec: -3, eventPassSec: 0 } }, '/timing/highlightPassSec negative'],
  ]) {
    const r = await saveDraft(sid, patch);
    assert.equal(r.status, 422, at);
    assert.equal(r.json.at, at, JSON.stringify(r.json));
  }
  assert.deepEqual(readFileSync(draftFile(sid)), bytes);
  // the same check as a function
  assert.deepEqual(checkDraft({ labels: [label('l-0001', 1, 2)] }, { durationSec: 30 }), []);
  assert.ok(checkDraft({ labels: [label('l-0001', 1, Infinity)] }, {}).includes('/labels/0/windowEndSec not-a-finite-number'));
});

test('finding 4: cross-site requests are refused (Sec-Fetch-Site) before any ffmpeg or file work', async () => {
  const before = srv.stats();
  for (const site of ['cross-site', 'same-site']) {
    for (const p of [`/api/session/${SID}/thumb?t=7.7`, `/api/session/${SID}/frame?t=7.7`, `/media/proxy/${SID}`, `/media/clip/${SID}/0`, '/api/sessions', `/api/session/${SID}/draft`]) {
      const r = await req('GET', p, { headers: { 'Sec-Fetch-Site': site } });
      assert.equal(r.status, 403, `${site} ${p}`);
      assert.equal(r.json.error, 'cross-site');
    }
  }
  assert.deepEqual(srv.stats(), before);
  for (const site of ['same-origin', 'none']) assert.equal((await req('GET', '/api/sessions', { headers: { 'Sec-Fetch-Site': site } })).status, 200, site);
  // the page itself can still be opened from a link
  assert.equal((await req('GET', '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
});

test('finding 4 / S2: the ffmpeg queue is 2 running + 50 waiting (503 beyond), a closed request drops its job or kills its ffmpeg', async () => {
  const marks = path.join(tmp, 'ffmpeg-marks');
  mkdirSync(marks, { recursive: true });
  const fake = path.join(tmp, 'fake-ffmpeg.mjs');
  // A fake ffmpeg: records its pid, then waits until it is killed. It never writes output.
  writeFileSync(fake, "import { writeFileSync } from 'node:fs';\nimport path from 'node:path';\nwriteFileSync(path.join(process.argv[2], String(process.pid)), '');\nsetInterval(() => {}, 1000);\n");
  const s2 = await start({ ffmpeg: [process.execPath, fake, marks] }); // default queue limit
  const open = (t) => {
    const r = http.request({ host: '127.0.0.1', port: s2.port, path: `/api/session/${SID}/thumb?t=${t}&tok=${s2.token}`, agent: false });
    r.on('error', () => { /* destroyed on purpose */ });
    r.end();
    return r;
  };
  try {
    const running = [open(1), open(2)];
    await waitFor(() => s2.stats().ffmpegActive === 2 && readdirSync(marks).length === 2);
    const queued = Array.from({ length: 50 }, (_, i) => open(3 + i * 0.1));
    await waitFor(() => s2.stats().ffmpegQueued === 50);
    const over = await req('GET', `/api/session/${SID}/thumb?t=9`, { at: s2.port });
    assert.equal(over.status, 503);
    assert.equal(over.json.error, 'busy');
    // closing the queued requests drops their jobs; no ffmpeg is started for them
    queued.forEach((r) => r.destroy());
    await waitFor(() => s2.stats().ffmpegQueued === 0);
    assert.equal(s2.stats().ffmpegActive, 2);
    assert.equal(readdirSync(marks).length, 2);
    // closing the running requests kills their ffmpeg processes
    const pids = readdirSync(marks).map(Number);
    assert.ok(pids.every(alive));
    running.forEach((r) => r.destroy());
    await waitFor(() => s2.stats().ffmpegActive === 0);
    await waitFor(() => pids.every((pid) => !alive(pid)));
    assert.equal(readdirSync(marks).length, 2, 'no queued job started after the kills');
  } finally {
    await s2.close();
  }
});

test('findings 5 and 6: client saves run one at a time, reject on failure, and keep edits made in flight dirty', async () => {
  const core = loadCore();
  const s = core.createSaver();
  assert.equal(await s.save(() => { throw new Error('must not send when clean'); }), null);
  const order = [];
  s.edit();
  const started1 = deferred(), reply1 = deferred(), reply2 = deferred();
  const p1 = s.save(() => { order.push('send1'); started1.ok(); return reply1.p; });
  await started1.p;
  s.edit(); // an edit while save 1 is in flight
  const p2 = s.save(() => { order.push('send2'); return reply2.p; });
  await sleep(20);
  assert.deepEqual(order, ['send1'], 'save 2 waits for save 1');
  reply1.ok('r1');
  assert.equal(await p1, 'r1');
  assert.equal(s.dirty(), true, 'the in-flight edit is still dirty after save 1');
  await waitFor(() => order.length === 2);
  reply2.ok('r2');
  assert.equal(await p2, 'r2');
  assert.equal(s.dirty(), false);
  // a failed save rejects and stays dirty; the queue keeps working
  s.edit();
  await assert.rejects(s.save(() => Promise.reject(new Error('http 500'))), /http 500/);
  assert.equal(s.dirty(), true);
  assert.equal(await s.save(() => Promise.resolve('ok')), 'ok');
  assert.equal(s.dirty(), false);
  // queue() runs after the pending save, in order
  s.edit();
  const reply3 = deferred();
  const seq = [];
  const p3 = s.save(() => { seq.push('save'); return reply3.p; });
  const q = s.queue(() => { seq.push('open-pass2'); return 'q'; });
  await sleep(20);
  assert.deepEqual(seq, ['save']);
  reply3.ok('r3');
  assert.deepEqual([await p3, await q], ['r3', 'q']);
  assert.deepEqual(seq, ['save', 'open-pass2']);
});

test('finding 7: an async result from a previous session is ignored', async () => {
  const core = loadCore();
  assert.equal(core.sameSession('s-a', 's-a'), true);
  assert.equal(core.sameSession('s-a', 's-b'), false);
  assert.equal(core.sameSession(null, null), false);
  // a save that completes after a session switch does not mark the new session clean
  const s = core.createSaver();
  s.edit();
  const started = deferred(), reply = deferred();
  const p = s.save(() => { started.ok(); return reply.p; });
  await started.p;
  s.reset();
  s.edit();
  reply.ok('old');
  await p;
  assert.equal(s.dirty(), true);
  // label.js: the session is captured at confirm time and every pass-2 result checks it
  const js = labelJs();
  const yes = js.slice(js.indexOf('yes: function () {\n        // The session is fixed'), js.indexOf('function gotoPass'));
  assert.ok(yes.includes('var id = S.id, draft = S.draft;'));
  assert.ok(yes.includes("encodeURIComponent(id) + '/open-pass2'"));
  assert.ok(yes.includes('loadPass2Data(id)') && yes.includes('core.sameSession(id, S.id)'));
  assert.ok(!js.includes("base() + '/open-pass2'"));
  const l2 = js.slice(js.indexOf('function loadPass2Data'), js.indexOf('// ----', js.indexOf('function loadPass2Data')));
  assert.ok(l2.indexOf('if (!core.sameSession(id, S.id)) return false;') < l2.indexOf('S.pack = r[0]'));
  assert.ok(l2.includes('(r[1] && r[1].suggestions) || []'), 'finding 12 (client)');
});

test('finding 8 / C2: PUT draft with a stale revision is 409 and never merges; the stored draft is kept', async () => {
  const sid = REV;
  rmSync(draftFile(sid), { force: true });
  const base = (await req('GET', `/api/session/${sid}/draft`)).json;
  assert.equal(base.revision, 0);
  const a = await put(`/api/session/${sid}/draft`, { ...base, labels: [label('l-0001', 1, 2)] });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.revision, 1);
  const b = await put(`/api/session/${sid}/draft`, { ...base, labels: [label('l-0002', 3, 4)] }); // second tab, old base
  assert.equal(b.status, 409);
  assert.equal(b.json.error, 'draft-changed');
  for (const revision of [undefined, null, '1', 1.5, 2, -1]) {
    const r = await put(`/api/session/${sid}/draft`, { ...a.json, revision, labels: [label('l-0002', 3, 4)] });
    assert.ok(r.status === 409 || r.status === 422, `revision ${revision} -> ${r.status}`);
  }
  const stored = JSON.parse(readFileSync(draftFile(sid), 'utf8'));
  assert.deepEqual(stored.labels.map((l) => l.id), ['l-0001'], 'no merge of the refused saves');
  const c = await put(`/api/session/${sid}/draft`, { ...a.json, labels: [label('l-0001', 3, 4)] }); // after reload
  assert.equal(c.status, 200);
  assert.equal(c.json.revision, 2);
  // opening pass 2 does not touch the draft revision (the pass-2 record is its own file)
  const o = await post(`/api/session/${sid}/open-pass2`, { confirm: true });
  assert.equal(o.json.revision, 2);
  assert.equal((await put(`/api/session/${sid}/draft`, { ...c.json })).status, 200);
  const js = labelJs();
  assert.ok(js.includes("r.status === 409 && j.error === 'draft-changed'"));
  assert.ok(js.includes('draft.revision = d.revision') && !js.includes('updatedAt'));
});

test('finding 9 / S3: startup refuses writable folders that overlap the cache or corpus, and drafts or notes not gitignored', async () => {
  const refuse = async (o, why) => assert.rejects(startServer(serverOpts(o)), (e) => e.code === 'unsafe-folders', why);
  await refuse({ draftsRoot: path.join(dirs.cache, 'drafts') }, 'drafts inside the cache');
  await refuse({ notesRoot: path.join(dirs.corpus, 'notes') }, 'notes inside the corpus');
  await refuse({ labelsDir: path.join(dirs.corpus, 'labels') }, 'labels inside the corpus');
  await refuse({ labelsDir: dirs.cache }, 'labels = cache');
  await refuse({ cacheDir: path.join(dirs.labels, 'cache') }, 'cache inside labels');
  await refuse({ cacheDir: path.join(dirs.drafts, 'backups', 'x') }, 'cache inside the backups folder');
  await refuse({ corpusDir: path.join(dirs.notes, 'c') }, 'corpus inside notes');
  await refuse({ corpusDir: tmp }, 'writable folders inside the corpus');
  assert.ok(!existsSync(path.join(dirs.cache, 'drafts')) && !existsSync(path.join(dirs.corpus, 'labels')) && !existsSync(path.join(dirs.corpus, 'notes')), 'a refused start creates nothing');
  // a junction that points into the cache is caught through the real path
  const link = path.join(tmp, 'link-to-cache');
  let linked = false;
  try { symlinkSync(dirs.cache, link, 'junction'); linked = true; } catch { /* no junction support: skip this case */ }
  if (linked) {
    await refuse({ draftsRoot: path.join(link, 'drafts') }, 'drafts through a junction into the cache');
    await refuse({ notesRoot: link }, 'notes = a junction to the cache');
    rmSync(link, { recursive: true, force: true });
    assert.ok(existsSync(path.join(dirs.cache, SID, 'manifest.json')));
  }
  // drafts and notes folders inside the repository must be gitignored
  const notIgnored = path.join(repo, 'tools', 'label', '__drafts-test-not-ignored__');
  await refuse({ draftsRoot: notIgnored }, 'drafts in the repo, not ignored');
  await refuse({ notesRoot: notIgnored }, 'notes in the repo, not ignored');
  assert.ok(!existsSync(notIgnored));
  const ignored = path.join(repo, 'data', 'games', 'codm', 'local', `.label-test-drafts-${process.pid}`);
  try {
    const ok = await startServer(serverOpts({ draftsRoot: ignored, notesRoot: path.join(ignored, 'notes') }));
    await ok.close();
    assert.ok(existsSync(ignored));
  } finally { rmSync(ignored, { recursive: true, force: true }); }
});

test('S3: a junction placed in a writable folder after startup is refused at write time', async (t) => {
  const sid = REV;
  const bdir = backupsOf(sid);
  rmSync(bdir, { recursive: true, force: true });
  try { symlinkSync(path.join(dirs.cache, SID), bdir, 'junction'); } catch { t.skip('no junction support'); return; }
  const before = snapshotTree(dirs.cache);
  try {
    const cur = (await req('GET', `/api/session/${sid}/draft`)).json;
    const r = await put(`/api/session/${sid}/draft`, { ...cur, labels: [label('l-0001', 1, 2)] });
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'unsafe-write');
    assert.deepEqual(snapshotTree(dirs.cache), before, 'nothing was written into the cache');
    assert.deepEqual((await req('GET', `/api/session/${sid}/draft`)).json.revision, cur.revision, 'the draft was not saved either');
  } finally { rmSync(bdir, { recursive: true, force: true }); }
});

test('finding 11: Enter and Space on a focused button outside a modal are ignored; clicks drop the focus', () => {
  const core = loadCore();
  const btn = { tagName: 'BUTTON' };
  for (const k of ['Enter', ' ', 'Spacebar']) assert.equal(core.isButtonActivationKey(btn, false, k), true, k);
  assert.equal(core.isButtonActivationKey(btn, true, 'Enter'), false, 'inside a modal the dialog keys work');
  assert.equal(core.isButtonActivationKey(btn, false, 'a'), false);
  assert.equal(core.isButtonActivationKey({ tagName: 'DIV' }, false, ' '), false);
  assert.equal(core.isButtonActivationKey(null, false, ' '), false);
  const js = labelJs();
  assert.ok(js.includes('if (core.isButtonActivationKey(tg, Boolean(S.modal), e.key)) { e.preventDefault(); tg.blur(); return; }'));
  assert.ok(js.indexOf('core.isButtonActivationKey(tg') < js.indexOf('if (S.modal) { modalKey(e); return; }'), 'checked before the shortcuts');
  assert.ok(/closest\('button'\)[\s\S]{0,40}b\.blur\(\)/.test(js));
});

test('finding 13: PUT draft refuses a bad shape with 422 and writes nothing', async () => {
  const sid = BAD;
  const cur = (await req('GET', `/api/session/${sid}/draft`)).json;
  const bytes = existsSync(draftFile(sid)) ? readFileSync(draftFile(sid)) : null;
  const bad = [
    [{ labels: 'x' }, '/labels not-array'], [{ events: {} }, '/events not-array'],
    [{ labels: [1] }, '/labels/0 not-object'], [{ labels: [[]] }, '/labels/0 not-object'],
    [{ labels: [{ reasonTags: 'multi-kill' }] }, '/labels/0/reasonTags not-string-array'],
    [{ labels: [{ reasonTags: [1] }] }, '/labels/0/reasonTags not-string-array'],
    [{ events: [null] }, '/events/0 not-object'], [{ timing: 5 }, '/timing not-object'], [{ ui: [] }, '/ui not-object'],
  ];
  for (const [patch, at] of bad) {
    const r = await put(`/api/session/${sid}/draft`, { ...cur, ...patch });
    assert.equal(r.status, 422, at);
    assert.equal(r.json.error, 'invalid-draft');
    assert.ok(r.json.errors.includes(at), `${at} in ${JSON.stringify(r.json.errors)}`);
  }
  assert.deepEqual(existsSync(draftFile(sid)) ? readFileSync(draftFile(sid)) : null, bytes);
});

test('finding 14: an oversized body gets a 413 response before the request is dropped', async () => {
  const raw = (text) => new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let out = '';
    s.on('data', (c) => { out += c; });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(text);
  });
  const r = await raw(`PUT /api/session/${SID}/draft HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Label-Token: ${srv.token}\r\nX-Label-Tab: ${TAB}\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\n\r\n{"sessionId":`);
  assert.match(r, /^HTTP\/1\.1 413 /);
  assert.match(r, /"error":"too-large"/);
});

test('finding 15: a multi-range or unknown-unit Range is ignored (200, whole file)', async () => {
  for (const r of ['bytes=0-1,5-6', 'items=0-1', 'pages=1']) {
    const x = await req('GET', `/media/proxy/${SID}`, { headers: { Range: r } });
    assert.equal(x.status, 200, r);
    assert.equal(x.headers['content-range'], undefined);
    assert.deepEqual(x.buf, proxyBytes);
  }
  const upper = await req('GET', `/media/proxy/${SID}`, { headers: { Range: 'Bytes=0-9' } });
  assert.equal(upper.status, 206);
});

test('finding 16: a zero-byte file is an empty 200, with or without Range', async () => {
  for (const p of [`/media/proxy/${ZERO}`, `/media/clip/${ZERO}/0`]) {
    for (const headers of [{}, { Range: 'bytes=0-' }, { Range: 'bytes=-5' }]) {
      const r = await req('GET', p, { headers });
      assert.equal(r.status, 200, `${p} ${JSON.stringify(headers)}`);
      assert.equal(r.headers['content-length'], '0');
      assert.equal(r.buf.length, 0);
    }
  }
});

// ================================================================ review fixes round 2 (2026-10-28)
test('D2: the server refuses to replace a non-empty draft with an empty one unless allowEmpty:true', async () => {
  const sid = REV;
  rmSync(draftFile(sid), { force: true });
  rmSync(pass2File(sid), { force: true });
  assert.equal((await saveDraft(sid, { labels: [] })).status, 200, 'empty over empty is fine');
  assert.equal((await saveDraft(sid, { labels: [label('l-0001', 1, 2)], events: [{ id: 'e-0001', detectorId: 'N1', timeSec: 3, verdict: 'added' }] })).status, 200);
  const bytes = readFileSync(draftFile(sid));
  for (const [patch, at] of [[{ labels: [] }, '/labels'], [{ events: [] }, '/events'], [{ labels: undefined }, '/labels'], [{ labels: [], events: [] }, '/labels'], [{ labels: [], allowEmpty: false }, '/labels']]) {
    const r = await saveDraft(sid, patch);
    assert.equal(r.status, 409, JSON.stringify(patch));
    assert.deepEqual([r.json.error, r.json.at], ['would-empty-draft', at]);
  }
  assert.deepEqual(readFileSync(draftFile(sid)), bytes, 'the non-empty draft is kept');
  assert.equal((await saveDraft(sid, { allowEmpty: 'yes', labels: [] })).status, 422, 'allowEmpty must be a boolean');
  const ok = await saveDraft(sid, { labels: [], allowEmpty: true });
  assert.equal(ok.status, 200);
  assert.ok(!('allowEmpty' in JSON.parse(readFileSync(draftFile(sid), 'utf8'))), 'the flag is not stored');
  assert.deepEqual(ok.json.labels, []);
  assert.equal(ok.json.events.length, 1);
});

test('D2 (client): never sends an emptying save without the confirm; deleting or undoing the last item asks first', () => {
  const core = loadCore();
  assert.deepEqual(plain(core.wouldEmpty({ labels: 2, events: 0 }, { labels: [], events: [] })), ['labels']);
  assert.deepEqual(plain(core.wouldEmpty({ labels: 1, events: 1 }, { labels: [{}], events: [] })), ['events']);
  assert.deepEqual(plain(core.wouldEmpty({ labels: 0, events: 0 }, { labels: [], events: [] })), []);
  assert.deepEqual(plain(core.wouldEmpty({ labels: 3, events: 0 }, { labels: [{}] })), []);
  const js = labelJs();
  const body = fnBody(js, 'draftBody');
  assert.ok(body.includes('core.wouldEmpty(S.savedCounts, draft)') && body.includes("if (em.length && !allowEmpty) throw"), 'save refuses before sending');
  assert.ok(body.includes('body.allowEmpty = true'));
  assert.ok(fnBody(js, 'save').includes('draftBody(draft)'), 'save builds its body with draftBody');
  assert.ok(fnBody(js, 'deleteSelected').includes('confirmIfEmptying('), 'delete asks before emptying a list');
  assert.ok(fnBody(js, 'undo').includes('confirmIfEmptying('), 'undo asks before emptying a list');
  assert.ok(fnBody(js, 'confirmIfEmptying').includes("openModal('confirm'"));
});

test('D3: every save writes atomically and keeps a backup; 25 saves leave the last 20 backups, each parses', async () => {
  const sid = REV;
  rmSync(draftFile(sid), { force: true });
  rmSync(pass2File(sid), { force: true });
  rmSync(backupsOf(sid), { recursive: true, force: true });
  let cur = (await req('GET', `/api/session/${sid}/draft`)).json;
  for (let i = 1; i <= 25; i++) {
    const r = await put(`/api/session/${sid}/draft`, { ...cur, labels: [label('l-0001', 1, 1 + i)] });
    assert.equal(r.status, 200);
    cur = r.json;
  }
  assert.equal(cur.revision, 25);
  const names = readdirSync(backupsOf(sid)).sort();
  assert.equal(names.length, 20);
  assert.deepEqual(names, Array.from({ length: 20 }, (_, i) => `r${String(i + 6).padStart(8, '0')}.json`));
  for (const n of names) {
    const d = JSON.parse(readFileSync(path.join(backupsOf(sid), n), 'utf8'));
    assert.equal(d.revision, Number(n.slice(1, 9)));
    assert.equal(d.labels[0].windowEndSec, 1 + d.revision);
  }
  assert.deepEqual(JSON.parse(readFileSync(path.join(backupsOf(sid), names[19]), 'utf8')), JSON.parse(readFileSync(draftFile(sid), 'utf8')), 'the newest backup is the stored draft');
  assert.ok(readdirSync(dirs.drafts).every((n) => !n.endsWith('.tmp')));
  // the backups folder is next to the drafts, so a drafts folder in the repository must be gitignored (finding 9)
  const g = spawnSync('git', ['-C', repo, 'check-ignore', '-q', path.join(repo, 'data', 'games', 'codm', 'local', 'labels-draft', 'backups', 'x', 'r00000001.json')], { windowsHide: true });
  assert.equal(g.status, 0, 'default backups path is gitignored');
});

test('D4: the pass-2 record is its own file, written only by open-pass2 and the edited-after detection', async () => {
  const sid = REV;
  rmSync(draftFile(sid), { force: true });
  rmSync(pass2File(sid), { force: true });
  await saveDraft(sid, { labels: [label('l-0001', 1, 2)] });
  assert.ok(!existsSync(pass2File(sid)));
  const o = await post(`/api/session/${sid}/open-pass2`, { confirm: true });
  const p2 = JSON.parse(readFileSync(pass2File(sid), 'utf8'));
  assert.deepEqual(o.json.pass2, p2);
  assert.ok(!('pass2' in JSON.parse(readFileSync(draftFile(sid), 'utf8'))), 'not stored in the draft');
  const bytes = readFileSync(pass2File(sid));
  // no draft PUT can clear or change it
  for (const pass2 of [null, {}, { openedAt: null }, { ...p2, highlightsEditedAfter: true }, { ...p2, highlightsEditedAfter: false, labelsHash: 'x' }]) {
    const r = await saveDraft(sid, { pass2, labels: [label('l-0001', 1, 2)] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.pass2, p2);
  }
  assert.deepEqual(readFileSync(pass2File(sid)), bytes);
  // the edited-after detection is the only other writer
  const e = await saveDraft(sid, { labels: [label('l-0001', 1, 3)] });
  assert.equal(e.json.pass2.highlightsEditedAfter, true);
  assert.equal(JSON.parse(readFileSync(pass2File(sid), 'utf8')).highlightsEditedAfter, true);
  // opening again does not reset it
  await post(`/api/session/${sid}/open-pass2`, { confirm: true });
  assert.equal(JSON.parse(readFileSync(pass2File(sid), 'utf8')).highlightsEditedAfter, true);
});

test('D4: a pass-2 file that cannot be read is a 500 for suggestions, export and PUT, and is never touched', async () => {
  const sid = REV;
  writeFileSync(path.join(dirs.sugg, `${sid}.json`), JSON.stringify({ version: 1, sessionId: sid, suggestions: [] }));
  const draftBytes = readFileSync(draftFile(sid));
  for (const content of ['{"openedAt": "2026-', '[]', '{"labelsHash": "x"}', null]) {
    rmSync(pass2File(sid), { recursive: true, force: true });
    if (content === null) mkdirSync(pass2File(sid)); else writeFileSync(pass2File(sid), content); // null: EISDIR
    const cur = { sessionId: sid, revision: JSON.parse(draftBytes).revision, labels: [label('l-0001', 1, 2)] };
    assert.equal((await req('GET', `/api/session/${sid}/suggestions`)).status, 500, `suggestions ${content}`);
    assert.equal((await post(`/api/session/${sid}/export`, { overwrite: true })).status, 500, `export ${content}`);
    assert.equal((await post(`/api/session/${sid}/export-preview`, {})).status, 500);
    assert.equal((await put(`/api/session/${sid}/draft`, cur)).status, 500, `PUT ${content}`);
    assert.equal((await post(`/api/session/${sid}/open-pass2`, { confirm: true })).status, 500);
    assert.equal((await req('GET', `/api/session/${sid}/draft`)).json.error, 'pass2-unreadable');
    if (content !== null) assert.equal(readFileSync(pass2File(sid), 'utf8'), content, 'left as it was');
  }
  assert.deepEqual(readFileSync(draftFile(sid)), draftBytes);
  rmSync(pass2File(sid), { recursive: true, force: true });
});

test('N2: notes go only to the local notes file; never into the draft or the export', async () => {
  const sid = BAD;
  await resetDraft(sid, { labels: [label('l-0001', 1, 5)], timing: { highlightPassSec: 1, eventPassSec: 0 } });
  const notesFile = path.join(dirs.notes, `${sid}.jsonl`);
  rmSync(notesFile, { force: true });
  const n = await post(`/api/session/${sid}/note`, { ref: 'l-0001', text: 'Zorblax Quimby was in this one' });
  assert.equal(n.status, 200);
  assert.equal((await post(`/api/session/${sid}/note`, { ref: 'sg-0003', text: 'second' })).status, 200);
  const lines = readFileSync(notesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.ref, l.text]), [['l-0001', 'Zorblax Quimby was in this one'], ['sg-0003', 'second']]);
  assert.ok(lines.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l.t)));
  assert.deepEqual((await req('GET', `/api/session/${sid}/notes`)).json.notes.map((x) => x.ref), ['l-0001', 'sg-0003']);
  for (const [body, at] of [[{ ref: 'Zorblax', text: 'x' }, '/ref'], [{ ref: 'l-0001', text: '' }, '/text'], [{ ref: 'l-0001', text: 'x'.repeat(2001) }, '/text'], [{ ref: 'l-0001' }, '/text']]) {
    const r = await post(`/api/session/${sid}/note`, body);
    assert.deepEqual([r.status, r.json.at], [422, at]);
  }
  assert.equal((await post(`/api/session/${sid}/note`, { ref: 'l-0001', text: 'x' }, { tab: TAB2 })).status, 423, 'only the lock owner adds notes');
  // the draft and the export never carry it
  const file = path.join(dirs.labels, `${sid}.json`);
  rmSync(file, { force: true });
  assert.equal((await exportNow(sid)).status, 200);
  assert.ok(!/Zorblax|note/i.test(readFileSync(file, 'utf8')));
  assert.ok(!/Zorblax/.test(readFileSync(draftFile(sid), 'utf8')));
  // the default notes folder is gitignored
  const g = spawnSync('git', ['-C', repo, 'check-ignore', '-q', path.join(repo, 'data', 'games', 'codm', 'local', 'label-notes', `${sid}.jsonl`)], { windowsHide: true });
  assert.equal(g.status, 0);
  // the page sends notes to the notes route only, and the draft has no note field
  const js = labelJs();
  assert.ok(fnBody(js, 'openNote').includes("'/note'"));
  assert.ok(!/\.note\s*=/.test(js), 'no note field is set on a draft item');
});

test('S1: a per-launch token guards every API, media, frame and thumb route; static files load without it', async () => {
  assert.match(srv.token, /^[0-9a-f]{64}$/);
  assert.equal(srv.pageUrl, `http://127.0.0.1:${port}/?t=${srv.token}`);
  const other = await start();
  try { assert.notEqual(other.token, srv.token, 'a new token per launch'); } finally { await other.close(); }
  const wrong = 'f'.repeat(64) === srv.token ? 'e'.repeat(64) : 'f'.repeat(64);
  const routes = [
    ['GET', '/api/sessions'], ['GET', '/api/tags'], ['GET', `/api/session/${SID}/manifest`], ['GET', `/api/session/${SID}/draft`],
    ['GET', `/api/session/${SID}/pack`], ['GET', `/api/session/${SID}/suggestions`], ['GET', `/api/session/${SID}/notes`],
    ['PUT', `/api/session/${SID}/draft`], ['POST', `/api/session/${SID}/lock`], ['POST', `/api/session/${SID}/unlock`],
    ['POST', `/api/session/${SID}/open-pass2`], ['POST', `/api/session/${SID}/export`], ['POST', `/api/session/${SID}/export-preview`],
    ['POST', `/api/session/${SID}/note`], ['GET', `/api/session/${SID}/thumb?t=1`], ['GET', `/api/session/${SID}/frame?t=1`],
    ['GET', `/media/proxy/${SID}`], ['GET', `/media/clip/${SID}/0`],
  ];
  const before = srv.stats();
  for (const [m, p] of routes) {
    for (const token of [null, wrong, srv.token.slice(0, 63), srv.token + '0', srv.token.toUpperCase()]) {
      const r = await req(m, p, { token, body: m === 'GET' ? undefined : {} });
      assert.equal(r.status, 401, `${m} ${p} token=${token && token.length}`);
      assert.equal(r.json.error, 'bad-token');
    }
  }
  assert.deepEqual(srv.stats(), before, 'no ffmpeg started without the token');
  // the query parameter works only on element-src routes (media, frame, thumb), never on the JSON API
  assert.equal((await req('GET', `/media/proxy/${SID}?tok=${srv.token}`, { token: null })).status, 200);
  assert.equal((await req('GET', `/media/clip/${SID}/0?tok=${srv.token}`, { token: null })).status, 200);
  assert.equal((await req('GET', `/api/session/${SID}/thumb?t=99999&tok=${srv.token}`, { token: null })).status, 400, 'past the token check');
  for (const p of ['/api/sessions', `/api/session/${SID}/draft`, `/api/session/${SID}/manifest`]) {
    assert.equal((await req('GET', `${p}?tok=${srv.token}`, { token: null })).status, 401, p);
  }
  // static page files load without it and carry no data
  for (const p of ['/', '/index.html', '/label.js', '/label-core.js', '/label.css', `/?t=${wrong}`]) {
    const r = await req('GET', p, { token: null });
    assert.equal(r.status, 200, p);
    assert.ok(!r.buf.toString().includes(srv.token), 'the token is not in a static file');
    assert.ok(!/s-test-|Zorblax|labelsHash/.test(r.buf.toString()), 'no session data in a static file');
  }
  // constant-time compare (timing itself is not unit-tested): equal-length hashes through timingSafeEqual
  const server = readFileSync(path.join(repo, 'tools', 'label', 'server.mjs'), 'utf8');
  assert.ok(/timingSafeEqual\(sha256\(given\), tokenHash\)/.test(server) && server.includes('randomBytes(32).toString(\'hex\')'));
  // the page sends the header on fetch and ?tok= only on element src
  const js = labelJs();
  assert.ok(js.includes("'X-Label-Token': TOKEN") && js.includes('core.readToken(location.search)'));
  assert.ok(js.includes("video.src = srcUrl('/media/proxy/'") && js.includes("img.src = srcUrl(base() + '/frame") && js.includes("src: srcUrl(base() + '/thumb"));
  const core = loadCore();
  assert.equal(core.readToken(`?t=${srv.token}`), srv.token);
  assert.equal(core.readToken(`?x=1&t=${srv.token}`), srv.token);
  for (const s of ['', '?t=abc', `?t=${srv.token}0`, `?tt=${srv.token}`, `?t=${srv.token.toUpperCase()}`]) assert.equal(core.readToken(s), null, s);
});

test('C1: one writer per session; a second tab is read-only; stale takeover needs a confirm; released on close', async () => {
  const sid = LOCKS;
  const s3 = await start({ lockStaleMs: 300 });
  const at = s3.port;
  const o = { at };
  try {
    const a = await lock(sid, o);
    assert.deepEqual(a.json, { writer: true });
    const lockFile = path.join(dirs.drafts, `${sid}.lock`);
    const lf = JSON.parse(readFileSync(lockFile, 'utf8'));
    assert.deepEqual([lf.launchId, lf.tab, lf.pid], [s3.launchId, TAB, process.pid]);
    assert.ok(lf.heartbeatAt);
    // a second tab gets read-only and cannot write
    const b = await lock(sid, { ...o, tab: TAB2 });
    assert.deepEqual(b.json, { writer: false, stale: false });
    assert.equal((await lock(sid, { ...o, tab: TAB2, takeover: true })).json.writer, false, 'a fresh lock cannot be taken over');
    const cur = (await req('GET', `/api/session/${sid}/draft`, o)).json;
    for (const [m, p, body] of [['PUT', 'draft', { ...cur, labels: [label('l-0001', 1, 2)] }], ['POST', 'open-pass2', { confirm: true }], ['POST', 'export', { overwrite: true }], ['POST', 'note', { ref: 'l-0001', text: 'x' }]]) {
      const r = await req(m, `/api/session/${sid}/${p}`, { ...o, tab: TAB2, body });
      assert.deepEqual([r.status, r.json.error], [423, 'not-lock-owner'], p);
    }
    assert.equal((await req('PUT', `/api/session/${sid}/draft`, { ...o, tab: null, body: cur })).status, 400, 'a write without a tab id');
    // the owner writes; its heartbeat keeps the lock fresh
    assert.equal((await put(`/api/session/${sid}/draft`, { ...cur, labels: [label('l-0001', 1, 2)] }, o)).status, 200);
    // no heartbeat for longer than the stale time: the second tab sees "stale" and must confirm
    await sleep(400);
    const st = await lock(sid, { ...o, tab: TAB2 });
    assert.deepEqual(st.json, { writer: false, stale: true });
    const tk = await lock(sid, { ...o, tab: TAB2, takeover: true });
    assert.deepEqual(tk.json, { writer: true, tookOver: true });
    // the old owner is now out
    const d1 = (await req('GET', `/api/session/${sid}/draft`, o)).json;
    assert.equal((await put(`/api/session/${sid}/draft`, { ...d1, labels: [label('l-0001', 1, 3)] }, o)).status, 423);
    assert.equal((await lock(sid, o)).json.writer, false, 'and its heartbeat does not win it back');
    // release: a save still in flight within the grace time is accepted; the next tab is told to retry
    assert.deepEqual((await post(`/api/session/${sid}/unlock`, {}, { ...o, tab: TAB2 })).json, { released: true });
    assert.equal((await put(`/api/session/${sid}/draft`, { ...d1, labels: [label('l-0001', 1, 4)] }, { ...o, tab: TAB2 })).status, 200);
    const wait = await lock(sid, o);
    assert.equal(wait.json.writer, false);
    assert.ok(wait.json.retryMs > 0 && wait.json.retryMs <= 2100);
    await sleep(wait.json.retryMs);
    assert.deepEqual((await lock(sid, o)).json, { writer: true });
    // a lock from a launch whose process is gone is stale at once
    writeFileSync(lockFile, JSON.stringify({ launchId: 'f'.repeat(32), tab: TAB2, pid: 2 ** 22 + 12345, heartbeatAt: new Date().toISOString() }));
    assert.deepEqual((await lock(sid, o)).json, { writer: false, stale: true });
    assert.equal((await lock(sid, { ...o, takeover: true })).json.writer, true);
    // a broken lock file is stale too (takeover only after the confirm)
    writeFileSync(lockFile, '{broken');
    assert.deepEqual((await lock(sid, { ...o, tab: TAB2 })).json, { writer: false, stale: true });
    assert.equal((await lock(sid, o)).json.writer, false);
    assert.equal((await lock(sid, { ...o, takeover: true })).json.writer, true);
    // a lock held by another live launch (this test process) with a fresh heartbeat is respected
    const s4 = await start({ lockStaleMs: 60000 });
    try {
      assert.deepEqual((await lock(sid, { at: s4.port })).json, { writer: false, stale: false });
    } finally { await s4.close(); }
    // closing the launch releases its locks
    await s3.close();
    assert.ok(!existsSync(lockFile), 'released on close');
  } finally { await s3.close(); }
  // client: read-only shows a notice and blocks saves; stale takeover only from the confirm dialog; released on pagehide
  const js = labelJs();
  const apply = fnBody(js, 'applyLock');
  assert.ok(apply.includes('takeover: true') && apply.indexOf("openModal('confirm'") < apply.indexOf('takeover: true'), 'takeover is sent from the confirm only');
  assert.ok(fnBody(js, 'setReadOnly').includes('saver.block(') && js.includes("'Read-only: ' + S.readOnlyWhy"));
  assert.ok(/addEventListener\('pagehide'[\s\S]{0,900}'unlock'/.test(js));
  assert.ok(fnBody(js, 'pushUndo').includes('canEdit()'));
});

test('C4: export-preview returns the diff without writing; export needs overwrite after it; client confirms and debounces', async () => {
  const sid = SID;
  await resetDraft(sid, { labels: [label('l-0001', 10, 20), label('l-0002', 30, 40), label('l-0003', 50, 55)], timing: { highlightPassSec: 1, eventPassSec: 0 } });
  const file = path.join(dirs.labels, `${sid}.json`);
  rmSync(file, { force: true });
  const p0 = await post(`/api/session/${sid}/export-preview`, {});
  assert.deepEqual([p0.status, p0.json.exists, p0.json.diff, p0.json.labels], [200, false, null, 3]);
  assert.ok(!existsSync(file), 'the preview writes nothing');
  assert.equal((await exportNow(sid)).status, 200);
  const bytes = readFileSync(file);
  // move one window, delete one, add one
  await saveDraft(sid, { labels: [label('l-0001', 10, 20), label('l-0002', 31, 40), label('l-0009', 56, 58)] });
  const p = await post(`/api/session/${sid}/export-preview`, {});
  assert.equal(p.status, 200);
  assert.equal(p.json.exists, true);
  assert.deepEqual(p.json.diff, {
    added: [{ kind: 'label', id: 'l-0002', timeSec: 31 }, { kind: 'label', id: 'l-0003', timeSec: 56 }],
    removed: [{ kind: 'label', id: 'l-0002', timeSec: 30 }, { kind: 'label', id: 'l-0003', timeSec: 50 }],
    changed: [],
  });
  assert.deepEqual(readFileSync(file), bytes, 'the preview does not touch the existing file');
  await saveDraft(sid, { labels: [label('l-0001', 10, 20)] });
  const p2 = await post(`/api/session/${sid}/export-preview`, {});
  assert.deepEqual(p2.json.diff.removed, [{ kind: 'label', id: 'l-0002', timeSec: 30 }, { kind: 'label', id: 'l-0003', timeSec: 50 }]);
  const refused = await exportNow(sid);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json.diff, p2.json.diff);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal((await exportNow(sid, { overwrite: true })).status, 200);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).labels.length, 1);
  assert.deepEqual(diffLabelFiles({ labels: [] }, { labels: [{ id: 'l-0001', windowStartSec: 1, windowEndSec: 2 }], events: [{ id: 'e-0001', detectorId: 'M1', timeSec: 2 }] }).added, [{ kind: 'label', id: 'l-0001', timeSec: 1 }, { kind: 'event', id: 'e-0001', timeSec: 2 }]);
  // client: lines for the dialog (ids and times only); "add highlight" repeat guard
  const core = loadCore();
  assert.deepEqual(plain(core.diffLines(p.json.diff)), ['added label l-0002 at 31.000 s', 'added label l-0003 at 56.000 s', 'removed label l-0002 at 30.000 s', 'removed label l-0003 at 50.000 s']);
  assert.deepEqual(plain(core.diffLines(p2.json.diff, 1)), ['removed label l-0002 at 30.000 s', '... and 1 more']);
  const g = core.createRepeatGuard(1000, 0.05);
  assert.equal(g.accept(12.0, 1000), true);
  assert.equal(g.accept(12.0, 1500), false, 'same playhead within 1 s');
  assert.equal(g.accept(12.03, 1900), false, 'within the playhead tolerance');
  assert.equal(g.accept(12.0, 2600), true, 'after 1 s');
  assert.equal(g.accept(14.0, 2700), true, 'another playhead');
  const js = labelJs();
  const exp = fnBody(js, 'doExport') + fnBody(js, 'confirmExport');
  assert.ok(exp.indexOf("'/export-preview'") < exp.indexOf("openModal('confirm'") && exp.indexOf("openModal('confirm'") < exp.indexOf("'/export'"), 'preview, then confirm, then export');
  assert.ok(exp.includes('overwrite: p.exists') && exp.includes('core.diffLines(p.diff'));
  assert.ok(fnBody(js, 'addHighlight').includes('highlightGuard.accept('));
  assert.ok(js.includes("else if (c === 'KeyH') addHighlight();") && js.includes("text: 'H highlight', on: { click: addHighlight }"));
});

// ---------------------------------------------------------------- review round 3
test('H1: after F5 the new tab waits for the release, gets the lock, and autosave runs again', async () => {
  const sid = LOCKS;
  const lockFile = path.join(dirs.drafts, `${sid}.lock`);
  rmSync(lockFile, { force: true });
  const sH = await start();
  const o = { at: sH.port };
  try {
    const core = loadCore();
    assert.equal((await lock(sid, o)).json.writer, true, 'the old page');
    assert.deepEqual((await post(`/api/session/${sid}/unlock`, {}, o)).json, { released: true }, 'its pagehide unlock');
    // the reloaded page (a new tab id) gets "retry" while the release grace runs
    const saver = core.createSaver();
    saver.edit();
    const r1 = (await lock(sid, { ...o, tab: TAB2 })).json;
    const a1 = core.lockReply(saver, r1, 0, 3);
    assert.deepEqual([a1.action, a1.readOnly], ['retry', true]);
    assert.ok(a1.retryMs > 0 && a1.retryMs <= 2100);
    assert.match(saver.blocked(), /^read-only: /);
    assert.equal(saver.blockedKind(), 'read-only');
    await assert.rejects(saver.save(() => ({})), /read-only/, 'no save while read-only');
    await sleep(a1.retryMs);
    const r2 = (await lock(sid, { ...o, tab: TAB2 })).json;
    assert.deepEqual(r2, { writer: true });
    const a2 = core.lockReply(saver, r2, 1, 3);
    assert.deepEqual([a2.action, a2.readOnly], ['writer', false]);
    assert.equal(saver.blocked(), null, 'the read-only block is lifted');
    let sent = 0;
    await saver.save(() => { sent++; return {}; });
    assert.equal(sent, 1, 'the save is sent');
    assert.equal(saver.dirty(), false);
    // gaining the lock never lifts another kind of block
    saver.block('the draft changed elsewhere', 'changed');
    core.lockReply(saver, { writer: true }, 0, 3);
    assert.equal(saver.blocked(), 'the draft changed elsewhere');
    assert.equal(saver.unblock('read-only'), false);
    saver.reset();
    // retries used up: read-only (held); a stale lock: read-only with the take-over offer
    assert.equal(core.lockReply(saver, { writer: false, stale: false, retryMs: 100 }, 3, 3).action, 'held');
    assert.equal(core.lockReply(saver, { writer: false, stale: true }, 0, 3).action, 'stale');
    assert.match(saver.blocked(), /^read-only: /);
  } finally { await sH.close(); rmSync(lockFile, { force: true }); }
  // client: applyLock goes through core.lockReply; the banner shows whenever autosave is off
  const js = labelJs();
  assert.ok(fnBody(js, 'applyLock').includes('core.lockReply(saver, r, tries, 3)'));
  const banner = fnBody(js, 'renderBanner');
  assert.ok(banner.includes('saver.blocked()') && banner.includes('AUTOSAVE IS OFF'), 'the banner shows a blocked saver');
  assert.ok(js.includes("saver.block(CHANGED_ELSEWHERE, 'changed')") && fnBody(js, 'setReadOnly').includes("saver.block('read-only: ' + why, 'read-only')"));
});

test('H2: keys named like Object.prototype members are refused by the lite validator, as by ajv, at every level', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const v = ajv.compile(schema);
  const fixture = readJson(repo, 'tests', 'fixtures', 'g0', 'labels.example.json');
  assert.ok(v(fixture) && liteValidate(schema, fixture).length === 0);
  const levels = { top: (d) => d, label: (d) => d.labels[0], event: (d) => d.events[0], timing: (d) => d.timing };
  for (const key of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__']) {
    for (const [lv, at] of Object.entries(levels)) {
      const doc = structuredClone(fixture);
      Object.defineProperty(at(doc), key, { value: 1, enumerable: true, writable: true, configurable: true }); // an own key, as JSON.parse makes it
      assert.ok(Object.hasOwn(at(doc), key));
      assert.equal(v(doc), false, `ajv ${lv} ${key}`);
      const errs = liteValidate(schema, doc);
      assert.ok(errs.length > 0, `lite ${lv} ${key}`);
      // the same document as text (what the hook and export read)
      const parsed = JSON.parse(JSON.stringify(doc));
      assert.equal(v(parsed), false);
      assert.ok(liteValidate(schema, parsed).length > 0, `lite ${lv} ${key} from text`);
    }
  }
  // required, properties and $ref never resolve to inherited members
  // (ajv itself needs ownProperties:true here: by default its required check accepts an inherited member)
  const mini = { type: 'object', required: ['constructor', 'toString'], properties: { constructor: { type: 'string' } }, additionalProperties: false };
  for (const [doc, ok] of [[{}, false], [{ constructor: 'x' }, false], [JSON.parse('{"constructor":"x","toString":"y"}'), false]]) {
    const vm2 = new Ajv2020({ strict: false, ownProperties: true }).compile(mini);
    assert.equal(vm2(doc), ok, `ajv mini ${JSON.stringify(doc)}`);
    assert.equal(liteValidate(mini, doc).length === 0, ok, `lite mini ${JSON.stringify(doc)}`);
  }
  const reqOnly = { type: 'object', required: ['hasOwnProperty'] };
  assert.equal(new Ajv2020({ strict: false, ownProperties: true }).compile(reqOnly)({}), false);
  assert.ok(liteValidate(reqOnly, {}).length > 0, 'an inherited member does not satisfy required');
  assert.throws(() => liteValidate({ $ref: '#/toString' }, {}), /unresolvable/, 'a $ref to an inherited member does not resolve');
});

test('H2: PUT draft refuses prototype-named keys at the top, label and event levels', async () => {
  const sid = SID;
  await resetDraft(sid, { labels: [label('l-0001', 1, 5)], timing: { highlightPassSec: 1, eventPassSec: 0 } });
  const cur = (await req('GET', `/api/session/${sid}/draft`)).json;
  const before = readFileSync(draftFile(sid));
  for (const key of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
    const base = JSON.stringify({ ...cur, labels: [label('l-0001', 1, 6)], events: [{ id: 'e-0001', detectorId: 'N1', timeSec: 2, verdict: 'added' }] });
    for (const [lv, text] of [
      ['top', base.replace(/^\{/, `{"${key}":1,`)],
      ['label', base.replace('{"id":"l-0001"', `{"${key}":1,"id":"l-0001"`)],
      ['event', base.replace('{"id":"e-0001"', `{"${key}":1,"id":"e-0001"`)],
    ]) {
      assert.notEqual(text, base);
      const r = await req('PUT', `/api/session/${sid}/draft`, { body: text, raw: true });
      assert.equal(r.status, 422, `${lv} ${key}: ${JSON.stringify(r.json)}`);
    }
  }
  assert.deepEqual(readFileSync(draftFile(sid)), before, 'nothing written');
});

test('M5: the tab-close prompt shows when anything is unsaved or saving is off; the final save is a direct keepalive PUT', () => {
  const core = loadCore();
  const s = core.createSaver();
  assert.deepEqual(plain(core.unloadPlan(s, 100, 60000)), { prompt: false, send: false }, 'clean: nothing to do');
  s.edit();
  assert.deepEqual(plain(core.unloadPlan(s, 100, 60000)), { prompt: true, send: true }, 'dirty: prompt and send');
  assert.deepEqual(plain(core.unloadPlan(s, 70000, 60000)), { prompt: true, send: false }, 'too large for keepalive: prompt only');
  s.block('read-only: x', 'read-only');
  assert.deepEqual(plain(core.unloadPlan(s, 100, 60000)), { prompt: true, send: false }, 'blocked: prompt, never send');
  const c2 = core.createSaver();
  c2.block('the draft changed elsewhere', 'changed');
  assert.deepEqual(plain(core.unloadPlan(c2, 100, 60000)), { prompt: true, send: false }, 'blocked and clean: still prompt');
  const js = labelJs();
  const bu = js.slice(js.indexOf("addEventListener('beforeunload'"), js.indexOf("addEventListener('pagehide'"));
  assert.ok(bu.includes('core.unloadPlan(saver, 0, KEEPALIVE_MAX).prompt') && bu.includes('e.preventDefault()') && bu.includes("e.returnValue = ''"));
  const ph = js.slice(js.indexOf("addEventListener('pagehide'"), js.indexOf('// ---------------------------------------------------------------- active-time log'));
  assert.ok(ph.includes('draftBody(S.draft)') && ph.includes('core.unloadPlan(saver, body.length, KEEPALIVE_MAX).send'));
  assert.ok(/method: 'PUT'[^}]*keepalive: true/.test(ph), 'the final save is a keepalive PUT');
  assert.ok(ph.indexOf("'/draft'") < ph.indexOf("'unlock'"), 'final save before the unlock');
  assert.ok(!/sendBeacon\(/.test(js), 'no sendBeacon');
  assert.ok(/var KEEPALIVE_MAX = 60000;/.test(js));
});

test('M6: the export diff matches labels on their window and events on detector and time, not on renumbered ids', async () => {
  const L = (id, a, b, x) => ({ id, windowStartSec: a, windowEndSec: b, label: 'keep', rating: 4, ...x });
  const E = (id, d, t) => ({ id, detectorId: d, timeSec: t, verdict: 'added' });
  // one window and one event inserted before the others: only "added", although every later id moved
  const d = diffLabelFiles(
    { labels: [L('l-0001', 10, 20), L('l-0002', 30, 40)], events: [E('e-0001', 'M1', 5), E('e-0002', 'N1', 9)] },
    { labels: [L('l-0001', 10, 20), L('l-0002', 15, 18), L('l-0003', 30, 40)], events: [E('e-0001', 'M1', 3), E('e-0002', 'M1', 5), E('e-0003', 'N1', 9)] });
  assert.deepEqual(d, { added: [{ kind: 'label', id: 'l-0002', timeSec: 15 }, { kind: 'event', id: 'e-0001', timeSec: 3 }], removed: [], changed: [] });
  // a field change at the same window or time is "changed", with the old id
  const c = diffLabelFiles({ labels: [L('l-0001', 5, 6), L('l-0002', 30, 40)], events: [E('e-0001', 'M1', 5)] },
    { labels: [L('l-0001', 30, 40, { rating: 2 })], events: [{ ...E('e-0001', 'M1', 5), verdict: 'accept' }] });
  assert.deepEqual(c, { added: [], removed: [{ kind: 'label', id: 'l-0001', timeSec: 5 }], changed: [{ kind: 'label', id: 'l-0001', timeSec: 30, wasId: 'l-0002' }, { kind: 'event', id: 'e-0001', timeSec: 5, wasId: 'e-0001' }] });
  // same detector at another time, or another detector at the same time: removed + added
  const m = diffLabelFiles({ events: [E('e-0001', 'M1', 5)] }, { events: [E('e-0001', 'M3', 5)] });
  assert.deepEqual([m.added.length, m.removed.length, m.changed.length], [1, 1, 0]);
  // duplicates at one time pair up with an identical old item first
  const dup = diffLabelFiles({ events: [E('e-0001', 'M1', 5), { ...E('e-0002', 'M1', 5), verdict: 'accept' }] }, { events: [{ ...E('e-0001', 'M1', 5), verdict: 'accept' }, E('e-0002', 'M1', 5)] });
  assert.deepEqual(dup, { added: [], removed: [], changed: [] });
  const core = loadCore();
  assert.deepEqual(plain(core.diffLines(c)), ['removed label l-0001 at 5.000 s', 'changed label l-0001 at 30.000 s (was l-0002)', 'changed event e-0001 at 5.000 s']);
  // through the server: insert a window before an exported one
  const sid = SID;
  await resetDraft(sid, { labels: [label('l-0001', 10, 20), label('l-0002', 30, 40)], timing: { highlightPassSec: 1, eventPassSec: 0 } });
  rmSync(path.join(dirs.labels, `${sid}.json`), { force: true });
  assert.equal((await exportNow(sid)).status, 200);
  await saveDraft(sid, { labels: [label('l-0001', 10, 20), label('l-0009', 15, 18), label('l-0002', 30, 40)] });
  const p = await post(`/api/session/${sid}/export-preview`, {});
  assert.deepEqual(p.json.diff, { added: [{ kind: 'label', id: 'l-0002', timeSec: 15 }], removed: [], changed: [] });
});

test('M7: a live owner keeps the lock for 5 min without a heartbeat; a dead owner is stale at once; the page beats on visible', async () => {
  const sid = LOCKS;
  const lockFile = path.join(dirs.drafts, `${sid}.lock`);
  const other = { launchId: 'c'.repeat(32), tab: TAB2, pid: process.pid }; // another launch, process alive
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  try {
    writeFileSync(lockFile, JSON.stringify({ ...other, heartbeatAt: ago(60 * 1000) }));
    assert.deepEqual((await lock(sid)).json, { writer: false, stale: false }, 'alive, 1 min without a heartbeat: held');
    writeFileSync(lockFile, JSON.stringify({ ...other, heartbeatAt: ago(4.5 * 60 * 1000) }));
    assert.deepEqual((await lock(sid)).json, { writer: false, stale: false }, 'alive, 4.5 min: held');
    writeFileSync(lockFile, JSON.stringify({ ...other, heartbeatAt: ago(5 * 60 * 1000 + 5000) }));
    assert.deepEqual((await lock(sid)).json, { writer: false, stale: true }, 'alive, over 5 min: stale');
    writeFileSync(lockFile, JSON.stringify({ ...other, pid: 2 ** 22 + 12345, heartbeatAt: ago(0) }));
    assert.deepEqual((await lock(sid)).json, { writer: false, stale: true }, 'process gone: stale at once');
  } finally { rmSync(lockFile, { force: true }); }
  const js = labelJs();
  const vis = js.slice(js.indexOf("addEventListener('visibilitychange'"), js.indexOf('// ---------------------------------------------------------------- session lock'));
  assert.ok(/if \(document\.hidden\) \{[^}]*save\(true\)[\s\S]*heartbeat\(\);/.test(vis), 'hidden: save; visible: heartbeat');
  assert.ok(js.includes('var HEARTBEAT_MS = 10000;') && js.includes('setInterval(heartbeat, HEARTBEAT_MS);'));
  assert.ok(js.includes('no heartbeat for 5 min'), 'the take-over dialog states the timeout');
  assert.ok(readFileSync(path.join(repo, 'tools', 'label', 'server.mjs'), 'utf8').includes('const LOCK_STALE_MS = 5 * 60 * 1000;'));
});

test('M8: claiming a released or stale lock is exclusive; two claimants never both win', async () => {
  const dir = path.join(tmp, 'claim');
  mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, 's.lock');
  const claimFile = `${lf}.claim`;
  const rec = (l, tab) => ({ launchId: l.repeat(32), tab, pid: process.pid, heartbeatAt: new Date().toISOString() });
  const A = rec('a', TAB), B = rec('b', TAB2);
  const write = (f, t) => writeFileSync(f, t);
  const holder = () => JSON.parse(readFileSync(lf, 'utf8')).launchId;
  writeFileSync(lf, JSON.stringify({ ...rec('c', TAB), releasedAt: new Date(Date.now() - 10000).toISOString() }));
  // B runs its whole claim while A holds the claim file: B loses, A wins
  let bGot = null;
  assert.equal(claimLock(lf, A, { write, hooks: { afterClaim: () => { bGot = claimLock(lf, B, { write }); } } }), true);
  assert.equal(bGot, false);
  assert.equal(holder(), A.launchId);
  assert.ok(!existsSync(claimFile), 'the claim file is removed');
  // the other order: B claims inside A's re-check window and the re-check sees B's lock -> A loses
  writeFileSync(lf, JSON.stringify({ ...rec('c', TAB), releasedAt: new Date(Date.now() - 10000).toISOString() }));
  let first = true;
  const canA = () => { const l = JSON.parse(readFileSync(lf, 'utf8')); return !!l.releasedAt; };
  assert.equal(claimLock(lf, A, { write, canClaim: canA, hooks: { afterClaim: () => { if (first) { first = false; writeFileSync(lf, JSON.stringify(B)); } } } }), false);
  assert.equal(holder(), B.launchId, 'nothing written over the winner');
  // a writer that lands between A's write and its read-back: A sees it lost
  assert.equal(claimLock(lf, A, { write, hooks: { afterWrite: () => writeFileSync(lf, JSON.stringify(B)) } }), false);
  assert.ok(!existsSync(claimFile));
  // a claim file left by a crashed claimant: blocks for 10 s, then is cleared
  writeFileSync(claimFile, 'crashed');
  assert.equal(claimLock(lf, A, { write }), false);
  assert.equal(readFileSync(claimFile, 'utf8'), 'crashed', 'a fresh foreign claim file is not removed');
  const old = Date.now() / 1000 - 20;
  utimesSync(claimFile, old, old);
  assert.equal(claimLock(lf, A, { write }), true);
  assert.equal(holder(), A.launchId);
  assert.ok(!existsSync(claimFile));
  // through the server: a second launch takes the released lock between our claim and our re-check
  const sid = LOCKS;
  const lockFile = path.join(dirs.drafts, `${sid}.lock`);
  let fired = 0;
  const sM = await start({ lockHooks: { afterClaim: () => { if (!fired++) writeFileSync(lockFile, JSON.stringify(rec('d', TAB2))); } } });
  try {
    writeFileSync(lockFile, JSON.stringify({ ...rec('e', TAB2), releasedAt: new Date(Date.now() - 10000).toISOString() }));
    assert.deepEqual((await lock(sid, { at: sM.port })).json, { writer: false, stale: false, retryMs: 500 });
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).launchId, 'd'.repeat(32), 'the other launch keeps it');
    assert.ok(!existsSync(`${lockFile}.claim`));
    assert.deepEqual((await lock(sid, { at: sM.port })).json, { writer: false, stale: false }, 'then it is held');
    // two tabs of one launch race for a released lock: one writer
    writeFileSync(lockFile, JSON.stringify({ ...rec('e', TAB2), releasedAt: new Date(Date.now() - 10000).toISOString() }));
    const [x, y] = await Promise.all([lock(sid, { at: sM.port }), lock(sid, { at: sM.port, tab: TAB2 })]);
    assert.equal([x.json.writer, y.json.writer].filter(Boolean).length, 1, JSON.stringify([x.json, y.json]));
  } finally { await sM.close(); rmSync(lockFile, { force: true }); }
});

test('M9: the next revision is above every backup, and a backup is never overwritten', async () => {
  const sid = REV;
  rmSync(draftFile(sid), { force: true });
  rmSync(pass2File(sid), { force: true });
  rmSync(backupsOf(sid), { recursive: true, force: true });
  let cur = (await req('GET', `/api/session/${sid}/draft`)).json;
  for (let i = 1; i <= 3; i++) cur = (await put(`/api/session/${sid}/draft`, { ...cur, labels: [label('l-0001', 1, 1 + i)] })).json;
  assert.equal(cur.revision, 3);
  const snap = () => Object.fromEntries(readdirSync(backupsOf(sid)).sort().map((n) => [n, readFileSync(path.join(backupsOf(sid), n), 'utf8')]));
  const b3 = snap();
  assert.deepEqual(Object.keys(b3), ['r00000001.json', 'r00000002.json', 'r00000003.json']);
  // the draft is lost (deleted); its backups stay
  rmSync(draftFile(sid));
  const fresh = (await req('GET', `/api/session/${sid}/draft`)).json;
  assert.equal(fresh.revision, 0);
  const r4 = await put(`/api/session/${sid}/draft`, { ...fresh, labels: [label('l-0001', 1, 9)] });
  assert.equal(r4.status, 200, JSON.stringify(r4.json));
  assert.equal(r4.json.revision, 4, 'max(0, 3) + 1');
  const b4 = snap();
  for (const [n, text] of Object.entries(b3)) assert.equal(b4[n], text, `${n} kept as it was`);
  assert.equal(JSON.parse(b4['r00000004.json']).labels[0].windowEndSec, 9);
  // a stored draft restored from an older copy (revision 2): the next revision is still above the backups
  writeStoredDraft(sid, { revision: 2, labels: [label('l-0001', 1, 3)], timing: { highlightPassSec: 1, eventPassSec: 0 } });
  const old = (await req('GET', `/api/session/${sid}/draft`)).json;
  const r5 = await put(`/api/session/${sid}/draft`, { ...old, labels: [label('l-0001', 1, 10)] });
  assert.equal(r5.json.revision, 5);
  // a backup file with a higher number (copied in by hand) is skipped over, never written
  writeFileSync(path.join(backupsOf(sid), 'r00000007.json'), 'hand copy');
  const r8 = await put(`/api/session/${sid}/draft`, { ...r5.json, labels: [label('l-0001', 1, 11)] });
  assert.equal(r8.json.revision, 8);
  assert.equal(readFileSync(path.join(backupsOf(sid), 'r00000007.json'), 'utf8'), 'hand copy');
  const b8 = snap();
  for (const [n, text] of Object.entries(b4)) assert.equal(b8[n], text);
  assert.ok(readdirSync(backupsOf(sid)).every((n) => !n.endsWith('.tmp')));
  // the server writes backups with an exclusive create and a hard link (no overwrite)
  const src = readFileSync(path.join(repo, 'tools', 'label', 'server.mjs'), 'utf8');
  const wb = src.slice(src.indexOf('function writeBackup('), src.indexOf('function putDraft('));
  assert.ok(wb.includes("{ flag: 'wx' }") && wb.includes('placeExclusive(tmp, file, linkFile)') && wb.includes("'backup-exists'"));
  assert.ok(src.includes('Math.max(stored.revision, highestBackup(info)) + 1') || /Math\.max\([^)]*highestBackup\(info\)\)\s*\+\s*1/.test(src));
});

test('M10: export writes exactly the previewed document; a change after the preview is 409 with a new preview', async () => {
  const sid = SID;
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  await resetDraft(sid, { labels: [label('l-0001', 10, 20)], timing: { highlightPassSec: 1, eventPassSec: 0 } });
  const file = path.join(dirs.labels, `${sid}.json`);
  rmSync(file, { force: true });
  // no hash: refused, with a preview to confirm
  const none = await post(`/api/session/${sid}/export`, {});
  assert.deepEqual([none.status, none.json.error], [409, 'changed-since-preview']);
  assert.match(none.json.preview.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!existsSync(file));
  const p = await post(`/api/session/${sid}/export-preview`, {});
  assert.equal(p.json.existingSha256, null);
  // an autosave lands between the preview and the confirm
  await saveDraft(sid, { labels: [label('l-0001', 10, 20), label('l-0002', 30, 40)] });
  const stale = await post(`/api/session/${sid}/export`, { sha256: p.json.sha256, existingSha256: null });
  assert.deepEqual([stale.status, stale.json.error, stale.json.preview.labels], [409, 'changed-since-preview', 2]);
  assert.notEqual(stale.json.preview.sha256, p.json.sha256);
  assert.ok(!existsSync(file), 'nothing written');
  const ok = await post(`/api/session/${sid}/export`, { sha256: stale.json.preview.sha256, existingSha256: stale.json.preview.existingSha256 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(sha(readFileSync(file)), stale.json.preview.sha256, 'the file is the previewed text, byte for byte');
  // the existing file changes after the preview
  const p2 = await post(`/api/session/${sid}/export-preview`, {});
  assert.equal(p2.json.existingSha256, sha(readFileSync(file)));
  writeFileSync(file, readFileSync(file, 'utf8') + '\n');
  const bytes = readFileSync(file);
  const r2 = await post(`/api/session/${sid}/export`, { overwrite: true, sha256: p2.json.sha256, existingSha256: p2.json.existingSha256 });
  assert.deepEqual([r2.status, r2.json.error], [409, 'changed-since-preview']);
  assert.equal(r2.json.preview.existingSha256, sha(bytes));
  assert.deepEqual(readFileSync(file), bytes);
  // a wrong existing hash, and a file claimed absent that exists, are refused too
  const p3 = (await post(`/api/session/${sid}/export-preview`, {})).json;
  assert.equal((await post(`/api/session/${sid}/export`, { overwrite: true, sha256: p3.sha256, existingSha256: 'f'.repeat(64) })).status, 409);
  assert.equal((await post(`/api/session/${sid}/export`, { overwrite: true, sha256: p3.sha256 })).status, 409);
  assert.deepEqual(readFileSync(file), bytes);
  // the right hashes without overwrite: 409 exists (with the preview); with overwrite: written
  const ex = await post(`/api/session/${sid}/export`, { sha256: p3.sha256, existingSha256: p3.existingSha256 });
  assert.deepEqual([ex.status, ex.json.error, ex.json.preview.sha256], [409, 'exists', p3.sha256]);
  assert.equal((await post(`/api/session/${sid}/export`, { overwrite: true, sha256: p3.sha256, existingSha256: p3.existingSha256 })).status, 200);
  assert.equal(sha(readFileSync(file)), p3.sha256);
  // client: autosave pauses during the confirm; the export sends the hashes; a 409 shows the dialog again
  const js = labelJs();
  assert.ok(js.includes('!S.exporting; };'), 'canAutosave skips while exporting');
  const de = fnBody(js, 'doExport');
  assert.ok(de.indexOf('save(true)') < de.indexOf('S.exporting = true') && de.indexOf('S.exporting = true') < de.indexOf("'/export-preview'"));
  const ce = fnBody(js, 'confirmExport');
  assert.ok(ce.includes('sha256: p.sha256, existingSha256: p.existingSha256'));
  assert.ok(ce.includes('e.status === 409 && e.body && e.body.preview') && ce.includes('confirmExport(id, sb, e.body.preview, true)'));
  assert.ok(ce.includes('no: function () { S.exporting = false; }'), 'cancel resumes autosave');
  assert.ok(fnBody(js, 'closeModal').includes('cfg.no'), 'Esc, No and a click outside run no()');
});

test('M11: frame and thumb replies are Cache-Control: no-store', async () => {
  const fake = path.join(tmp, 'fake-ffmpeg-jpeg.mjs');
  // A fake ffmpeg that writes a tiny JPEG-shaped reply (SOI ... EOI) to stdout.
  writeFileSync(fake, 'process.stdout.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]));\n');
  const sF = await start({ ffmpeg: [process.execPath, fake] });
  try {
    for (const what of ['frame', 'thumb', 'thumb']) { // the second thumb comes from the server's memory cache
      const r = await req('GET', `/api/session/${SID}/${what}?t=1`, { at: sF.port });
      assert.equal(r.status, 200, what);
      assert.equal(r.headers['content-type'], 'image/jpeg');
      assert.equal(r.headers['cache-control'], 'no-store', what);
      assert.deepEqual([...r.buf.subarray(0, 2)], [0xff, 0xd8]);
    }
    for (const p of [`/media/proxy/${SID}`, `/media/clip/${SID}/0`]) assert.equal((await req('GET', p, { at: sF.port })).headers['cache-control'], 'no-store', p);
  } finally { await sF.close(); }
});

// ---------------------------------------------------------------- review round 4
test('R1: after F5 with unsaved edits, the old tab\'s final save lands in the grace and the new tab reloads the draft', async () => {
  const sid = LOCKS;
  const lockFile = path.join(dirs.drafts, `${sid}.lock`);
  for (const p of [lockFile, draftFile(sid), pass2File(sid)]) rmSync(p, { force: true });
  rmSync(backupsOf(sid), { recursive: true, force: true });
  const sR = await start();
  const o = { at: sR.port };
  const o2 = { at: sR.port, tab: TAB2 };
  try {
    const core = loadCore();
    // the old page: writer, one saved edit, one unsaved edit
    assert.equal((await lock(sid, o)).json.writer, true);
    const d1 = (await put(`/api/session/${sid}/draft`, { ...(await req('GET', `/api/session/${sid}/draft`, o)).json, labels: [label('l-0001', 1, 2)] }, o)).json;
    assert.equal(d1.revision, 1);
    // F5: the new page reads the draft (revision 1) and asks for the lock while the old page unloads
    const seen = (await req('GET', `/api/session/${sid}/draft`, o2)).json;
    assert.equal(seen.revision, 1);
    assert.deepEqual((await post(`/api/session/${sid}/unlock`, {}, o)).json, { released: true });
    const fin = await put(`/api/session/${sid}/draft`, { ...d1, labels: [label('l-0001', 1, 2), label('l-0002', 3, 4)] }, o); // its keepalive final save
    assert.equal(fin.status, 200, 'the final save lands in the release grace');
    assert.equal(fin.json.revision, 2);
    const saver = core.createSaver();
    const a1 = core.lockReply(saver, (await lock(sid, o2)).json, 0, 3);
    assert.equal(a1.action, 'retry');
    await sleep(a1.retryMs);
    const a2 = core.lockReply(saver, (await lock(sid, o2)).json, 1, 3);
    assert.deepEqual([a2.action, a2.reload], ['writer', true], 'writer on a retry: reload the draft');
    // without the reload the first autosave is refused, and the old tab's edit would be lost on reload
    assert.equal((await put(`/api/session/${sid}/draft`, { ...seen, labels: [label('l-0001', 1, 2), label('l-0003', 5, 6)] }, o2)).status, 409);
    // with it, the reloaded draft has the old tab's edit and the next save works
    const fresh = (await req('GET', `/api/session/${sid}/draft`, o2)).json;
    assert.deepEqual([fresh.revision, fresh.labels.length], [2, 2]);
    assert.equal((await put(`/api/session/${sid}/draft`, { ...fresh, labels: [...fresh.labels, label('l-0003', 5, 6)] }, o2)).status, 200);
    // the lock reply that comes with the reload itself (first try) does not reload again
    assert.equal(core.lockReply(saver, { writer: true }, undefined, 3).reload, false);
    assert.equal(core.lockReply(saver, { writer: true }, 0, 3).reload, false);
  } finally { await sR.close(); rmSync(lockFile, { force: true }); }
  const apply = fnBody(labelJs(), 'applyLock');
  const i = apply.indexOf("if (a.action === 'writer' && a.reload) { openSession(id); return; }");
  assert.ok(i > 0 && i < apply.indexOf('S.lockHeld = !a.readOnly'), 'the page reloads before it marks itself the writer');
});

test('R2: a stale claim file is broken without ever deleting a live claim; exactly one claimant wins', () => {
  const dir = path.join(tmp, 'claim-r2');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, 's.lock');
  const claimFile = `${lf}.claim`;
  const rec = (l, tab) => ({ launchId: l.repeat(32), tab, pid: process.pid, heartbeatAt: new Date().toISOString() });
  const A = rec('a', TAB), B = rec('b', TAB2);
  const write = (f, t) => writeFileSync(f, t);
  const holder = () => JSON.parse(readFileSync(lf, 'utf8')).launchId;
  const released = () => writeFileSync(lf, JSON.stringify({ ...rec('c', TAB), releasedAt: new Date(Date.now() - 10000).toISOString() }));
  const staleClaim = () => { writeFileSync(claimFile, 'crashed'); const t = Date.now() / 1000 - 20; utimesSync(claimFile, t, t); };
  const leftovers = () => readdirSync(dir).filter((n) => n.endsWith('.stale'));
  // 1. Both see the stale claim. B breaks it and makes a fresh claim first; A then moves B's fresh claim:
  //    A sees it is not the stale one, puts it back and gives up.
  released(); staleClaim();
  assert.equal(claimLock(lf, A, { write, hooks: { beforeBreak: () => { unlinkSync(claimFile); writeFileSync(claimFile, 'B fresh claim', { flag: 'wx' }); } } }), false);
  assert.equal(readFileSync(claimFile, 'utf8'), 'B fresh claim', 'B\'s live claim is restored');
  assert.deepEqual(leftovers(), []);
  assert.ok(JSON.parse(readFileSync(lf, 'utf8')).releasedAt, 'A wrote nothing');
  // 1b. the same where hard links are not supported: restored by an exclusive copy
  rmSync(claimFile); staleClaim();
  const noLink = () => { throw Object.assign(new Error('no hard links'), { code: 'EPERM' }); };
  assert.equal(claimLock(lf, A, { write, link: noLink, hooks: { beforeBreak: () => { unlinkSync(claimFile); writeFileSync(claimFile, 'B fresh claim', { flag: 'wx' }); } } }), false);
  assert.equal(readFileSync(claimFile, 'utf8'), 'B fresh claim');
  // 2. Both see the stale claim; B runs its whole claim (break, claim, write, verify) before A moves on:
  //    A finds nothing to break and gives up. One winner.
  rmSync(claimFile); released(); staleClaim();
  let bGot = null;
  assert.equal(claimLock(lf, A, { write, hooks: { beforeBreak: () => { bGot = claimLock(lf, B, { write }); } } }), false);
  assert.equal(bGot, true);
  assert.equal(holder(), B.launchId);
  assert.ok(!existsSync(claimFile));
  // 3. Two breakers judged it stale and both moved a claim: the one whose claim was moved away after its
  //    write finds its claim gone at the last check and does not win.
  released();
  let other = null;
  assert.equal(claimLock(lf, A, { write, hooks: { afterWrite: () => { renameSync(claimFile, `${claimFile}.moved`); writeFileSync(claimFile, 'C claim'); other = 'C'; } } }), false);
  assert.equal(other, 'C');
  assert.equal(readFileSync(claimFile, 'utf8'), 'C claim', 'a claim that is not A\'s is left alone');
  rmSync(claimFile); rmSync(`${claimFile}.moved`);
  // 4. A plain stale claim (crashed claimant) is still broken and claimed
  released(); staleClaim();
  assert.equal(claimLock(lf, A, { write }), true);
  assert.equal(holder(), A.launchId);
  assert.ok(!existsSync(claimFile));
  assert.deepEqual(leftovers(), []);
  rmSync(dir, { recursive: true, force: true });
});

test('R6: backups fall back to an exclusive copy when hard links fail; a backup is still never overwritten', async () => {
  // placeExclusive: link-support errors copy; other errors are thrown; an existing name is EEXIST either way
  const dir = path.join(tmp, 'place');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const src = path.join(dir, 'src'); writeFileSync(src, 'payload');
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
    const dst = path.join(dir, code);
    placeExclusive(src, dst, () => { throw Object.assign(new Error(code), { code }); });
    assert.equal(readFileSync(dst, 'utf8'), 'payload', code);
    assert.throws(() => placeExclusive(src, dst, () => { throw Object.assign(new Error(code), { code }); }), { code: 'EEXIST' }, `${code}: existing name`);
    assert.equal(readFileSync(dst, 'utf8'), 'payload');
  }
  assert.throws(() => placeExclusive(src, path.join(dir, 'x'), () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), { code: 'EACCES' });
  assert.ok(!existsSync(path.join(dir, 'x')));
  // through the server: every PUT still saves, with a backup per revision
  const sid = LOCKS;
  const lockFile = path.join(dirs.drafts, `${sid}.lock`);
  for (const p of [lockFile, draftFile(sid), pass2File(sid)]) rmSync(p, { force: true });
  rmSync(backupsOf(sid), { recursive: true, force: true });
  let mode = 'EPERM';
  const sL = await start({ linkFile: (a, b) => { if (mode === 'race') writeFileSync(b, 'another writer'); throw Object.assign(new Error('no hard links'), { code: mode === 'race' ? 'EPERM' : mode }); } });
  const o = { at: sL.port };
  try {
    assert.equal((await lock(sid, o)).json.writer, true);
    let cur = (await req('GET', `/api/session/${sid}/draft`, o)).json;
    for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
      mode = code;
      const r = await put(`/api/session/${sid}/draft`, { ...cur, labels: [label('l-0001', 1, 2 + cur.revision)] }, o);
      assert.equal(r.status, 200, `${code}: ${JSON.stringify(r.json)}`);
      cur = r.json;
      assert.equal(JSON.parse(readFileSync(path.join(backupsOf(sid), `r${String(cur.revision).padStart(8, '0')}.json`), 'utf8')).revision, cur.revision);
    }
    assert.equal(cur.revision, 3);
    // a backup name that appears between the temp write and the copy is not overwritten, and the draft is kept
    mode = 'race';
    const draftBefore = readFileSync(draftFile(sid));
    const r = await put(`/api/session/${sid}/draft`, { ...cur, labels: [label('l-0001', 1, 9)] }, o);
    assert.deepEqual([r.status, r.json.error], [500, 'backup-exists']);
    assert.equal(readFileSync(path.join(backupsOf(sid), 'r00000004.json'), 'utf8'), 'another writer');
    assert.deepEqual(readFileSync(draftFile(sid)), draftBefore);
    assert.ok(readdirSync(backupsOf(sid)).every((n) => !n.endsWith('.tmp')));
  } finally { await sL.close(); rmSync(lockFile, { force: true }); rmSync(backupsOf(sid), { recursive: true, force: true }); rmSync(draftFile(sid), { force: true }); }
});

test('R7: a label without createdAt gets one at PUT; export of that draft keeps its hash across seconds', async () => {
  const sid = SID;
  rmSync(pass2File(sid), { force: true });
  const bare = { id: 'l-0001', windowStartSec: 10, windowEndSec: 20, label: 'keep', reasonTags: [] };
  // an old or hand-edited draft without createdAt: export refuses it, never makes a time up
  writeStoredDraft(sid, { labels: [bare], timing: { highlightPassSec: 1, eventPassSec: 0 } });
  const p0 = await post(`/api/session/${sid}/export-preview`, {});
  assert.equal(p0.status, 422);
  assert.ok(p0.json.errors.includes('/labels/0/createdAt required'), JSON.stringify(p0.json.errors));
  assert.ok(checkDraft({ labels: [bare] }).includes('/labels/0/createdAt required'));
  // the next save fills it (whole seconds, as the page writes it)
  const cur = (await req('GET', `/api/session/${sid}/draft`)).json;
  const r = await put(`/api/session/${sid}/draft`, { ...cur, labels: [bare] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const at = r.json.labels[0].createdAt;
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(JSON.parse(readFileSync(draftFile(sid), 'utf8')).labels[0].createdAt, at);
  // preview, wait over a second, export: the hash still matches
  const file = path.join(dirs.labels, `${sid}.json`);
  rmSync(file, { force: true });
  const p = await post(`/api/session/${sid}/export-preview`, {});
  assert.equal(p.status, 200);
  await sleep(1100);
  const e = await post(`/api/session/${sid}/export`, { sha256: p.json.sha256, existingSha256: p.json.existingSha256 });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).labels[0].createdAt, at);
  // a createdAt the page sent is kept as it is
  const cur2 = (await req('GET', `/api/session/${sid}/draft`)).json;
  const r2 = await put(`/api/session/${sid}/draft`, { ...cur2, labels: [{ ...bare, createdAt: '2026-10-01T09:00:00Z' }] });
  assert.equal(r2.json.labels[0].createdAt, '2026-10-01T09:00:00Z');
  const src = readFileSync(path.join(repo, 'tools', 'label', 'labels-export.mjs'), 'utf8');
  assert.ok(!/new Date\(\)/.test(src.slice(src.indexOf('export function buildLabelFile'), src.indexOf('export function', src.indexOf('export function buildLabelFile') + 10))), 'buildLabelFile never reads the clock');
});

test('R8: block() never turns a "changed" or "draft-load" block into "read-only"', () => {
  const core = loadCore();
  for (const kind of ['changed', 'draft-load']) {
    const s = core.createSaver();
    assert.equal(s.block('serious ' + kind, kind), true);
    assert.equal(s.block('read-only: the session lock was taken over', 'read-only'), false, 'a heartbeat setReadOnly keeps it');
    assert.deepEqual([s.blocked(), s.blockedKind()], ['serious ' + kind, kind]);
    core.lockReply(s, { writer: false, stale: false }, 3, 3); // read-only reply
    assert.equal(s.blockedKind(), kind);
    core.lockReply(s, { writer: true }, 0, 3); // a later writer reply
    assert.equal(s.blocked(), 'serious ' + kind, 'still blocked');
  }
  // read-only can become a serious block; and a read-only block is still lifted by writer
  const s2 = core.createSaver();
  s2.block('read-only: x', 'read-only');
  assert.equal(s2.block('changed elsewhere', 'changed'), true);
  assert.equal(s2.blockedKind(), 'changed');
  const s3 = core.createSaver();
  s3.block('read-only: x', 'read-only');
  core.lockReply(s3, { writer: true }, 0, 3);
  assert.equal(s3.blocked(), null);
});
