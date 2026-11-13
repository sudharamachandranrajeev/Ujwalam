// SPDX-License-Identifier: GPL-3.0-or-later
// The on-air bar's summary (D355 Q2, services/studio-ui/server.mjs onAirSummary): timers from the longest live sink of
// each kind, the summed bitrate of the live streams, per stream sink only id, platform, state and bitrate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onAirSummary } from '../services/studio-ui/server.mjs';

test('onAirSummary: live streams and a recording', () => {
  const s = onAirSummary({ sinks: [
    { id: 'yt-h', kind: 'stream', platform: 'youtube', state: 'live', liveForMs: 65000, kbps: 17100.4, url: 'rtmp://secret', lastError: 'x' },
    { id: 'twitch', kind: 'stream', platform: 'twitch', state: 'live', liveForMs: 64000, kbps: 6000 },
    { id: 'kick', kind: 'stream', platform: 'kick', state: 'retrying', liveForMs: null, kbps: 0 },
    { id: 'rec', kind: 'record', state: 'live', liveForMs: 70000, path: 'C:/x.mkv' },
  ] });
  assert.equal(s.liveForMs, 65000);
  assert.equal(s.recordForMs, 70000);
  assert.equal(s.kbps, 23100, 'live streams only, rounded');
  assert.deepEqual(s.sinks.map((x) => x.id), ['yt-h', 'twitch', 'kick'], 'stream sinks only');
  assert.deepEqual(s.sinks[0], { id: 'yt-h', platform: 'youtube', state: 'live', kbps: 17100 });
  assert.ok(!JSON.stringify(s).includes('secret') && !JSON.stringify(s).includes('x.mkv'), 'no URL or path');
});

test('onAirSummary: nothing running or an unreadable answer', () => {
  assert.deepEqual(onAirSummary({ sinks: [{ id: 'yt-h', kind: 'stream', state: 'stopped' }] }),
    { liveForMs: null, recordForMs: null, kbps: null, sinks: [{ id: 'yt-h', platform: null, state: 'stopped', kbps: null }] });
  assert.deepEqual(onAirSummary(null), { liveForMs: null, recordForMs: null, kbps: null, sinks: [] });
  assert.deepEqual(onAirSummary({ sinks: 'no' }).sinks, []);
});
