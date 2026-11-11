// SPDX-License-Identifier: GPL-3.0-or-later
// LU5/LU7 live updates (D343), unit, server and page tests: the busy rule (fresh outputs.status, streams and
// recordings), host staging and its apply at the stop, the one-click gate for services while live (no typed phrase,
// no "are you sure"), close with a staged host update, the control page's versions and waiting items, LU1 parts, and
// that every feature flag added since 2026-11-10 is off by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  createUpdates, HOST_STAGE_FILE, hostArgsFor, hostEntry, outputsBusy, readUpdatesStatus, serveUpdates, takeStartupHost, UPDATE_MSG, updatesClient, UPDATES_FILE,
} from '../services/supervisor/updates.mjs';
import { changedParts, partOf, releaseParts } from '../tools/package/parts.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_HOST = path.join(REPO, 'tests', 'fixtures', 'studio-ui', 'fake-host.mjs');
const SESSION = 'a'.repeat(32);
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-lu5-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick(); }

/** A staged fixture release: bin/ujwalam-host.mjs (the fake host) and release.json with its hash. */
function stagedRelease(root, { n = 99, version = `0.1.0-alpha.${n}`, badHash = false, parts = null } = {}) {
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const exe = path.join(root, 'bin', 'ujwalam-host.mjs');
  copyFileSync(FAKE_HOST, exe);
  const sha = createHash('sha256').update(readFileSync(exe)).digest('hex');
  writeFileSync(path.join(root, 'release.json'), JSON.stringify({ version, n, hostExeSha256: badHash ? '0'.repeat(64) : sha, ...(parts ? { parts } : {}) }));
  return root;
}
const sinks = (...xs) => ({ sinks: xs.map(([kind, state]) => ({ id: `${kind}-${state}`, kind, state })) });

test('busy: a stream or a recording starting, live, reconnecting, retrying or stopping; an unreadable status is busy', () => {
  for (const st of ['starting', 'live', 'reconnecting', 'retrying', 'stopping']) {
    assert.equal(outputsBusy(sinks(['stream', st])), true, `stream ${st}`);
    assert.equal(outputsBusy(sinks(['record', st])), true, `record ${st}`);
  }
  for (const st of ['idle', 'stopped', 'failed']) assert.equal(outputsBusy(sinks(['stream', st], ['record', st])), false, st);
  assert.equal(outputsBusy({ sinks: [] }), false);
  assert.equal(outputsBusy(null), true);
  assert.equal(outputsBusy({}), true);
});

test('hostEntry: the package layout, the hash in release.json, a stand-in script only for a stand-in host', () => {
  const r = stagedRelease(path.join(tmp(), 'rel'));
  const e = hostEntry(r, { script: true, runtime: 'RT' });
  assert.equal(e.problem, undefined);
  assert.deepEqual([e.exe, e.runtime, e.version, e.n, e.root], [path.join(r, 'bin', 'ujwalam-host.mjs'), 'RT', '0.1.0-alpha.99', 99, r]);
  assert.match(hostEntry(r, { script: false }).problem, /no host exe/);
  assert.match(hostEntry('relative', { script: true }).problem, /absolute/);
  assert.match(hostEntry(tmp(), { script: true }).problem, /release\.json/);
  assert.match(hostEntry(stagedRelease(path.join(tmp(), 'bad'), { badHash: true }), { script: true }).problem, /does not match the hash/);
  // A real host also needs the OBS runtime of the release (obs/).
  const real = path.join(tmp(), 'real');
  mkdirSync(path.join(real, 'bin'), { recursive: true });
  writeFileSync(path.join(real, 'bin', 'ujwalam-host.exe'), 'x');
  writeFileSync(path.join(real, 'release.json'), JSON.stringify({ version: '0.1.0-alpha.5', n: 5 }));
  assert.match(hostEntry(real).problem, /OBS runtime/);
  mkdirSync(path.join(real, 'obs'));
  mkdirSync(path.join(real, 'app', 'host', 'overlay'), { recursive: true });
  writeFileSync(path.join(real, 'app', 'host', 'overlay', 'child.mjs'), '');
  const re = hostEntry(real);
  assert.deepEqual([re.runtime, re.overlayScript], [path.join(real, 'obs'), path.join(real, 'app', 'host', 'overlay', 'child.mjs')], 'the overlay server follows the host');
  assert.deepEqual(hostArgsFor(['--runtime', 'A', '--x', '1', '--overlay-script', 'B'], re), ['--runtime', re.runtime, '--x', '1', '--overlay-script', re.overlayScript]);
  assert.deepEqual(hostArgsFor(['--runtime', 'A'], { runtime: 'C', overlayScript: null }), ['--runtime', 'C']);
});

function queue(over = {}) {
  const dataDir = over.dataDir ?? tmp();
  const calls = [];
  const st = { busy: true, unreadable: false };
  const u = createUpdates({
    dataDir, session: SESSION, own: null, pollMs: 20,
    outputs: async () => { if (st.unreadable) throw new Error('no answer'); return st.busy ? sinks(['stream', 'live']) : sinks(['stream', 'stopped'], ['record', 'stopped']); },
    applyHost: async (entry) => { calls.push(['host', entry.version]); return over.hostResult ?? { result: 'swapped' }; },
    swapService: async (service, root) => { calls.push([service, root]); return { result: 'swapped' }; },
    hostInfo: () => ({ script: true, runtime: 'RT', root: null }),
    ...over,
  });
  const mirror = () => JSON.parse(readFileSync(path.join(dataDir, 'live', UPDATES_FILE), 'utf8'));
  const stage = () => { try { return JSON.parse(readFileSync(path.join(dataDir, 'live', HOST_STAGE_FILE), 'utf8')); } catch { return null; } };
  return { u, calls, st, dataDir, mirror, stage };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };

test('LU5: a host update while live is staged, never applied while busy (not even on a click), and applied after the stop', async () => {
  const q = queue();
  const rel = stagedRelease(path.join(tmp(), 'rel'));
  const r = await q.u.request({ service: 'host', root: rel });
  assert.equal(r.result, 'staged');
  assert.match(r.reason, /waits until every stream and recording has stopped/);
  assert.deepEqual(q.calls, [], 'nothing applied while live');
  assert.equal(q.stage().state, 'staged');
  const m = q.mirror();
  assert.equal(m.waiting.length, 1);
  assert.deepEqual([m.waiting[0].part, m.waiting[0].click, m.waiting[0].version], ['host', false, '0.1.0-alpha.99']);
  // A click on the host item while live is refused; the item keeps waiting.
  assert.equal((await q.u.apply(r.id)).result, 'refused');
  // Unreadable status counts as busy.
  q.st.unreadable = true; await q.u.tick(); assert.deepEqual(q.calls, []);
  q.st.unreadable = false;
  // Recording only (stream stopped) is still busy: the stop rule covers recordings.
  q.st.busy = true; await q.u.tick(); assert.deepEqual(q.calls, []);
  q.st.busy = false;
  assert.ok(await until(() => q.calls.length === 1), 'applied by the poll after the stop');
  assert.deepEqual(q.calls, [['host', '0.1.0-alpha.99']]);
  await q.u.tick();
  const after = q.mirror();
  assert.equal(after.waiting.length, 0);
  assert.equal(after.parts.find((p) => p.part === 'host').version, '0.1.0-alpha.99');
  assert.equal(after.parts.find((p) => p.part === 'overlay-server').version, '0.1.0-alpha.99', 'the overlay server follows the host');
  assert.match(after.recent[0].text, /updated to 0\.1\.0-alpha\.99/);
  assert.equal(q.stage().state, 'applied', 'kept, so the next start does not go back to the older host');
});

test('LU5: the overlay server alone is updated as a host update; not busy applies at once; a newer host update replaces the waiting one', async () => {
  const q = queue();
  q.st.busy = false;
  const a = stagedRelease(path.join(tmp(), 'a'), { n: 50 });
  assert.equal((await q.u.request({ service: 'overlay-server', root: a })).result, 'swapped');
  assert.deepEqual(q.calls, [['host', '0.1.0-alpha.50']]);
  q.st.busy = true;
  const b = stagedRelease(path.join(tmp(), 'b'), { n: 51 });
  const c = stagedRelease(path.join(tmp(), 'c'), { n: 52 });
  assert.equal((await q.u.request({ service: 'host', root: b })).result, 'staged');
  assert.equal((await q.u.request({ service: 'host', root: c })).result, 'staged');
  assert.deepEqual(q.mirror().waiting.map((w) => w.version), ['0.1.0-alpha.52']);
  assert.match(q.mirror().recent[0].text, /0\.1\.0-alpha\.51 not applied \(replaced/);
  q.st.busy = false;
  assert.ok(await until(() => q.calls.length === 2));
  assert.deepEqual(q.calls[1], ['host', '0.1.0-alpha.52']);
});

test('LU5: refused updates: bad hash, no host, unchanged host part, unknown service, flag off, closing', async () => {
  const q = queue();
  assert.match((await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'bad'), { badHash: true }) })).reason, /hash/);
  const noHost = queue({ applyHost: null });
  assert.match((await noHost.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'x')) })).reason, /no host/);
  const same = { host: { files: 3, sha256: 'f'.repeat(64) } };
  const cur = stagedRelease(path.join(tmp(), 'cur'), { n: 10, parts: same });
  const q2 = queue({ hostInfo: () => ({ script: true, runtime: 'RT', root: cur }) });
  assert.equal((await q2.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'nxt'), { n: 11, parts: same }) })).result, 'unchanged');
  assert.equal((await q.u.request({ service: 'live-clipper', root: REPO })).result, 'refused');
  const off = queue({ accepting: false });
  assert.match((await off.u.request({ service: 'event-core', root: REPO })).reason, /flag service-swap/);
  q.u.close();
  assert.match((await q.u.request({ service: 'event-core', root: REPO })).reason, /closing/);
  assert.deepEqual([...q.calls, ...noHost.calls, ...q2.calls, ...off.calls], []);
});

test('LU7: a service update while live waits for ONE click (no phrase, no question); not busy it applies at once', async () => {
  const q = queue();
  const r = await q.u.request({ service: 'event-core', root: REPO });
  assert.equal(r.result, 'waiting');
  assert.deepEqual(q.calls, [], 'not applied on its own while live');
  const w = q.mirror().waiting[0];
  assert.deepEqual([w.part, w.click], ['event-core', true]);
  assert.match(w.text, /Apply now/);
  // The click: applied while live (LU3 keeps the stream), nothing else asked.
  const c = await q.u.apply(w.id);
  assert.equal(c.result, 'swapped');
  assert.deepEqual(q.calls, [['event-core', REPO]]);
  assert.equal((await q.u.apply(w.id)).result, 'refused', 'a click is single-use');
  // Unreadable status: also waits for the click.
  q.st.unreadable = true;
  assert.equal((await q.u.request({ service: 'studio-ui', root: REPO })).result, 'waiting');
  q.st.unreadable = false; q.st.busy = false;
  assert.ok(await until(() => q.calls.length === 2), 'nobody clicked: applied at the stop');
  // Not live: applied at once.
  assert.equal((await q.u.request({ service: 'studio-ui', root: REPO })).result, 'swapped');
  assert.equal(q.calls.length, 3);
  assert.match((await q.u.request({ service: 'event-core', root: path.join(REPO, 'docs') })).reason, /entry file/);
});

test('LU5: closing with a staged host update keeps it for the next start; waiting services are dropped; the next start uses it until the installed release has it', async () => {
  const q = queue();
  const rel = stagedRelease(path.join(tmp(), 'rel'), { n: 30 });
  await q.u.request({ service: 'host', root: rel });
  await q.u.request({ service: 'event-core', root: REPO });
  const lines = q.u.close();
  assert.deepEqual(lines, ['host update 0.1.0-alpha.30 waits: it is applied at the next start', 'event-core update unversioned not applied (Ujwalam closed)']);
  assert.equal(q.stage().state, 'staged');
  // Next start (dev checkout, no release.json): the staged host is used.
  const t = takeStartupHost({ dataDir: q.dataDir, own: null, script: true, runtime: 'RT' });
  assert.equal(t.state, 'staged');
  assert.deepEqual([t.entry.exe, t.entry.version, t.entry.root], [path.join(rel, 'bin', 'ujwalam-host.mjs'), '0.1.0-alpha.30', rel]);
  assert.ok(existsSync(path.join(q.dataDir, 'live', HOST_STAGE_FILE)), 'kept until the installed release catches up');
  // The installed release is now as new: the record is dropped.
  assert.equal(takeStartupHost({ dataDir: q.dataDir, own: { version: 'x', n: 30 }, script: true }).dropped, 'the running release already has it');
  assert.equal(existsSync(path.join(q.dataDir, 'live', HOST_STAGE_FILE)), false);
  // A folder that went away (or was tampered with) is dropped with the reason.
  const q2 = queue();
  const gone = stagedRelease(path.join(tmp(), 'gone'), { n: 31 });
  await q2.u.request({ service: 'host', root: gone });
  q2.u.close();
  writeFileSync(path.join(gone, 'bin', 'ujwalam-host.mjs'), 'changed');
  assert.match(takeStartupHost({ dataDir: q2.dataDir, own: null, script: true }).dropped, /hash/);
});

test('LU5: a failed host apply keeps the previous applied release for the next start', async () => {
  const startup = { entry: hostEntry(stagedRelease(path.join(tmp(), 'old'), { n: 40 }), { script: true }), state: 'applied' };
  const q2 = queue({ startupHost: startup, hostResult: { result: 'restored-old', reason: 'the host did not get ready' } });
  q2.st.busy = false;
  const r = await q2.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'new'), { n: 41 }) });
  assert.equal(r.result, 'restored-old');
  assert.equal(q2.stage().n, 40, 'the previous applied release stays the one the next start uses');
  assert.equal(q2.mirror().parts.find((p) => p.part === 'host').version, '0.1.0-alpha.40');
});

test('readUpdatesStatus: only this session, plain fields only', () => {
  const d = tmp();
  assert.equal(readUpdatesStatus(d, SESSION), null);
  mkdirSync(path.join(d, 'live'));
  writeFileSync(path.join(d, 'live', UPDATES_FILE), JSON.stringify({ session: SESSION, accepting: true, parts: [{ part: 'host', label: 'Video engine (host)', version: 'v1', root: 'C:/secret/path' }], waiting: [{ id: 'u1', part: 'host', version: 'v2', click: false, text: 't', root: 'C:/x' }], recent: [] }));
  const s = readUpdatesStatus(d, SESSION);
  assert.equal(JSON.stringify(s).includes('secret'), false, 'no paths reach the page');
  assert.deepEqual(s.waiting[0], { id: 'u1', part: 'host', version: 'v2', click: false, text: 't', at: null });
  assert.equal(readUpdatesStatus(d, 'b'.repeat(32)), null, 'another session');
  assert.equal(readUpdatesStatus(d, 'not-hex'), null);
});

test('IPC: the UI server asks the launcher to apply one item; bad requests are refused', async () => {
  const child = new EventEmitter(); child.connected = true; child.sent = [];
  const ui = new EventEmitter(); ui.connected = true;
  child.send = (m) => { child.sent.push(m); setImmediate(() => ui.emit('message', m)); };
  ui.send = (m) => { setImmediate(() => child.emit('message', m)); };
  const applied = [];
  serveUpdates(child, { apply: async (id) => { applied.push(id); return { result: 'swapped' }; } });
  const c = updatesClient({ proc: ui, timeoutMs: 1000 });
  assert.deepEqual(await c.apply('u7'), { result: 'swapped', reason: undefined });
  assert.deepEqual(applied, ['u7']);
  child.emit('message', { t: UPDATE_MSG, id: 9, op: 'apply', item: '../x' });
  await settle();
  assert.equal(child.sent.at(-1).result, 'refused');
  assert.equal(updatesClient({ proc: new EventEmitter() }), null, 'no IPC channel: no client');
});

test('server: versions and waiting items in the status; one click POST applies; GET cannot; no session cannot', async () => {
  const fake = createFakeHost();
  const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const KEY = 'k'.repeat(48);
  let state = { accepting: true, parts: [{ part: 'host', label: 'Video engine (host)', version: 'dev' }], waiting: [{ id: 'u1', part: 'event-core', version: '0.1.0-alpha.99', click: true, text: 'ready' }], recent: [] };
  const clicks = [];
  const srv = createStudioServer({ uiRoot: path.join(REPO, 'ui'), core, host, launchKey: KEY, dataDir: tmp(), limits: { statusPollMs: 1000 }, log: () => {},
    updatesStatus: () => state,
    updates: { apply: async (id) => { clicks.push(id); if (id === 'u1') { state = { ...state, waiting: [] }; return { result: 'swapped' }; } return { result: 'refused', reason: 'the host is updated only when every stream and recording has stopped' }; } } });
  const { port } = await srv.listen();
  const origin = `http://127.0.0.1:${port}`;
  const req = (method, u, { cookie, body, csrf } = {}) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: u, method, headers: { ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin } : {}), ...(csrf ? { 'x-ujwalam-csrf': csrf } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    if (data) r.write(data);
    r.end();
  });
  try {
    assert.notEqual((await req('POST', '/ui/api/updates/apply', { body: { id: 'u1' } })).status, 200, 'no session: refused');
    const cookie = (await req('GET', `/login?k=${KEY}`)).headers['set-cookie'][0].split(';')[0];
    const { csrf } = (await req('GET', '/ui/api/session', { cookie })).body;
    const st = (await req('GET', '/ui/api/status', { cookie })).body;
    assert.deepEqual(st.updates.waiting.map((w) => [w.id, w.click]), [['u1', true]]);
    assert.equal((await req('GET', '/ui/api/updates', { cookie })).body.updates.parts[0].version, 'dev');
    assert.equal((await req('GET', '/ui/api/updates/apply?id=u1', { cookie })).status, 405, 'a GET never applies');
    assert.equal((await req('POST', '/ui/api/updates/apply', { cookie, body: { id: 'u1' } })).status, 403, 'no CSRF: refused');
    assert.equal(clicks.length, 0);
    assert.equal((await req('POST', '/ui/api/updates/apply', { cookie, csrf, body: { id: 'x' } })).status, 400);
    const ok = await req('POST', '/ui/api/updates/apply', { cookie, csrf, body: { id: 'u1' } });
    assert.deepEqual([ok.status, ok.body.result, ok.body.updates.waiting.length], [200, 'swapped', 0]);
    const no = await req('POST', '/ui/api/updates/apply', { cookie, csrf, body: { id: 'u2' } });
    assert.deepEqual([no.status, no.body.error, no.body.detail], [409, 'refused', 'the host is updated only when every stream and recording has stopped']);
    assert.deepEqual(clicks, ['u1', 'u2'], 'one call per click, nothing asked in between');
  } finally { await srv.close(); }
});

test('page: each part\'s version and the waiting items; Apply now is one click with no question; a host item waits for the stop', async () => {
  const SRC = readFileSync(path.join(REPO, 'ui', 'js', 'app.js'), 'utf8');
  const HTML = readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8');
  for (const id of ['upd-parts', 'upd-list', 'upd-note', 'st-updates']) assert.ok(HTML.includes(`id="${id}"`), id);
  const els = new Map();
  const mk = (id) => ({ id, hidden: false, value: '', textContent: '', className: '', disabled: false, title: '', style: {}, children: [], handlers: {},
    addEventListener(t, h) { (this.handlers[t] ??= []).push(h); }, appendChild(c) { this.children.push(c); }, removeChild() {}, setAttribute() {}, focus() {},
    checkValidity: () => true, classList: { add() {}, remove() {}, toggle() {} }, get firstChild() { return this.children[0] ?? null; } });
  const document = { hidden: false, getElementById: (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); }, addEventListener() {} };
  const Dom = { el: (tag, attrs = {}, kids = []) => ({ ...mk(tag), ...attrs, children: kids }), clear: (e) => { e.children = []; }, setText: (e, t) => { e.textContent = String(t); } };
  const applied = []; const asked = [];
  let statusCb = null;
  const Api = {
    session: async () => ({}), status: async () => ({ host: {} }), edits: async () => ({ edits: [] }), flags: async () => ({ flags: [] }),
    structure: async () => ({ available: false }), events: (onStatus) => { statusCb = onStatus; }, cancel: async () => {},
    host: async () => ({ result: {} }),
    updateApply: async (id) => { applied.push(id); return { result: 'swapped', updates: { accepting: true, parts: [], waiting: [], recent: [{ text: 'Event core updated to 0.1.0-alpha.99.' }] } }; },
  };
  const window = { confirm: (q) => { asked.push(q); return false; }, prompt: (q) => { asked.push(q); return null; } };
  const ctx = { document, Dom, Api, window, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout, console, Promise };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  await settle();
  statusCb({ host: { live: true }, updates: {
    accepting: true,
    parts: [{ part: 'host', label: 'Video engine (host)', version: 'dev' }, { part: 'overlay-server', label: 'Overlay server', version: 'dev', follows: 'host' }, { part: 'event-core', label: 'Event core', version: 'dev' }],
    waiting: [{ id: 'u1', part: 'host', version: '0.1.0-alpha.99', click: false, text: 'Video engine (host) update 0.1.0-alpha.99 waits until every stream and recording has stopped.' },
      { id: 'u2', part: 'event-core', version: '0.1.0-alpha.99', click: true, text: 'Event core update 0.1.0-alpha.99 is ready.' }],
    recent: [] } });
  await settle();
  const parts = els.get('upd-parts').children.map((li) => li.children.map((c) => c.text ?? c.textContent).join(' '));
  assert.deepEqual(parts, ['Video engine (host) dev', 'Overlay server dev (follows the host)', 'Event core dev']);
  const rows = els.get('upd-list').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[1].text, 'Waiting for stop', 'the host item has no button');
  assert.equal(rows[0].children.some((c) => c.onclick), false);
  const btn = rows[1].children[1];
  assert.equal(btn.text, 'Apply now');
  assert.deepEqual([els.get('st-updates').hidden, els.get('st-updates').textContent], [false, 'Updates waiting: 2']);
  btn.onclick();
  await settle();
  assert.deepEqual(applied, ['u2'], 'one click, one apply');
  assert.deepEqual(asked, [], 'no question, no typed phrase (D332)');
  assert.equal(els.get('upd-note').textContent, 'Event core updated to 0.1.0-alpha.99.', 'the result in plain words');
  assert.equal(els.get('st-updates').hidden, true);
});

test('LU1: every packaged file has a part; release.json parts tell what changed', () => {
  assert.deepEqual(['bin/ujwalam-host.exe', 'obs/bin/64bit/obs.dll', 'app/host/overlay/child.mjs', 'app/host/projects/test-card.project.json', 'studio/ujwalam-studio.exe', 'ujwalam-start.exe',
    'services/event-core/cli.mjs', 'ui/js/app.js', 'tools/diag/bundle.mjs', 'app/host/lib/config.mjs', 'data/flags.json', 'registry/functions/x.json', 'release.json', 'notices/GPL-3.0.txt'].map(partOf),
  ['host', 'host', 'host', 'host', 'studio-window', 'studio-window', 'services', 'services', 'services', 'services', 'data', 'data', 'meta', 'meta']);
  const content = { 'bin/ujwalam-host.exe': 'h1', 'services/a.mjs': 's1', 'data/a.json': 'd1', 'README.txt': 'r' };
  const files = (c) => Object.keys(c).map((rel) => ({ rel, abs: rel }));
  const a = releaseParts(files(content), (abs) => Buffer.from(content[abs]));
  assert.deepEqual(Object.keys(a), ['host', 'studio-window', 'services', 'overlay', 'data']);
  assert.equal(a.host.files, 1);
  const c2 = { ...content, 'services/a.mjs': 's2', 'README.txt': 'other' };
  const b = releaseParts(files(c2), (abs) => Buffer.from(c2[abs]));
  assert.deepEqual(changedParts(a, b), ['services'], 'only the services changed; meta files are not a part');
  assert.deepEqual(changedParts(null, b), ['host', 'studio-window', 'services', 'overlay', 'data']);
});

test('LU7: every feature flag added since 2026-11-10 is off by default, and every flag has a since date', () => {
  const { flags } = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8'));
  for (const f of flags) assert.match(f.since ?? '', /^\d{4}-\d{2}-\d{2}$/, `${f.id}: since must be a date`);
  const recent = flags.filter((f) => f.since >= '2026-11-10');
  assert.ok(recent.length >= 1);
  assert.deepEqual(recent.filter((f) => f.default !== false).map((f) => f.id), [], 'on by default');
});

test('LU5: a stream started between the check and the restart sends the host update back to waiting', async () => {
  let answer = { result: 'busy' };
  const q = queue({ applyHost: async (entry) => { q.calls.push(['host', entry.version]); return answer; } });
  q.st.busy = false;
  const r = await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'r'), { n: 60 }) });
  assert.equal(r.result, 'staged', 'the launcher\'s last check saw a stream: staged, not lost');
  assert.equal(q.stage().state, 'staged');
  answer = { result: 'swapped' };
  assert.ok(await until(() => q.calls.length === 2));
  await q.u.tick();
  assert.equal(q.mirror().waiting.length, 0);
  assert.equal(q.stage().state, 'applied');
});
