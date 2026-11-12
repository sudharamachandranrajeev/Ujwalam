// SPDX-License-Identifier: GPL-3.0-or-later
// LU5/LU7 live updates (D343), unit, server and page tests: the busy rule (fresh outputs.status, streams and
// recordings), host staging and its apply at the stop, the one-click gate for services while live (no typed phrase,
// no "are you sure"; nothing applies a service on its own), close with a staged host update, the control page's
// versions and waiting items, LU1 parts, and that every feature flag added since 2026-11-10 is off by default.
// Codex review of D343: the maintenance lock on starts, release integrity (metadata, whole-part hashes, a private
// copy), the startup trial records (pending / good / rejected), stale and superseded updates, confirmed host exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  acceptHost, createStartGate, createUpdates, HOST_STAGE_FILE, hostArgsFor, hostEntry, outputsBusy, readHostStage, readUpdatesStatus, rejectHost, RELEASES_DIR,
  serveUpdates, takeStartupHost, UPDATE_MSG, updatesClient, UPDATES_FILE,
} from '../services/supervisor/updates.mjs';
import { changedParts, folderFiles, partOf, releaseParts } from '../services/supervisor/parts.mjs';
import { createStudioServer, gateStarts } from '../services/studio-ui/server.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { authorityClient, createLiveAuthority, serveAuthority } from '../services/studio-ui/stream-recovery.mjs';
import { serveSwaps, stopHostChild } from '../services/studio-ui/launch.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_HOST = path.join(REPO, 'tests', 'fixtures', 'studio-ui', 'fake-host.mjs');
const SESSION = 'a'.repeat(32);
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-lu5-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick(); }
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const partsOf = (root) => releaseParts(folderFiles(root).filter((f) => f.rel !== 'release.json'));

/** A staged fixture release: bin/ujwalam-host.mjs (the fake host, or a broken one), release.json with the exe hash and
 *  the LU1 part hashes. omit: leave a field out of release.json. */
function stagedRelease(root, { n = 99, version = `0.1.0-alpha.${n}`, badHash = false, parts = null, broken = false, omit = [] } = {}) {
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const exe = path.join(root, 'bin', 'ujwalam-host.mjs');
  if (broken) writeFileSync(exe, 'process.exit(3);\n'); else copyFileSync(FAKE_HOST, exe);
  writeFileSync(path.join(root, 'bin', 'stamp.txt'), version); // each fixture release has its own host part hash
  const rel = { version, n, hostExeSha256: badHash ? '0'.repeat(64) : sha(exe), parts: parts ?? partsOf(root) };
  for (const k of omit) delete rel[k];
  writeFileSync(path.join(root, 'release.json'), JSON.stringify(rel));
  return root;
}
/** A service fixture release: both service entry files, data and release.json with the part hashes. */
function serviceRelease(root, { n = 99, version = `0.1.0-alpha.${n}`, omit = [] } = {}) {
  for (const s of ['event-core', 'studio-ui']) { mkdirSync(path.join(root, 'services', s), { recursive: true }); writeFileSync(path.join(root, 'services', s, 'cli.mjs'), `// ${s} ${n}\n`); }
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'flags.json'), '{}\n');
  const rel = { version, n, parts: partsOf(root) };
  for (const k of omit) delete rel[k];
  writeFileSync(path.join(root, 'release.json'), JSON.stringify(rel));
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

test('hostEntry: the package layout, the hashes in release.json (required), a stand-in script only for a stand-in host', () => {
  const r = stagedRelease(path.join(tmp(), 'rel'));
  const e = hostEntry(r, { script: true, runtime: 'RT' });
  assert.equal(e.problem, undefined);
  assert.deepEqual([e.exe, e.runtime, e.version, e.n, e.root], [path.join(r, 'bin', 'ujwalam-host.mjs'), 'RT', '0.1.0-alpha.99', 99, r]);
  assert.match(hostEntry(r, { script: false }).problem, /no host exe/);
  assert.match(hostEntry('relative', { script: true }).problem, /absolute/);
  assert.match(hostEntry(tmp(), { script: true }).problem, /release\.json/);
  assert.match(hostEntry(stagedRelease(path.join(tmp(), 'bad'), { badHash: true }), { script: true }).problem, /does not match the hash/);
  // Codex review: metadata is required, not optional.
  assert.match(hostEntry(stagedRelease(path.join(tmp(), 'noexe'), { omit: ['hostExeSha256'] }), { script: true }).problem, /no host exe hash/);
  assert.match(hostEntry(stagedRelease(path.join(tmp(), 'noparts'), { omit: ['parts'] }), { script: true }).problem, /no host hash/);
  assert.match(hostEntry(stagedRelease(path.join(tmp(), 'non'), { omit: ['n'] }), { script: true }).problem, /release number/);
  // A real host also needs the OBS runtime of the release (obs/).
  const real = path.join(tmp(), 'real');
  mkdirSync(path.join(real, 'bin'), { recursive: true });
  writeFileSync(path.join(real, 'bin', 'ujwalam-host.exe'), 'x');
  const relOf = () => writeFileSync(path.join(real, 'release.json'), JSON.stringify({ version: '0.1.0-alpha.5', n: 5, hostExeSha256: sha(path.join(real, 'bin', 'ujwalam-host.exe')), parts: partsOf(real) }));
  relOf();
  assert.match(hostEntry(real).problem, /OBS runtime/);
  mkdirSync(path.join(real, 'obs'));
  mkdirSync(path.join(real, 'app', 'host', 'overlay'), { recursive: true });
  writeFileSync(path.join(real, 'app', 'host', 'overlay', 'child.mjs'), '');
  relOf();
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
    hostInfo: () => ({ script: true, runtime: 'RT' }),
    ...over,
  });
  const mirror = () => JSON.parse(readFileSync(path.join(dataDir, 'live', UPDATES_FILE), 'utf8'));
  const stage = () => readHostStage(dataDir);
  const copies = () => path.join(dataDir, 'live', RELEASES_DIR);
  return { u, calls, st, dataDir, mirror, stage, copies };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };

test('LU5: a host update while live is staged, never applied while busy (not even on a click), and applied after the stop', async () => {
  const q = queue();
  const rel = stagedRelease(path.join(tmp(), 'rel'));
  const r = await q.u.request({ service: 'host', root: rel });
  assert.equal(r.result, 'staged');
  assert.match(r.reason, /waits until every stream and recording has stopped/);
  assert.deepEqual(q.calls, [], 'nothing applied while live');
  assert.equal(q.stage().pending.n, 99);
  assert.ok(q.stage().pending.root.startsWith(q.copies()), 'staged from a private copy, not the offered folder');
  const m = q.mirror();
  assert.equal(m.waiting.length, 1);
  assert.deepEqual([m.waiting[0].part, m.waiting[0].click, m.waiting[0].version], ['host', false, '0.1.0-alpha.99']);
  // A click on the host item while live is refused; the item keeps waiting.
  assert.equal((await q.u.apply(r.id)).result, 'refused');
  // Unreadable status counts as busy.
  q.st.unreadable = true; await q.u.tick(); assert.deepEqual(q.calls, []);
  q.st.unreadable = false;
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
  assert.deepEqual([q.stage().pending, q.stage().good.n], [null, 99], 'the last known good host for the next start');
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
  const nxt = stagedRelease(path.join(tmp(), 'nxt'), { n: 11 });
  const same = JSON.parse(readFileSync(path.join(nxt, 'release.json'), 'utf8')).parts;
  const q2 = queue({ own: { version: '0.1.0-alpha.10', n: 10, parts: same } });
  assert.equal((await q2.u.request({ service: 'host', root: nxt })).result, 'unchanged');
  const svc = serviceRelease(path.join(tmp(), 'svc'));
  assert.equal((await q.u.request({ service: 'live-clipper', root: svc })).result, 'refused');
  const off = queue({ accepting: false });
  assert.match((await off.u.request({ service: 'event-core', root: svc })).reason, /flag service-swap/);
  q.u.close();
  assert.match((await q.u.request({ service: 'event-core', root: svc })).reason, /closing/);
  assert.deepEqual([...q.calls, ...noHost.calls, ...q2.calls, ...off.calls], []);
});

test('LU7: a service update while live waits for ONE click (no phrase, no question); nothing applies it on its own, not even the stop', async () => {
  const q = queue();
  const svc = serviceRelease(path.join(tmp(), 'svc'), { n: 5 });
  const r = await q.u.request({ service: 'event-core', root: svc });
  assert.equal(r.result, 'waiting');
  assert.deepEqual(q.calls, [], 'not applied on its own while live');
  const w = q.mirror().waiting[0];
  assert.deepEqual([w.part, w.click], ['event-core', true]);
  assert.match(w.text, /Apply now/);
  assert.doesNotMatch(w.text, /applied when every stream/, 'the page does not promise an apply at the stop');
  // The click: applied while live (LU3 keeps the stream), nothing else asked; from the private copy.
  const c = await q.u.apply(w.id);
  assert.equal(c.result, 'swapped');
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0][0], 'event-core');
  assert.ok(q.calls[0][1].startsWith(q.copies()), 'swapped from the checked copy');
  assert.equal((await q.u.apply(w.id)).result, 'refused', 'a click is single-use');
  // Codex review P2-5: the stop does not apply a waiting service; it waits for its click.
  q.st.unreadable = true;
  const ui = await q.u.request({ service: 'studio-ui', root: svc });
  assert.equal(ui.result, 'waiting');
  q.st.unreadable = false; q.st.busy = false;
  for (let i = 0; i < 5; i++) { await q.u.tick(); await new Promise((res) => setTimeout(res, 30)); }
  assert.equal(q.calls.length, 1, 'nobody clicked: still waiting after the stop');
  assert.deepEqual(q.mirror().waiting.map((x) => x.part), ['studio-ui']);
  assert.equal((await q.u.apply(ui.id)).result, 'swapped');
  // Not live: a request is the user's own install action and applies at once.
  assert.equal((await q.u.request({ service: 'studio-ui', root: serviceRelease(path.join(tmp(), 'svc6'), { n: 6 }) })).result, 'swapped');
  assert.equal(q.calls.length, 3);
  assert.match((await q.u.request({ service: 'event-core', root: path.join(REPO, 'docs') })).reason, /entry file/);
});

test('LU5: closing with a staged host update keeps it pending for the next start; waiting services are dropped; the start trial order is pending, then good', async () => {
  const q = queue();
  const rel = stagedRelease(path.join(tmp(), 'rel'), { n: 30 });
  await q.u.request({ service: 'host', root: rel });
  await q.u.request({ service: 'event-core', root: serviceRelease(path.join(tmp(), 'svc'), { n: 3 }) });
  const lines = q.u.close();
  assert.deepEqual(lines, ['host update 0.1.0-alpha.30 waits: it is tried at the next start', 'event-core update 0.1.0-alpha.3 not applied (Ujwalam closed)']);
  assert.equal(q.stage().pending.n, 30);
  // Next start (dev checkout, no release.json): the staged host is the first candidate.
  const t = takeStartupHost({ dataDir: q.dataDir, own: null, script: true, runtime: 'RT' });
  assert.deepEqual(t.candidates.map((c) => [c.kind, c.entry.version]), [['pending', '0.1.0-alpha.30']]);
  assert.ok(t.candidates[0].entry.exe.startsWith(q.copies()));
  assert.equal(readdirSync(q.copies()).length, 1, 'the service copy no record names is removed at the start');
  // The installed release is now as new: the record is dropped.
  const t2 = takeStartupHost({ dataDir: q.dataDir, own: { version: 'x', n: 30 }, script: true });
  assert.deepEqual([t2.candidates.length, t2.dropped], [0, ['0.1.0-alpha.30: the running release already has it']]);
  assert.equal(existsSync(path.join(q.dataDir, 'live', HOST_STAGE_FILE)), false);
});

test('LU5: a failed host apply is rejected for good; the last known good stays the one the next start uses', async () => {
  const dataDir = tmp();
  const old = hostEntry(stagedRelease(path.join(tmp(), 'old'), { n: 40 }), { script: true });
  acceptHost(dataDir, old);
  const q2 = queue({ dataDir, startupHost: { entry: old, kind: 'good' }, hostResult: { result: 'restored-old', reason: 'the host did not get ready', candidateFailed: true } });
  q2.st.busy = false;
  const r = await q2.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'new'), { n: 41 }) });
  assert.equal(r.result, 'restored-old');
  const st = q2.stage();
  assert.deepEqual([st.good.n, st.pending, st.rejected.map((x) => x.n)], [40, null, [41]]);
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

test('LU7: every feature flag added since 2026-11-10 is off by default (except one the user turned on by decision), and every flag has a since date', () => {
  const ON_BY_DECISION = ['reel-thumbnail']; // D368: the user asked for reel thumbnails on by default (2026-11-12)
  const { flags } = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8'));
  for (const f of flags) assert.match(f.since ?? '', /^\d{4}-\d{2}-\d{2}$/, `${f.id}: since must be a date`);
  const recent = flags.filter((f) => f.since >= '2026-11-10');
  assert.ok(recent.length >= 1);
  assert.deepEqual(recent.filter((f) => f.default !== false && !ON_BY_DECISION.includes(f.id)).map((f) => f.id), [], 'on by default');
});


test('LU5: a stream started between the check and the restart sends the host update back to waiting', async () => {
  let answer = { result: 'busy' };
  const q = queue({ applyHost: async (entry) => { q.calls.push(['host', entry.version]); return answer; } });
  q.st.busy = false;
  const r = await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'r'), { n: 60 }) });
  assert.equal(r.result, 'staged', 'the launcher\'s last check saw a stream: staged, not lost');
  assert.equal(q.stage().pending.n, 60);
  answer = { result: 'swapped' };
  assert.ok(await until(() => q.calls.length === 2));
  await q.u.tick();
  assert.equal(q.mirror().waiting.length, 0);
  assert.deepEqual([q.stage().pending, q.stage().good.n], [null, 60]);
});

// ---- Codex review of D343 ----

test('P1-1 maintenance lock: hold refuses new starts at once, waits for starts on their way, and ends after the replacement', async () => {
  const g = createStartGate();
  const a = g.lease('ui1');
  assert.equal(a.ok, true);
  let held = false;
  const h = g.hold('the video engine (host) is being updated', 2000).then((v) => { held = v; });
  await settle();
  assert.equal(held, false, 'not held while a start is on its way to the host');
  const b = g.lease('ui1');
  assert.deepEqual([b.ok, b.reason], [false, 'the video engine (host) is being updated'], 'no new start once the hold began');
  g.release(a.lease);
  await h;
  assert.equal(held, true);
  assert.equal(await g.hold('again'), false, 'one hold at a time');
  g.end();
  assert.equal(g.lease('ui1').ok, true, 'starts allowed again after the replacement or rollback');
  // A start that never finishes: the hold gives up (the update goes back to waiting) and lifts the lock.
  const g2 = createStartGate();
  g2.lease('ui2');
  assert.equal(await g2.hold('x', 50), false);
  assert.equal(g2.lease('ui2').ok, true);
  // A UI server that goes away gives its leases back.
  const g3 = createStartGate();
  g3.lease('gone');
  const h3 = g3.hold('x', 2000);
  g3.releaseOwner('gone');
  assert.equal(await h3, true);
});

test('P1-1 maintenance lock: the UI server sends no stream or recording start while the launcher holds the gate (IPC lease)', async () => {
  // The launcher side and the UI server side of the authority channel, wired like IPC.
  const child = new EventEmitter(); child.connected = true;
  const ui = new EventEmitter(); ui.connected = true;
  child.send = (m) => { setImmediate(() => ui.emit('message', m)); };
  ui.send = (m) => { setImmediate(() => child.emit('message', m)); };
  ui.disconnect = () => {};
  const gate = createStartGate();
  serveAuthority(child, createLiveAuthority(), { gate });
  const client = authorityClient({ proc: ui, timeoutMs: 1000 });
  const sent = [];
  const host = { describe: () => ({ kind: 'fake' }), call: async (m) => { sent.push(m); return { ok: true }; } };
  const gated = gateStarts(host, () => client);
  await gated.call('stream.start', {});
  assert.deepEqual(sent, ['stream.start']);
  assert.equal(gate.state().inFlight, 0, 'the lease is given back after the host answered');
  assert.equal(await gate.hold('the video engine (host) is being updated'), true);
  await assert.rejects(gated.call('record.start', {}), (e) => e.code === 'HOST_UPDATING');
  await assert.rejects(gated.call('stream.start', {}), (e) => e.code === 'HOST_UPDATING');
  assert.deepEqual(sent, ['stream.start'], 'nothing reached the host while held');
  await gated.call('stream.stop', {});
  await gated.call('scenes.list', {});
  assert.deepEqual(sent, ['stream.start', 'stream.stop', 'scenes.list'], 'stops and reads are never held');
  gate.end();
  await gated.call('record.start', {});
  assert.equal(sent.at(-1), 'record.start');
  assert.equal(gated.describe().kind, 'fake');
  // A launcher that does not answer: the start is refused (fail closed).
  const mute = new EventEmitter(); mute.connected = true; mute.send = () => {}; mute.disconnect = () => {};
  const silent = authorityClient({ proc: mute, timeoutMs: 50 });
  await assert.rejects(gateStarts(host, () => silent).call('stream.start', {}), (e) => e.code === 'HOST_UPDATING');
  // Started by hand or a test seam without a lease: unchanged.
  await gateStarts(host, () => null).call('stream.start', {});
  await gateStarts(host, () => ({ begin: async () => 0 })).call('stream.start', {});
});

test('P1-2 integrity: release metadata is required, the whole host part is hashed, the update runs from a checked private copy', async () => {
  const q = queue();
  for (const [name, opt, re] of [['noexe', { omit: ['hostExeSha256'] }, /no host exe hash/], ['noparts', { omit: ['parts'] }, /no host hash/], ['non', { omit: ['n'] }, /release number/]]) {
    assert.match((await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), name), opt) })).reason, re, name);
  }
  // A non-exe file of the host part (an OBS DLL, the overlay child) changed after release.json was written.
  const dll = stagedRelease(path.join(tmp(), 'dll'));
  mkdirSync(path.join(dll, 'obs', 'bin'), { recursive: true });
  writeFileSync(path.join(dll, 'obs', 'bin', 'obs.dll'), 'not in the hash');
  assert.match((await q.u.request({ service: 'host', root: dll })).reason, /host files do not match/);
  const ov = stagedRelease(path.join(tmp(), 'ov'));
  mkdirSync(path.join(ov, 'app', 'host', 'overlay'), { recursive: true });
  writeFileSync(path.join(ov, 'app', 'host', 'overlay', 'child.mjs'), 'added later');
  assert.match((await q.u.request({ service: 'host', root: ov })).reason, /host files do not match/);
  // Services: release.json and its part hashes are required too.
  assert.match((await q.u.request({ service: 'event-core', root: serviceRelease(path.join(tmp(), 's1'), { omit: ['parts'] }) })).reason, /no services hash/);
  const s2 = serviceRelease(path.join(tmp(), 's2'));
  rmSync(path.join(s2, 'release.json'));
  assert.match((await q.u.request({ service: 'event-core', root: s2 })).reason, /no readable release\.json/);
  const s3 = serviceRelease(path.join(tmp(), 's3'));
  writeFileSync(path.join(s3, 'services', 'event-core', 'cli.mjs'), 'changed');
  assert.match((await q.u.request({ service: 'event-core', root: s3 })).reason, /services files do not match/);
  assert.deepEqual(q.calls, []);
  // The offered folder changes after the check: the copy runs, unchanged.
  const rel = stagedRelease(path.join(tmp(), 'rel'), { n: 70 });
  assert.equal((await q.u.request({ service: 'host', root: rel })).result, 'staged');
  writeFileSync(path.join(rel, 'bin', 'ujwalam-host.mjs'), 'process.exit(9);\n');
  q.st.busy = false;
  assert.ok(await until(() => q.calls.length === 1));
  await q.u.tick();
  assert.equal(q.stage().good.n, 70);
  assert.equal(readFileSync(path.join(q.stage().good.root, 'bin', 'ujwalam-host.mjs'), 'utf8'), readFileSync(FAKE_HOST, 'utf8'));
  // The copy itself changed before it runs: checked right before the restart, rejected, never started.
  const q2 = queue();
  assert.equal((await q2.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'r2'), { n: 71 }) })).result, 'staged');
  const copied = path.join(q2.stage().pending.root, 'bin', 'ujwalam-host.mjs');
  assert.throws(() => appendFileSync(copied, '\n// x\n'), /EPERM|EACCES/, 'the copied files are read-only (Codex re-review)');
  chmodSync(copied, 0o666); // a writer with the user's rights (out of scope for read-only, D343): the hash still catches it
  appendFileSync(copied, '\n// tampered\n');
  q2.st.busy = false;
  assert.ok(await until(() => q2.mirror().waiting.length === 0));
  assert.deepEqual(q2.calls, [], 'the host was not restarted');
  assert.deepEqual([q2.stage().pending, q2.stage().rejected.map((x) => x.n)], [null, [71]]);
  assert.match(q2.mirror().recent[0].text, /0\.1\.0-alpha\.71 not applied \(failed: the host exe does not match/);
});

test('P1-3 startup records: a rejected release is never a candidate again; a failed pending falls back to the last good', () => {
  const dataDir = tmp();
  const good = hostEntry(stagedRelease(path.join(tmp(), 'good'), { n: 80 }), { script: true });
  const bad = hostEntry(stagedRelease(path.join(tmp(), 'bad'), { n: 81, broken: true }), { script: true });
  acceptHost(dataDir, good);
  writeFileSync(path.join(dataDir, 'live', HOST_STAGE_FILE), JSON.stringify({ ...JSON.parse(readFileSync(path.join(dataDir, 'live', HOST_STAGE_FILE), 'utf8')), pending: { root: bad.root, version: bad.version, n: bad.n, sha256: bad.sha256, files: bad.files } }));
  const t = takeStartupHost({ dataDir, own: null, script: true });
  assert.deepEqual(t.candidates.map((c) => [c.kind, c.entry.n]), [['pending', 81], ['good', 80]], 'pending first, then the last good');
  // The launcher's trial of 81 failed (readiness or project load).
  rejectHost(dataDir, bad, 'the host did not get ready');
  const st = readHostStage(dataDir);
  assert.deepEqual([st.pending, st.good.n, st.rejected.map((x) => x.n)], [null, 80, [81]]);
  assert.deepEqual(takeStartupHost({ dataDir, own: null, script: true }).candidates.map((c) => c.entry.n), [80]);
  // Offered again (same release): never tried again.
  writeFileSync(path.join(dataDir, 'live', HOST_STAGE_FILE), JSON.stringify({ ...JSON.parse(readFileSync(path.join(dataDir, 'live', HOST_STAGE_FILE), 'utf8')), pending: { root: bad.root, version: bad.version, n: bad.n, sha256: bad.sha256, files: bad.files } }));
  const t2 = takeStartupHost({ dataDir, own: null, script: true });
  assert.deepEqual([t2.candidates.map((c) => c.entry.n), t2.dropped], [[80], ['0.1.0-alpha.81: it failed before']]);
  // A last good whose files changed is dropped with the reason.
  appendFileSync(path.join(good.root, 'bin', 'ujwalam-host.mjs'), '\n// changed\n');
  assert.match(takeStartupHost({ dataDir, own: null, script: true }).dropped[0], /0\.1\.0-alpha\.80: the host exe does not match/);
});

test('P2-4 stale and superseded: an older waiting update never runs after a newer one; not-newer releases are refused', async () => {
  const q = queue();
  const a = stagedRelease(path.join(tmp(), 'a'), { n: 90 });
  const b = stagedRelease(path.join(tmp(), 'b'), { n: 91 });
  assert.equal((await q.u.request({ service: 'host', root: a })).result, 'staged');
  // The stop came, and B is offered before the poll ran: B applies at once and A is dropped first.
  q.st.busy = false;
  const ab = q.u.request({ service: 'host', root: b });
  assert.equal((await ab).result, 'swapped');
  await new Promise((r) => setTimeout(r, 100));
  await q.u.tick();
  assert.deepEqual(q.calls.map((c) => c[1]).filter((v) => v === '0.1.0-alpha.90'), [], 'A never applied after B');
  assert.equal(q.mirror().parts.find((p) => p.part === 'host').version, '0.1.0-alpha.91');
  // Not newer than the running host, or than a waiting one: refused.
  assert.match((await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'old'), { n: 91, version: '0.1.0-alpha.91b', broken: true }) })).reason, /not newer than the running host/);
  q.st.busy = true;
  assert.equal((await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'c'), { n: 95 }) })).result, 'staged');
  assert.match((await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'd'), { n: 93 }) })).reason, /release 95 of the Video engine \(host\) already waits/);
  // Services too.
  assert.equal((await q.u.request({ service: 'event-core', root: serviceRelease(path.join(tmp(), 's7'), { n: 7 }) })).result, 'waiting');
  assert.match((await q.u.request({ service: 'event-core', root: serviceRelease(path.join(tmp(), 's6'), { n: 6 }) })).reason, /already waits/);
  assert.equal((await q.u.request({ service: 'event-core', root: serviceRelease(path.join(tmp(), 's8'), { n: 8 }) })).result, 'waiting');
  assert.deepEqual(q.mirror().waiting.map((w) => [w.part, w.version]), [['host', '0.1.0-alpha.95'], ['event-core', '0.1.0-alpha.8']]);
});

test('P2-6 confirmed exit: stopHostChild reports a host that does not exit; it returns true only after the exit', async () => {
  const stuck = new EventEmitter(); stuck.exitCode = null; stuck.signalCode = null; stuck.kill = () => {};
  const asked = [];
  assert.equal(await stopHostChild({ call: async (m) => { asked.push(m); } }, stuck, { askMs: 10, exitMs: 20, killMs: 30 }), false);
  assert.deepEqual(asked, ['host.shutdown']);
  const quits = new EventEmitter(); quits.exitCode = null; quits.signalCode = null;
  const p = stopHostChild({ call: async () => { setTimeout(() => { quits.exitCode = 0; quits.emit('exit', 0); }, 20); } }, quits, { askMs: 10, exitMs: 2000, killMs: 30 });
  assert.equal(await p, true);
  assert.equal(await stopHostChild(null, { exitCode: 3, signalCode: null }), true, 'already gone');
});

test('Codex re-review B: an aborted replacement (the old host did not exit) keeps the candidate pending and retries it; only its own failure rejects it', async () => {
  const answers = [{ result: 'failed', reason: 'the running host did not exit; nothing was replaced' }, { result: 'swapped' }];
  const calls = [];
  const q = queue({ applyHost: async (entry) => { calls.push(entry.n); return answers.shift(); } });
  assert.equal((await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'b1'), { n: 60 }) })).result, 'staged');
  q.st.busy = false;
  assert.ok(await until(() => calls.length === 2), 'tried again at the next poll');
  assert.ok(await until(() => q.stage().good?.n === 60));
  assert.deepEqual([q.stage().pending, q.stage().rejected], [null, []], 'never rejected for an abort');
  assert.ok(q.mirror().recent.some((r) => /kept, tried again/.test(r.text)));
  // The candidate's own failure (readiness, project load, hash before the start) rejects it.
  const q2 = queue({ hostResult: { result: 'restored-old', reason: 'the host did not get ready', candidateFailed: true } });
  q2.st.busy = false;
  assert.equal((await q2.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'b2'), { n: 61 }) })).result, 'restored-old');
  assert.deepEqual([q2.stage().pending, q2.stage().rejected.map((x) => x.n)], [null, [61]]);
  // An abort on an immediate apply (nothing live) also keeps it pending for a retry instead of a rejection.
  const q3 = queue({ hostResult: { result: 'failed', reason: 'the running host did not exit' } });
  q3.st.busy = false;
  const r3 = await q3.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'b3'), { n: 62 }) });
  assert.equal(r3.retry, true);
  assert.equal(q3.stage().pending.n, 62);
  assert.deepEqual(q3.stage().rejected, []);
  q3.u.close();
});

test('Codex re-review C: one release.json snapshot: the copy carries it, and the freshness and unchanged checks use the prepared entry', async () => {
  const q = queue();
  const src = stagedRelease(path.join(tmp(), 'c1'), { n: 64 });
  assert.equal((await q.u.request({ service: 'host', root: src })).result, 'staged');
  const pend = q.stage().pending;
  // The offered release.json changes after the request: the copy keeps the snapshot the checks used.
  writeFileSync(path.join(src, 'release.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(src, 'release.json'), 'utf8')), n: 3, version: '0.1.0-alpha.3' }));
  const copyRel = JSON.parse(readFileSync(path.join(pend.root, 'release.json'), 'utf8'));
  assert.deepEqual([copyRel.n, copyRel.version, pend.n], [64, '0.1.0-alpha.64', 64]);
  assert.equal(copyRel.parts.host.sha256, pend.sha256);
  // The same folder offered again (its release.json now says n 3): refused on the prepared entry's n.
  assert.match((await q.u.request({ service: 'host', root: src })).reason, /release 3 is not newer than the running host|already waits/);
  // Unchanged: the running host's part hash is compared with the prepared copy's.
  q.st.busy = false;
  assert.ok(await until(() => q.stage().good?.n === 64));
  const again = stagedRelease(path.join(tmp(), 'c2'), { n: 65, version: '0.1.0-alpha.64' }); // same host bytes as 64
  assert.equal((await q.u.request({ service: 'host', root: again })).result, 'unchanged');
});

test('Codex re-review A: a lease grant that arrives after its request timed out is given back; a lost release is sent again; hold() then succeeds', async () => {
  const child = new EventEmitter(); child.connected = true;
  const ui = new EventEmitter(); ui.connected = true;
  let delayLease = 150; let dropRelease = 1;
  child.send = (m) => { const late = m.ok === true && Number.isInteger(m.lease) && delayLease ? delayLease : 0; delayLease = 0; setTimeout(() => ui.emit('message', m), late); };
  ui.send = (m) => { if (m.op === 'release' && dropRelease > 0) { dropRelease -= 1; return; } setImmediate(() => child.emit('message', m)); };
  ui.disconnect = () => {};
  const gate = createStartGate();
  serveAuthority(child, createLiveAuthority(), { gate });
  const client = authorityClient({ proc: ui, timeoutMs: 50, retryMs: 20 });
  // The grant comes after the request gave up: the start is refused, and the orphan lease is released.
  assert.deepEqual(await client.lease(), { ok: false, reason: 'the launcher did not answer' });
  assert.equal(gate.state().inFlight, 1, 'granted on the launcher side');
  assert.ok(await until(() => gate.state().inFlight === 0), 'the late grant was given back');
  assert.equal(await gate.hold('the video engine (host) is being updated', 500), true, 'host updates are not blocked');
  gate.end();
  // A release whose message is lost (no answer) is retried while the link is up.
  dropRelease = 1;
  const l = await client.lease();
  assert.equal(l.ok, true);
  await client.release(l.lease);
  assert.ok(await until(() => gate.state().inFlight === 0), 'the release was sent again');
  assert.equal(await gate.hold('x', 500), true);
  gate.end();
  // An active lease is never expired on its own.
  const held = await client.lease();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(gate.state().inFlight, 1);
  await client.release(held.lease);
  assert.equal(gate.state().inFlight, 0);
});

/** A staged studio window release (LU4, D346): studio/ujwalam-studio.exe (a stand-in file) and release.json. */
function studioRelease(root, { n = 99, version = `0.1.0-alpha.${n}` } = {}) {
  mkdirSync(path.join(root, 'studio'), { recursive: true });
  writeFileSync(path.join(root, 'studio', 'ujwalam-studio.exe'), `stand-in studio ${n}\n`);
  writeFileSync(path.join(root, 'release.json'), JSON.stringify({ version, n, parts: partsOf(root) }));
  return root;
}

test('LU4 + LU7: a studio window update while live waits for one click and runs from a checked copy; never during a host replacement', async () => {
  let hostDone;
  const order = [];
  const q = queue({
    applyHost: async (entry) => { order.push(`host ${entry.n} start`); await new Promise((r) => { hostDone = r; }); order.push(`host ${entry.n} end`); return { result: 'swapped' }; },
    swapService: async (service, root) => { order.push(`${service} ${path.basename(root)}`); return { result: 'swapped', history: [] }; },
  });
  const w = await q.u.request({ service: 'studio', root: studioRelease(path.join(tmp(), 'st'), { n: 10 }) });
  assert.equal(w.result, 'waiting');
  assert.deepEqual(q.mirror().waiting.map((x) => [x.part, x.click]), [['studio-window', true]]);
  assert.match((await q.u.request({ service: 'studio', root: serviceRelease(path.join(tmp(), 'nost')) })).reason, /entry file/);
  // A host update is staged; at the stop the host replacement runs; the studio click waits for it to finish.
  assert.equal((await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'h'), { n: 20 }) })).result, 'staged');
  q.st.busy = false;
  assert.ok(await until(() => order.includes('host 20 start')));
  const click = q.u.apply(w.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, ['host 20 start'], 'the studio swap does not start during the host replacement');
  hostDone();
  const r = await click;
  assert.equal(r.result, 'swapped');
  assert.deepEqual(order.slice(0, 2), ['host 20 start', 'host 20 end']);
  assert.match(order[2], /^studio-window studio-10-[0-9a-f]{16}$/, 'the studio window runs from its checked copy');
  assert.equal(q.mirror().parts.find((p) => p.part === 'studio-window').version, '0.1.0-alpha.10');
  assert.match((await q.u.request({ service: 'studio', root: studioRelease(path.join(tmp(), 'old'), { n: 9 }) })).reason, /not newer than the running Studio window/);
  q.u.close();
});

test('LU4 + LU5: serveSwaps sends a studio request through the queue with the entry check; one request at a time; timings in the answer', async () => {
  const p = new EventEmitter(); p.sent = []; p.connected = true; p.send = (m) => p.sent.push(m);
  let release;
  const asked = [];
  const updates = { request: ({ service, root }) => { asked.push([service, root]); return new Promise((r) => { release = () => r({ result: 'swapped', ms: 3, history: [{ action: 'check-new', ok: true, value: { readyMs: 7 } }] }); }); } };
  const stage = studioRelease(path.join(tmp(), 'sw'), { n: 4 });
  serveSwaps({ slots: { studio: {}, 'event-core': {} }, log: () => {}, proc: p, updates, entryOk: (s, root) => root === stage });
  p.emit('message', { t: 'ujwalam-swap', id: 1, service: 'studio', root: stage });
  await settle();
  p.emit('message', { t: 'ujwalam-swap', id: 2, service: 'event-core', root: stage });
  p.emit('message', { t: 'ujwalam-swap', id: 3, service: 'studio', root: tmp() });
  await settle();
  assert.deepEqual(p.sent.map((m) => [m.id, m.result]), [[2, 'refused'], [3, 'refused']]);
  assert.match(p.sent[0].reason, /one at a time/);
  release();
  await settle();
  assert.deepEqual(asked, [['studio', stage]]);
  assert.deepEqual([p.sent[2].id, p.sent[2].result, p.sent[2].studio], [1, 'swapped', { readyMs: 7 }]);
  // Not the entry the studio slot can start: refused before the queue.
  p.emit('message', { t: 'ujwalam-swap', id: 4, service: 'studio', root: tmp() });
  await settle();
  assert.match(p.sent.at(-1).reason, /entry file/);
  assert.equal(asked.length, 1);
});

test('Codex review of the merge: an exception from the host replacement is a failure, not a crash of the queue; versions stay with the running host', async () => {
  const q = queue({ applyHost: async () => { throw new Error('EBUSY: resource busy or locked'); } });
  q.st.busy = false;
  const r = await q.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'x1'), { n: 66 }) });
  assert.deepEqual([r.result, r.running, r.retry], ['failed', 'unknown', true]);
  assert.equal(q.mirror().parts.find((p) => p.part === 'host').version, 'dev');
  assert.equal(q.stage().pending.n, 66, 'kept: nothing shows the candidate itself failed');
  q.u.close();
  // A 'swapped' answer that says the old host still runs does not move the version.
  const q2 = queue({ hostResult: { result: 'swapped', running: 'old' } });
  q2.st.busy = false;
  await q2.u.request({ service: 'host', root: stagedRelease(path.join(tmp(), 'x2'), { n: 67 }) });
  assert.equal(q2.mirror().parts.find((p) => p.part === 'host').version, 'dev');
  q2.u.close();
});
