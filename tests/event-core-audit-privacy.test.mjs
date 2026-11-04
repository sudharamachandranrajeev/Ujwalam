// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/audit: raw chat never leaves chat_raw. Backups, exports and the audit module's own output hold
// no raw text; createEventCore wiring; the audit tables hold ids only. SYNTHETIC chat; the marker strings are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventCore } from '../services/event-core/index.mjs';
import { backupAudit, isInside, openStore, DB_NAME } from '../services/event-core/audit/store.mjs';
import { createAudit } from '../services/event-core/audit/index.mjs';
import { auditCommand } from '../services/event-core/audit/cli.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evaudpriv-')); dirs.push(d); return d; };
const KEY = Buffer.alloc(32, 7);
const BL = { policy: { echoWindowSec: 120, replyMaxChars: 120 }, dropMessage: ['\\bscamword\\b'], dropUser: [], rejectReply: [] };
const LIMITS = { twitch: { replyMaxChars: 500, unverified: false }, local: { replyMaxChars: null, unverified: false } };
const MARK = 'ZQXJ-PRIVACY-MARKER-4821';
const NAME = 'ZQXJNameMarker4821';
const chat = (text, i, name = NAME) => ({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: `m${i}`, user: { platformUserId: `u${i % 5}`, displayName: name, roles: ['viewer'] }, text });
const filesWith = (dir, marker) => readdirSync(dir).filter((f) => readFileSync(path.join(dir, f)).includes(Buffer.from(marker))); // every file in dir
const mkCore = (dataDir, extra = {}) => createEventCore({ key: KEY, moderation: { blocklist: BL, limits: LIMITS }, audit: { dataDir, mode: 'inline', purgeOnStart: false, batchMs: 5 }, ...extra });

async function populated() {
  const dir = tmp();
  const core = mkCore(dir);
  await core.audit.ready;
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(core.ingest(chat(`${MARK} hello ${i}`, i)).event.id);
  core.ingest(chat(`scamword ${MARK} dropped`, 99)); // moderation drop
  core.ingest({ kind: 'alert.sub', platform: 'twitch', source: 'mock', platformMessageId: 'a1', user: { platformUserId: 'u1', displayName: NAME }, tier: '1000', message: `${MARK} alert message` });
  core.ingest({ kind: 'system.connected', platform: 'local', source: 'system', target: 'streamerbot' });
  core.actions.request({ id: 'effect.fire', params: { fx: 'x' }, source: 'chat', actor: core.pseudoId('twitch', 'u1'), provenance: { kind: 'chat.message', eventId: ids[1] } });
  core.actions.request({ id: 'state.read', source: 'ui' });
  core.actions.panic({ source: 'ui' });
  await core.audit.flush();
  return { dir, core };
}

test('wiring: no audit option leaves core.audit null and ingest unchanged', () => {
  const core = createEventCore({ key: KEY, moderation: { blocklist: BL, limits: LIMITS } });
  assert.equal(core.audit, null);
  assert.equal(core.ingest(chat('hello', 1)).status, 'published');
  assert.equal(core.ingest(chat('scamword', 2)).status, 'dropped');
});

test('wiring: moderation verdicts, gate decisions, system events and chat text each land where they belong', async () => {
  const { dir, core } = await populated();
  const rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  const types = rd.db.prepare('SELECT type, subtype, COUNT(*) AS n FROM audit GROUP BY type, subtype ORDER BY type, subtype').all().map((r) => `${r.type}/${r.subtype}:${r.n}`);
  assert.ok(types.includes('moderation/chat.message:1'), types.join());
  assert.ok(types.includes('system/system.connected:1'), types.join());
  assert.ok(types.some((t) => t.startsWith('system/system.panic')), types.join()); // the emitted event
  assert.ok(types.some((t) => t.startsWith('decision/request:')), types.join());
  assert.ok(types.some((t) => t.startsWith('decision/panic:')), types.join());
  const mod = rd.db.prepare("SELECT * FROM audit WHERE type = 'moderation'").get();
  assert.equal(mod.verdict, 'drop');
  assert.equal(mod.reason, 'blocked');
  assert.match(mod.pseudo_id, /^[0-9a-f]{32}$/);
  assert.match(mod.rule_id, /^[0-9,]+$/); // pattern indexes, not text
  // chat-triggered decision: pseudonymous user id, the action, the result
  const dec = rd.db.prepare("SELECT * FROM audit WHERE type = 'decision' AND action_id = 'effect.fire'").get();
  assert.equal(dec.pseudo_id, core.pseudoId('twitch', 'u1'));
  assert.equal(dec.source, 'chat');
  assert.equal(dec.verdict, 'refuse');
  assert.match(dec.event_id, /^e[0-9a-f]{12}-/);
  // raw: 20 published chats + 1 dropped + 1 alert message
  assert.equal(rd.db.prepare('SELECT COUNT(*) AS n FROM chat_raw').get().n, 22);
  assert.equal(rd.db.prepare("SELECT COUNT(*) AS n FROM chat_raw WHERE text LIKE ?").get(`%${MARK}%`).n, 22);
  assert.equal(rd.verify().ok, true);
  rd.close();
  await core.audit.close();
});

test('audit tables hold no raw text and no display name; only chat_raw does', async () => {
  const { dir, core } = await populated();
  await core.audit.close();
  const rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  const auditText = JSON.stringify(rd.db.prepare('SELECT * FROM audit').all());
  assert.ok(!auditText.includes(MARK));
  assert.ok(!auditText.includes(NAME));
  assert.ok(rd.stats().rawRows > 0);
  rd.close();
});

test('a free-text field that reaches the audit is replaced, never stored', async () => {
  const dir = tmp();
  const a = createAudit({ dataDir: dir, mode: 'inline', purgeOnStart: false });
  await a.ready;
  const SAY = `${MARK} this is chat`; // a sentence: it has spaces, so no token pattern accepts it
  a.recordSystem({ subtype: 'x', reason: SAY, detail: { note: SAY, ok: 1 } });
  a.recordDecision({ type: 'request', actionId: SAY, source: 'rule', actor: `${SAY} actor`, provenance: { eventIds: ['not-an-id'], kinds: [SAY] }, verdict: 'allow', reason: SAY, ts: new Date().toISOString() });
  await a.close();
  const rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  const all = JSON.stringify(rd.db.prepare('SELECT * FROM audit').all());
  assert.ok(!all.includes(MARK));
  assert.ok(all.includes('(redacted)'));
  rd.close();
});

test('backup: marker is in the live database, planted in chat, and in zero bytes of the backup', async () => {
  const { dir, core } = await populated();
  await core.audit.close();
  // present in the live database before any purge
  assert.ok(filesWith(dir, MARK).includes(DB_NAME) || filesWith(dir, MARK).includes(`${DB_NAME}-wal`), 'marker is in the live db files');
  const dest = path.join(tmp(), 'backup.db');
  const r = backupAudit(path.join(dir, DB_NAME), dest);
  assert.ok(r.rows > 0);
  assert.equal(r.verify.ok, true);
  const dd = path.dirname(dest);
  assert.deepEqual(filesWith(dd, MARK), [], 'no byte of the backup holds the chat text');
  assert.deepEqual(filesWith(dd, NAME), [], 'nor the display name');
  assert.deepEqual(readdirSync(dd), ['backup.db'], 'one self-contained file, no leftovers');
  const bk = openStore({ file: dest, readOnly: true });
  assert.equal(bk.stats().rawRows, 0);
  const v = bk.verify();
  assert.equal(v.ok, true);
  bk.close();
  const src = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  assert.equal(v.rows, src.verify().rows);
  src.close();
});

test('backup is refused inside the repo, onto an existing file, and from a non-audit database', async () => {
  const { dir, core } = await populated();
  await core.audit.close();
  const src = path.join(dir, DB_NAME);
  assert.throws(() => backupAudit(src, path.join(repo, 'out', 'x.db')), (e) => e.code === 'DEST_IN_REPO');
  assert.throws(() => backupAudit(src, path.join(repo, 'x.db')), (e) => e.code === 'DEST_IN_REPO');
  assert.ok(!existsSync(path.join(repo, 'x.db')));
  const exists = path.join(tmp(), 'b.db');
  backupAudit(src, exists);
  assert.throws(() => backupAudit(src, exists), (e) => e.code === 'DEST_EXISTS');
  assert.ok(isInside(path.join(repo, 'a', 'b'), repo));
  assert.ok(!isInside(os.tmpdir(), repo));
});

test('export jsonl: audit rows only, zero marker bytes, to stdout and to a file', async () => {
  const { dir, core } = await populated();
  await core.audit.close();
  const lines = [];
  assert.equal(await auditCommand({ _: ['audit', 'export'], format: 'jsonl', 'data-dir': dir }, { out: (l) => lines.push(l) }), 0);
  assert.ok(lines.length > 5);
  const joined = lines.join('\n');
  assert.ok(!joined.includes(MARK));
  assert.ok(!joined.includes(NAME));
  assert.ok(!joined.includes('chat_raw'));
  for (const l of lines) { const o = JSON.parse(l); assert.ok('hash' in o && 'prev_hash' in o); assert.ok(!('text' in o) && !('display_name' in o)); }
  // a file destination
  const out = path.join(tmp(), 'audit.jsonl');
  const msgs = [];
  assert.equal(await auditCommand({ _: ['audit', 'export'], format: 'jsonl', out, 'data-dir': dir }, { out: (l) => msgs.push(l) }), 0);
  assert.match(msgs[0], /wrote \d+ audit rows \(no raw chat\)/);
  assert.ok(!readFileSync(out).includes(Buffer.from(MARK)));
  assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, lines.length);
  // refusals
  assert.equal(await auditCommand({ _: ['audit', 'export'], format: 'jsonl', out, 'data-dir': dir }, { out: () => {} }), 1); // exists
  assert.equal(await auditCommand({ _: ['audit', 'export'], format: 'jsonl', out: path.join(repo, 'x.jsonl'), 'data-dir': dir }, { out: () => {} }), 1); // in repo
  assert.equal(await auditCommand({ _: ['audit', 'export'], format: 'csv', 'data-dir': dir }, { out: () => {} }), 1);
  assert.ok(!existsSync(path.join(repo, 'x.jsonl')));
});

test('cli backup and export through the real command line, while the core is still running', async () => {
  const { dir, core } = await populated(); // core keeps the lock: readers must still work
  const cli = path.join(repo, 'services', 'event-core', 'cli.mjs');
  const dest = path.join(tmp(), 'live-backup.db');
  const b = spawnSync(process.execPath, [cli, 'audit', 'backup', dest, '--data-dir', dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.ok(!b.stdout.includes(MARK) && !b.stderr.includes(MARK));
  assert.deepEqual(filesWith(path.dirname(dest), MARK), []);
  const e = spawnSync(process.execPath, [cli, 'audit', 'export', '--format', 'jsonl', '--data-dir', dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(e.status, 0, e.stderr);
  assert.ok(!e.stdout.includes(MARK) && !e.stdout.includes(NAME));
  const v = spawnSync(process.execPath, [cli, 'audit', 'verify', '--data-dir', dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  await core.audit.close();
});

test('log capture: console and process output of the audit workflow never include raw text or names', async () => {
  const captured = [];
  const wrap = (obj, key) => { const orig = obj[key]; obj[key] = (...a) => { captured.push(a.map(String).join(' ')); return true; }; return () => { obj[key] = orig; }; };
  const restores = [wrap(console, 'log'), wrap(console, 'warn'), wrap(console, 'error'), wrap(console, 'info'), wrap(console, 'debug')]; // process.stdout is left alone: the test runner reports through it
  const notes = [];
  try {
    const dir = tmp();
    const core = mkCore(dir, {});
    await core.audit.ready;
    for (let i = 0; i < 30; i++) core.ingest(chat(`${MARK} ${i}`, i));
    core.ingest(chat(`scamword ${MARK}`, 77));
    await core.audit.flush();
    await core.audit.verify();
    await core.audit.purge({ olderThanDays: 0, now: Date.now() + 1000 });
    await core.audit.close();
    // a failing writer (second owner, then a broken data dir) must report codes only
    const dir2 = tmp();
    const a = createAudit({ dataDir: dir2, mode: 'inline', purgeOnStart: false, onNote: (l, c) => notes.push(`${l}:${c}`) });
    await a.ready;
    assert.throws(() => createAudit({ dataDir: dir2, mode: 'inline' }));
    a.observe(chat(`${MARK} before close`, 5));
    await a.close();
    // the CLI paths
    const sink = [];
    for (const sub of ['verify', 'purge', 'export']) await auditCommand({ _: ['audit', sub], format: 'jsonl', 'data-dir': dir }, { out: (l) => sink.push(l) });
    captured.push(...sink);
  } finally { restores.forEach((r) => r()); }
  const all = captured.join('\n') + notes.join('\n');
  assert.ok(!all.includes(MARK), 'no raw chat text in any output');
  assert.ok(!all.includes(NAME), 'no display name in any output');
});

test('the default note handler prints a code only', async () => {
  const dir = tmp();
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    // a database from a newer schema makes the writer fail to open
    const s = openStore({ file: path.join(dir, DB_NAME) });
    s.db.exec("INSERT INTO schema_version (version, name, applied_at) VALUES (99, 'future', 'x')");
    s.close();
    const a = createAudit({ dataDir: dir, mode: 'inline' });
    await a.ready;
    a.observe(chat(`${MARK} text`, 1));
    await a.flush();
    await a.close();
  } finally { console.warn = orig; }
  assert.ok(lines.length >= 1);
  assert.ok(lines.every((l) => /^\[audit\] error: [a-z-]+(:[A-Z_]+)?$/.test(l)), lines.join('|'));
  assert.ok(!lines.join('').includes(MARK));
});
