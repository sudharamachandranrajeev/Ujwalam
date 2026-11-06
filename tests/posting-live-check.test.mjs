// SPDX-License-Identifier: GPL-3.0-or-later
// Posting live check (2026-11-06 stream-day mock run finding): `auto --run` and `youtube upload` must see the
// studio's host, whose discovery file is <event-core data dir>/host.json (services/studio-ui/launch.mjs), not only
// the standalone host's (app/host/lib/config.mjs). Before the fix, a live studio session read as "nothing live".
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { liveBlock } from '../services/posting/auto-post.mjs';
import { hostDiscoveryCandidates, main, outputsStatusFor } from '../services/posting/cli.mjs';

const mk = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-post-live-'));
const TOKEN = 'a'.repeat(64);
const noStandalone = (dir) => ({ discovery: path.join(dir, 'standalone', 'host.json') });

function fakeHost(sinks) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end('{}'); return; }
      const m = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'outputs.status' ? { sinks } : {} }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

describe('posting live check (studio discovery)', () => {
  test('candidates: the studio file first, then the standalone host file, no duplicates', () => {
    const d = mk();
    assert.deepEqual(hostDiscoveryCandidates(d, { discovery: path.join(d, 'x', 'host.json') }), [path.join(d, 'host.json'), path.join(d, 'x', 'host.json')]);
    assert.deepEqual(hostDiscoveryCandidates(d, { discovery: path.join(d, 'host.json') }), [path.join(d, 'host.json')]);
  });

  test('no discovery file anywhere: nothing is live', async () => {
    const d = mk();
    assert.equal(await liveBlock(outputsStatusFor(d, { hostCfg: noStandalone(d) })), null);
  });

  test('studio host running, its outputs live: refused (output-live)', async () => {
    const d = mk();
    const { srv, port } = await fakeHost([{ id: 'youtube-h', kind: 'stream', state: 'live' }]);
    try {
      writeFileSync(path.join(d, 'host.json'), JSON.stringify({ pid: process.pid, port, token: null }));
      assert.equal(await liveBlock(outputsStatusFor(d, { hostCfg: noStandalone(d), token: TOKEN })), 'output-live');
    } finally { srv.close(); }
  });

  test('studio host running, idle: allowed', async () => {
    const d = mk();
    const { srv, port } = await fakeHost([{ id: 'youtube-h', kind: 'stream', state: 'idle' }]);
    try {
      writeFileSync(path.join(d, 'host.json'), JSON.stringify({ pid: process.pid, port, token: null }));
      assert.equal(await liveBlock(outputsStatusFor(d, { hostCfg: noStandalone(d), token: TOKEN })), null);
    } finally { srv.close(); }
  });

  test('studio host running but no host token in this shell: refused (unreadable), never "nothing live"', async () => {
    const d = mk();
    writeFileSync(path.join(d, 'host.json'), JSON.stringify({ pid: process.pid, port: 9, token: null }));
    assert.equal(await liveBlock(outputsStatusFor(d, { hostCfg: noStandalone(d), token: '' })), 'output-state-unreadable');
  });

  test('stale discovery file (its pid is gone): skipped', async () => {
    const d = mk();
    writeFileSync(path.join(d, 'host.json'), JSON.stringify({ pid: 4242, port: 9, token: null }));
    assert.equal(await liveBlock(outputsStatusFor(d, { hostCfg: noStandalone(d), token: '', alive: () => false })), null);
  });

  test('unreadable discovery file: refused', async () => {
    const d = mk();
    writeFileSync(path.join(d, 'host.json'), '{not json');
    assert.equal(await liveBlock(outputsStatusFor(d, { hostCfg: noStandalone(d) })), 'output-state-unreadable');
  });

  test('CLI auto --run with a studio host running and no token: exit 1, refused, nothing approved', async () => {
    const d = mk();
    writeFileSync(path.join(d, 'flags.local.json'), JSON.stringify({ flags: { posting: true, 'auto-post': true } }));
    const rules = path.join(d, 'rules.json');
    writeFileSync(rules, JSON.stringify({ autoUpload: false, rules: [{ id: 'r1', target: 'youtube-shorts', minScore: 0, maxPerDay: 1 }] }));
    writeFileSync(path.join(d, 'host.json'), JSON.stringify({ pid: process.pid, port: 9, token: null }));
    const saved = process.env.UJWALAM_HOST_TOKEN;
    delete process.env.UJWALAM_HOST_TOKEN;
    const errs = [];
    try {
      const code = await main(['auto', '--run', '--data-dir', d, '--rules', rules], () => {}, (s) => errs.push(s));
      assert.equal(code, 1);
      assert.match(errs.join('\n'), /refused \(output-state-unreadable\)/);
    } finally { if (saved !== undefined) process.env.UJWALAM_HOST_TOKEN = saved; }
  });
});
