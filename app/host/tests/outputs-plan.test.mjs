// SPDX-License-Identifier: GPL-2.0-or-later
// O0 config -> host outputs.configure params (pure; no host process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { plan, planFile } from '../lib/outputs-plan.mjs';
import { HOST_DIR } from '../lib/config.mjs';

const O1 = path.join(HOST_DIR, 'outputs', 'o1-loopback.json');

test('o1-loopback plan: deduped rungs, sinks bound to rungs, one audio track, loopback targets', () => {
  const { params, report } = planFile(O1);
  assert.equal(report.errors.length, 0);
  assert.deepEqual(params.rungs.map((r) => r.id), ['yt-h', 'reencode-tk', 'vert']);
  const byRung = Object.fromEntries(params.rungs.map((r) => [r.id, params.sinks.filter((s) => s.rung === r.id).map((s) => s.id)]));
  assert.deepEqual(byRung, { 'yt-h': ['youtube-h', 'rec-h'], 'reencode-tk': ['twitch', 'kick'], vert: ['youtube-v'] });
  assert.deepEqual(params.audio, { bitrate: 160, sampleRate: 48000 });
  for (const s of params.sinks) {
    assert.ok(['rtmp', 'srt', 'file'].includes(s.target.transport));
    assert.equal(JSON.stringify(s.target).includes('://'), false, 'no URLs in targets: the host builds them');
  }
});

test('platform limits come from data/platforms: an over-limit rung is an error', () => {
  const { config, wrapper } = planFile(O1);
  const bad = structuredClone(config);
  bad.encoders.find((e) => e.id === 'reencode-tk').bitrate = 9000; // twitch max is in data/platforms/twitch.json
  assert.throws(() => plan(bad, wrapper.targets), /output config has errors/);
});

test('every sink needs a target, and targets must name sinks', () => {
  const { config, wrapper } = planFile(O1);
  const t = { ...wrapper.targets };
  delete t.kick;
  assert.throws(() => plan(config, t), /"kick" has no loopback target/);
  assert.throws(() => plan(config, { ...wrapper.targets, ghost: { transport: 'file', name: 'g.mkv' } }), /names no sink/);
});

test('identical encoders are merged into one rung (dedup from the O0 validator)', () => {
  const { config, wrapper } = planFile(O1);
  const c = structuredClone(config);
  c.encoders.push({ ...c.encoders.find((e) => e.id === 'reencode-tk'), id: 'reencode-copy' });
  c.sinks.find((s) => s.id === 'kick').encoder = 'reencode-copy';
  const { params } = plan(c, wrapper.targets);
  assert.equal(params.rungs.length, 3);
  assert.equal(params.sinks.find((s) => s.id === 'kick').rung, 'reencode-tk');
});

test('o2-loopback plan: YouTube 1440p60 H direct, one Multi rung 1920x1080@60 CBR 6000 on H for twitch + kick', () => {
  const { params } = planFile(path.join(HOST_DIR, 'outputs', 'o2-loopback.json'));
  assert.deepEqual(params.rungs.map((r) => `${r.id}:${r.canvas}:${r.w}x${r.h}@${r.fps}:${r.rc}:${r.bitrate}`),
    ['yt-h:H:2560x1440@60:cbr:34000', 'reencode-tk:H:1920x1080@60:cbr:6000', 'vert:V:1080x1920@60:cbr:7500']);
  const rungOf = Object.fromEntries(params.sinks.map((s) => [s.id, s.rung]));
  assert.deepEqual(rungOf, { 'youtube-h': 'yt-h', 'youtube-v': 'vert', twitch: 'reencode-tk', kick: 'reencode-tk' });
  for (const s of params.sinks) assert.ok(s.target.port && s.target.port !== 8093, `${s.id}: loopback port`);
  assert.equal(params.audio.sampleRate, 48000);
});
