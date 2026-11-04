// SPDX-License-Identifier: GPL-3.0-or-later
// D198: the studio starts the event core with the same Streamer.bot address as the bot manager (8093 by default),
// not the connector's documented 8080. Pure argument tests: nothing is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { coreServeArgs } from '../services/studio-ui/launch.mjs';
import { loadBotConfig } from '../services/bots/index.mjs';
import { checkUrl } from '../services/event-core/streamerbot/connector.mjs';

test('live: --url is the bot-manager address; default 8093 when the profile has none', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'core-url-'));
  try {
    const none = loadBotConfig({ profilePath: path.join(tmp, 'missing.json') }).streamerbot;
    const r = coreServeArgs({ dataDir: 'D', sbWs: none });
    assert.deepEqual(r.argv, ['serve', '--data-dir', 'D', '--url', 'ws://127.0.0.1:8093/']);
    assert.equal(r.note, null);
    assert.doesNotThrow(() => checkUrl(r.argv.at(-1)), 'the core accepts it');

    const prof = path.join(tmp, 'p.json');
    writeFileSync(prof, JSON.stringify({ bots: { streamerbot_ws: 'ws://127.0.0.1:9111/' } }));
    assert.equal(coreServeArgs({ dataDir: 'D', sbWs: loadBotConfig({ profilePath: prof }).streamerbot }).argv.at(-1), 'ws://127.0.0.1:9111/');

    writeFileSync(prof, JSON.stringify({ bots: { streamerbot_ws: '<streamerbot-ws-or-remove-for-default>' } }));
    assert.equal(coreServeArgs({ dataDir: 'D', sbWs: loadBotConfig({ profilePath: prof }).streamerbot }).argv.at(-1), 'ws://127.0.0.1:8093/', 'placeholder = default');

    writeFileSync(prof, JSON.stringify({ bots: { streamerbot_ws: 'ws://192.168.1.5:8093/' } }));
    const far = coreServeArgs({ dataDir: 'D', sbWs: loadBotConfig({ profilePath: prof }).streamerbot });
    assert.ok(!far.argv.includes('--url'), 'a non-loopback address is never passed');
    assert.match(far.note, /refused \(not-loopback\)/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('mock: no Streamer.bot address at all', () => {
  assert.deepEqual(coreServeArgs({ dataDir: 'D', mock: true, sbWs: { ws: 'ws://127.0.0.1:8093/' } }).argv, ['serve', '--data-dir', 'D', '--mock']);
});
