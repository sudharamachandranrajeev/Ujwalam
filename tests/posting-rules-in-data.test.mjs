// SPDX-License-Identifier: GPL-3.0-or-later
// The user's auto-post rules live in the data dir (<dataDir>/posting/auto-post-rules.json); the shipped file is the template.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RULES, initUserRules, loadRules, rulesFileFor, userRulesFile } from '../services/posting/auto-post.mjs';
import { createPostChain } from '../services/posting/auto-chain.mjs';
import { main } from '../services/posting/cli.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-rid-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const RULE = { id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 2 };
const put = (dataDir, text) => { const f = userRulesFile(dataDir); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };

describe('rulesFileFor', () => {
  test('template when no user file; user file when present; explicit wins', () => {
    const d = mk();
    assert.equal(rulesFileFor(d), DEFAULT_RULES);
    assert.equal(rulesFileFor(undefined), DEFAULT_RULES);
    const u = put(d, JSON.stringify({ autoUpload: false, rules: [RULE] }));
    assert.equal(rulesFileFor(d), u);
    assert.equal(loadRules(rulesFileFor(d)).rules.length, 1);
    assert.equal(rulesFileFor(d, '/x/other.json'), '/x/other.json');
  });
  test('an invalid user file is still the one used, so it fails closed (no silent fallback)', () => {
    const d = mk(); const u = put(d, '{ not json');
    assert.equal(rulesFileFor(d), u);
    assert.throws(() => loadRules(rulesFileFor(d)), { code: 'bad-rules' });
    put(d, JSON.stringify({ rules: [{ ...RULE, maxPerDay: 101 }] }));
    assert.throws(() => loadRules(rulesFileFor(d)), { code: 'bad-rules' });
  });
});

describe('cli auto', () => {
  const run = async (argv, deps = {}) => { const o = []; const e = []; const code = await main(argv, (s) => o.push(s), (s) => e.push(s), deps); return { code, out: o.join('\n'), err: e.join('\n') }; };
  test('--init-rules creates from the template once, never overwrites, says where', async () => {
    const d = mk(); const u = userRulesFile(d);
    const a = await run(['auto', '--init-rules', '--data-dir', d]);
    assert.equal(a.code, 0); assert.ok(a.out.includes(u)); assert.match(a.out, /created/);
    assert.equal(readFileSync(u, 'utf8'), readFileSync(DEFAULT_RULES, 'utf8'));
    writeFileSync(u, JSON.stringify({ autoUpload: false, rules: [RULE] }));
    const b = await run(['auto', '--init-rules', '--data-dir', d]);
    assert.equal(b.code, 0); assert.ok(b.out.includes(u)); assert.match(b.out, /already exists/);
    assert.equal(JSON.parse(readFileSync(u, 'utf8')).rules.length, 1, 'user file untouched');
    assert.equal(initUserRules(d).created, false);
  });
  test('dry run uses and prints the user file; template path when absent; explicit --rules wins', async () => {
    const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
    const t = await run(['auto', '--data-dir', d]);
    assert.equal(t.code, 0, t.err); assert.ok(t.out.includes(`rules file: ${DEFAULT_RULES}`)); assert.match(t.out, /0 rule/);
    const u = put(d, JSON.stringify({ autoUpload: false, rules: [RULE] }));
    const w = await run(['auto', '--data-dir', d]);
    assert.ok(w.out.includes(`rules file: ${u}`)); assert.match(w.out, /1 rule/);
    const ex = path.join(d, 'explicit.json'); writeFileSync(ex, JSON.stringify({ autoUpload: false, rules: [] }));
    const x = await run(['auto', '--data-dir', d, '--rules', ex]);
    assert.ok(x.out.includes(`rules file: ${ex}`)); assert.match(x.out, /0 rule/);
  });
  test('invalid user file: dry run and --preview fail closed', async () => {
    const d = mk(); put(d, '{ nope');
    const a = await run(['auto', '--data-dir', d]);
    assert.equal(a.code, 1); assert.match(a.err, /rules file/);
    const b = await run(['auto', '--preview', '--data-dir', d], { outputsStatus: async () => ({ sinks: [] }) });
    assert.equal(b.code, 1);
  });
  test('--preview prints the rules file path (text and json)', async () => {
    const d = mk(); const u = put(d, JSON.stringify({ autoUpload: false, rules: [RULE] }));
    const deps = { outputsStatus: async () => ({ sinks: [] }), now: () => new Date('2026-11-10T10:00:00Z') };
    const t = await run(['auto', '--preview', '--data-dir', d, '--profile', path.join(d, 'none.json')], deps);
    assert.equal(t.code, 0, t.err); assert.ok(t.out.includes(`rules file: ${u}`));
    const j = await run(['auto', '--preview', '--json', '--data-dir', d, '--profile', path.join(d, 'none.json')], deps);
    assert.equal(JSON.parse(j.out).rulesFile, u);
  });
});

describe('chain', () => {
  const mkChain = (dataDir, extra = {}) => createPostChain({ dataDir, flags: { isOn: () => true }, tickEveryMs: 0, log: () => {}, ...extra });
  const idle = { sinks: [] };
  test('reads the user file in the data dir; bad one fails closed; explicit rulesFile wins', async () => {
    const d = mk(); mkdirSync(path.join(d, 'clips', 'runs', 'r'), { recursive: true });
    const run = path.join(d, 'clips', 'runs', 'r');
    assert.equal((await mkChain(d).afterRun(run, idle)).skipped, 'no-rules', 'template: empty rules');
    put(d, '{ nope');
    assert.equal((await mkChain(d).afterRun(run, idle)).skipped, 'bad-rules', 'bad user file: closed, no fallback to the template');
    const ex = path.join(d, 'ex.json'); writeFileSync(ex, JSON.stringify({ autoUpload: false, rules: [] }));
    assert.equal((await mkChain(d, { rulesFile: ex }).afterRun(run, idle)).skipped, 'no-rules', 'explicit file wins over a bad user file');
  });
});

describe('studio routes', () => {
  const get = (port, url, cookie) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
      const c = []; res.on('data', (b) => c.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString() }));
    }).on('error', reject);
  });
  async function withServer(dataDir, extra, fn) {
    const KEY = 'k'.repeat(48);
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), limits: { statusPollMs: 50 }, youtube: { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, outputsStatus: async () => ({ sinks: [] }) }, ...extra });
    const { port } = await srv.listen();
    try {
      const lr = await get(port, `/login?k=${KEY}`);
      await fn((u) => get(port, u, lr.headers['set-cookie'][0].split(';')[0]));
    } finally { srv.close(); }
  }
  test('auto and auto/preview use the user file and report rulesFile; explicit wins; bad fails closed', async () => {
    const d = mk(); const u = put(d, JSON.stringify({ autoUpload: false, rules: [RULE] }));
    writeFileSync(path.join(d, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
    await withServer(d, {}, async (g) => {
      const a = JSON.parse((await g('/ui/api/posts/auto')).text);
      assert.equal(a.rulesFile, u); assert.equal(a.mode.ruleCount, 1);
      const p = JSON.parse((await g('/ui/api/posts/auto/preview')).text);
      assert.equal(p.rulesFile, u); assert.equal(p.mode.ruleCount, 1);
    });
    const ex = path.join(d, 'ex.json'); writeFileSync(ex, JSON.stringify({ autoUpload: false, rules: [] }));
    await withServer(d, { autoRulesFile: ex }, async (g) => {
      const a = JSON.parse((await g('/ui/api/posts/auto')).text);
      assert.equal(a.rulesFile, ex); assert.equal(a.mode.ruleCount, 0);
    });
    const d2 = mk(); writeFileSync(path.join(d2, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
    await withServer(d2, {}, async (g) => {
      const a = JSON.parse((await g('/ui/api/posts/auto')).text);
      assert.equal(a.rulesFile, DEFAULT_RULES, 'template when no user file');
    });
    put(d2, '{ nope');
    await withServer(d2, {}, async (g) => {
      assert.equal(JSON.parse((await g('/ui/api/posts/auto')).text).mode.error, 'rules-unreadable');
      assert.equal(JSON.parse((await g('/ui/api/posts/auto/preview')).text).error, 'preview-unavailable');
    });
  });
});
