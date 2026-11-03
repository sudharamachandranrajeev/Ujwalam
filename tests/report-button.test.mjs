// SPDX-License-Identifier: GPL-2.0-or-later
// Report button (flag `report-button`, D199): URL format, strict repo validation, redaction, truncation, flag gate, the
// placeholder profile message. Headless, 127.0.0.1 only, no network, no browser, nothing is opened.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeRedactor } from '../tools/diag/redact.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { buildReport, createReporter, MAX_URL, parseIssuesUrl, SET_MESSAGE, TRUNCATED_NOTE } from '../services/studio-ui/report.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const ISSUES = 'https://github.com/example-owner/example-repo';
const FAKE_BRAND = 'Zorblaxquux';
const FAKE_SECRET = 'live_123456789_AbCdEfGhIjKlMnOpQrStUv'; // lint-allow: secret (seeded fake stream-key shape; the test asserts it is redacted)
const FAKE_TOKEN = 'token=hunter2hunter2hunter2'; // lint-allow: secret (seeded fake token; the test asserts it is redacted)
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-rep-')); tmpDirs.push(d); return d; };
const servers = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const decode = (url) => new URL(url).searchParams;

describe('parseIssuesUrl (strict)', () => {
  test('accepts https://github.com/<owner>/<repo> only', () => {
    assert.deepEqual(parseIssuesUrl(ISSUES), { ok: true, url: ISSUES });
    assert.equal(parseIssuesUrl('https://github.com/a/b.c_d-e').ok, true);
  });
  test('rejects non-github, http, extra path, query, fragment, credentials, port, trailing slash, .git, odd owners', () => {
    for (const bad of [
      'http://github.com/o/r', 'https://gitlab.com/o/r', 'https://github.com.evil.example/o/r', 'https://evil.example/github.com/o/r',
      'https://github.com/o/r/issues', 'https://github.com/o/r/', 'https://github.com/o', 'https://github.com/o/r?x=1', 'https://github.com/o/r#x',
      'https://user@github.com/o/r', 'https://github.com:444/o/r', 'https://github.com/o/r.git', 'https://github.com/o/..',
      'https://github.com/-o/r', 'https://github.com/o-/r', 'https://github.com/o--x/r', 'https://github.com/o/r r', 'https://github.com/o/r\n',
      'https://GITHUB.com/o/r', ' https://github.com/o/r', 'javascript:alert(1)', 'https://github.com/o/r%2f..', 5, {},
    ]) assert.equal(parseIssuesUrl(bad).ok, false, JSON.stringify(bad));
  });
  test('unset and placeholder are reported as such', () => {
    assert.equal(parseIssuesUrl(undefined).reason, 'unset');
    assert.equal(parseIssuesUrl('').reason, 'unset');
    assert.equal(parseIssuesUrl('<private-repo-issues-url>').reason, 'placeholder');
    assert.equal(parseIssuesUrl('http://github.com/o/r').reason, 'invalid');
  });
  test('the committed example profile holds a placeholder and the schema defines the key', () => {
    const ex = JSON.parse(readFileSync(path.join(REPO, 'data', 'profile.example.json'), 'utf8'));
    assert.equal(parseIssuesUrl(ex.links.issues_url).reason, 'placeholder');
    const sc = JSON.parse(readFileSync(path.join(REPO, 'data', 'profile.schema.json'), 'utf8'));
    assert.equal(sc.properties.links.properties.issues_url.type, 'string');
  });
});

describe('buildReport', () => {
  const base = { issuesUrl: ISSUES, version: '0.1.0-alpha.2', osText: 'Windows_NT 10.0.26200 x64', flags: [{ id: 'posting', on: true }, { id: 'clip-pipeline', on: false }], host: { available: true, live: false, recording: false, droppedFrames: 2, totalFrames: 900, fps: 60 }, outputs: { sinks: [{ state: 'idle' }, { state: 'live' }, { state: 'idle' }] }, crashes: 1 };

  test('URL format: <repo>/issues/new?title=...&body=... with the facts in the body', () => {
    const r = buildReport({ ...base, title: 'Preview is black', note: 'It happened after I switched scenes.' });
    assert.ok(r.url.startsWith(`${ISSUES}/issues/new?title=Preview%20is%20black&body=`));
    assert.equal(r.truncated, false);
    const q = decode(r.url);
    assert.equal(q.get('title'), 'Preview is black');
    const body = q.get('body');
    for (const want of ['It happened after I switched scenes.', '0.1.0-alpha.2', 'Windows_NT 10.0.26200 x64', 'Feature flags on: posting (1 off)', '3 sink(s) (2 idle, 1 live)', '2 dropped of 900', 'host crash log entries: 1']) assert.ok(body.includes(want), want);
    assert.ok(r.length <= MAX_URL);
  });
  test('empty title gets a default; a long title is cut', () => {
    assert.equal(decode(buildReport({ ...base, title: '  ', note: '' }).url).get('title'), 'Report from the control page');
    assert.equal(decode(buildReport({ ...base, title: 'x'.repeat(500), note: '' }).url).get('title').length, 120);
  });
  test('truncation: URL stays within 6000 chars and says to attach the diag bundle', () => {
    const r = buildReport({ ...base, title: 'long', note: 'word '.repeat(2000), maxUrl: 1200 });
    assert.equal(r.truncated, true);
    assert.ok(r.url.length <= 1200, String(r.url.length));
    assert.ok(decode(r.url).get('body').endsWith(TRUNCATED_NOTE));
    assert.match(TRUNCATED_NOTE, /attach the diag bundle/);
    const emoji = buildReport({ ...base, title: 'e', note: '\u{1F600}'.repeat(740) });
    assert.equal(emoji.truncated, true);
    assert.ok(emoji.url.length <= MAX_URL);
    assert.doesNotThrow(() => decodeURIComponent(emoji.url.split('body=')[1]));
  });
  test('redaction: seeded brand term, key and token never appear (note, title, state text)', () => {
    const profile = { streamer: { brand: FAKE_BRAND } };
    const home = path.join(os.tmpdir(), 'seeded-home-dir');
    const redact = makeRedactor({ home, userName: 'seededuser', profile });
    const r = buildReport({
      ...base, redact, title: `crash on ${FAKE_BRAND} stream`, note: `${FAKE_BRAND} ${FAKE_SECRET} ${FAKE_TOKEN} rtmp://ingest.example.invalid/live/abc ${home}\\clips seededuser`,
      osText: `${FAKE_BRAND} OS`, outputs: { sinks: [{ state: FAKE_SECRET }] },
    });
    const all = `${r.url}\n${decodeURIComponent(r.url)}\n${decode(r.url).get('body')}`;
    for (const never of [FAKE_BRAND, FAKE_BRAND.toLowerCase(), FAKE_SECRET, 'hunter2hunter2', 'ingest.example.invalid', 'seeded-home-dir', 'seededuser']) assert.ok(!all.toLowerCase().includes(never.toLowerCase()), never);
  });
});

describe('createReporter (profile file)', () => {
  const profileWith = (obj) => { const f = path.join(mk(), 'profile.local.json'); writeFileSync(f, JSON.stringify(obj)); return f; };
  const ctx = { title: 't', note: 'n', flags: [], host: { available: false }, outputs: null, crashes: 0 };

  test('placeholder, missing, invalid and absent profile give a message and no URL', () => {
    for (const file of [profileWith({ links: { issues_url: '<private-repo-issues-url>' } }), profileWith({ links: {} }), path.join(mk(), 'nope.json')]) {
      const r = createReporter({ profileFile: file }).build(ctx);
      assert.deepEqual(r, { configured: false, reason: r.reason, message: SET_MESSAGE });
      assert.equal(r.url, undefined);
    }
    const bad = createReporter({ profileFile: profileWith({ links: { issues_url: 'http://github.com/o/r' } }) }).build(ctx);
    assert.equal(bad.configured, false);
    assert.equal(bad.reason, 'invalid');
    assert.match(bad.message, /https:\/\/github\.com\/<owner>\/<repo>/);
  });
  test('a valid profile gives the URL; the profile brand term is redacted from the typed note', () => {
    const f = profileWith({ streamer: { brand: FAKE_BRAND }, links: { issues_url: ISSUES } });
    const r = createReporter({ profileFile: f, osText: 'TestOS' }).build({ ...ctx, note: `hello ${FAKE_BRAND}` });
    assert.equal(r.configured, true);
    assert.ok(r.url.startsWith(`${ISSUES}/issues/new?`));
    assert.ok(!decodeURIComponent(r.url).includes(FAKE_BRAND));
  });
});

// ---- over the server ----
function raw(port, { url = '/', headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers, json() { return JSON.parse(this.text); } }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function boot({ flagOn = true, profile } = {}) {
  const dataDir = mk();
  if (flagOn) createFlags({ dataDir }).set('report-button', true);
  let profileFile;
  if (profile !== undefined) { profileFile = path.join(mk(), 'profile.local.json'); writeFileSync(profileFile, JSON.stringify(profile)); }
  const fake = createFakeHost({ outputsReady: true });
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: fake, launchKey: KEY, dataDir, profileFile, limits: { statusPollMs: 50 } });
  servers.push(srv);
  const { port } = await srv.listen();
  const l = await raw(port, { url: `/login?k=${KEY}` });
  return { port, cookie: l.headers['set-cookie'][0].split(';')[0] };
}
const get = (c, url) => raw(c.port, { url, headers: { cookie: c.cookie } });

describe('GET /ui/api/report-url', () => {
  test('flag defined, off by default; 404 while off; needs the session', async () => {
    const defs = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags;
    assert.equal(defs.find((f) => f.id === 'report-button').default, false);
    const c = await boot({ flagOn: false, profile: { links: { issues_url: ISSUES } } });
    const r = await get(c, '/ui/api/report-url?title=x');
    assert.equal(r.status, 404);
    assert.equal(r.json().error, 'report-button-off');
    assert.notEqual((await raw(c.port, { url: '/ui/api/report-url' })).status, 200);
  });
  test('placeholder profile: message, no URL', async () => {
    const c = await boot({ profile: { links: { issues_url: '<private-repo-issues-url>' } } });
    const r = await get(c, '/ui/api/report-url');
    assert.equal(r.status, 200);
    const j = r.json();
    assert.equal(j.configured, false);
    assert.equal(j.message, SET_MESSAGE);
    assert.equal(j.url, undefined);
  });
  test('valid profile: prefilled URL with title, note and counts; no profile term, key or path in it', async () => {
    const c = await boot({ profile: { streamer: { brand: FAKE_BRAND }, links: { issues_url: ISSUES } } });
    const r = await get(c, `/ui/api/report-url?title=${encodeURIComponent(`Broken ${FAKE_BRAND}`)}&note=${encodeURIComponent(`see ${FAKE_SECRET} ${FAKE_TOKEN}`)}`);
    assert.equal(r.status, 200);
    const j = r.json();
    assert.equal(j.configured, true);
    assert.ok(j.url.startsWith(`${ISSUES}/issues/new?title=`));
    const body = decode(j.url).get('body');
    assert.match(body, /Ujwalam: /);
    assert.match(body, /Diagnostics summary \(counts and states only\)/);
    const all = decodeURIComponent(j.url);
    for (const never of [FAKE_BRAND, FAKE_SECRET, 'hunter2hunter2', os.userInfo().username, os.homedir()]) assert.ok(!all.includes(never), never);
  });
  test('unknown query keys and oversize input are refused', async () => {
    const c = await boot({ profile: { links: { issues_url: ISSUES } } });
    assert.equal((await get(c, '/ui/api/report-url?x=1')).status, 400);
    assert.equal((await get(c, `/ui/api/report-url?note=${'a'.repeat(7000)}`)).status, 400);
  });
  test('the page wiring: safe DOM, https://github.com guard, opens with noopener', () => {
    const js = readFileSync(path.join(UI, 'js', 'app.js'), 'utf8');
    assert.match(js, /window\.open\(r\.url, '_blank', 'noopener'\)/);
    assert.match(js, /u\.protocol !== 'https:' \|\| u\.hostname !== 'github\.com'/);
    assert.ok(!/innerHTML/.test(js));
    assert.match(readFileSync(path.join(UI, 'index.html'), 'utf8'), /id="btn-report"/);
  });
});
