// SPDX-License-Identifier: GPL-3.0-or-later
// D327 OS1/OS2: stream setup round-trip, platform-limit refusal, rung dedup and planning through the host planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validate, loadPlatforms } from '../services/outputs/validate.mjs';
import { PLATFORMS_DIR, planFile } from '../app/host/lib/outputs-plan.mjs';
import {
  newOutputId, outputSummary, planSetup, readSetup, seedSetup, setupProblems, shapeProblems, toPlan, writePlanFile, writeSetup
} from '../services/studio-ui/stream-setup.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ujw-setup-'));
const clone = (x) => JSON.parse(JSON.stringify(x));

test('seed copies the live plan values (alpha-live.json), nothing guessed', () => {
  const s = seedSetup();
  assert.equal(s.canvasMode, 'multi');
  assert.deepEqual(s.video, { fps: 60, output: '1080p', hardware: true, bitrateKbps: 17000, portraitBitrateKbps: 7500, quality: 'balanced', audioKbps: 160 });
  assert.deepEqual(s.outputs.map((o) => [o.id, o.platform, o.canvas, o.video?.bitrateKbps ?? null]),
    [['youtube-h', 'youtube', 'H', null], ['youtube-v', 'youtube', 'V', null], ['twitch', 'twitch', 'H', 6000], ['kick', 'kick', 'H', 6000]]);
  assert.deepEqual(setupProblems(s), []);
});

test('seed plans like alpha-live.json: same rungs (twitch and kick share one), audio once', () => {
  const s = seedSetup();
  const { config } = toPlan(s);
  const res = validate(config, loadPlatforms(PLATFORMS_DIR));
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.rungs.map((r) => [r.id, r.canvas, r.w, r.h, r.bitrate, r.sinks]),
    [['h-main', 'H', 1920, 1080, 17000, ['youtube-h', 'record']], ['v-main', 'V', 1080, 1920, 7500, ['youtube-v']], ['h-twitch', 'H', 1920, 1080, 6000, ['twitch', 'kick']]]);
  assert.ok(res.info.some((i) => i.code === 'RUNG_DEDUP' && i.mergedFrom.includes('h-kick')), 'kick merged into twitch rung');
  assert.equal(config.audio.tracks.length, 1);
  const p = planSetup(s, { allowLive: true, schemes: { 'Ujwalam/stream/twitch-server': { present: true, scheme: 'rtmps' } } });
  assert.equal(p.params.rungs.length, 3);
  assert.deepEqual(p.params.rungs.map((r) => r.options), [{ preset: 'p5' }, { preset: 'p5' }, { preset: 'p5' }]);
  const t = Object.fromEntries(p.params.sinks.map((x) => [x.id, x.target]));
  assert.equal(t['youtube-h'].keyRef, 'Ujwalam/stream/youtube-h');
  assert.match(t['youtube-h'].url, /^rtmps:\/\//);
  assert.equal(t.twitch.urlRef, 'Ujwalam/stream/twitch-server');
  assert.equal(t.kick.transport, 'rtmps');
  assert.equal(t.record.transport, 'file');
  assert.throws(() => planSetup(s), /refused: plan with allowLive/);
});

test('round-trip: write then read gives the same setup', () => {
  const d = tmp();
  try {
    const first = readSetup(d);
    assert.equal(first.exists, false);
    const s = clone(first.setup);
    s.video.bitrateKbps = 12000; s.video.quality = 'quality'; s.video.hardware = false; s.outputs[0].enabled = false;
    assert.deepEqual(writeSetup(d, s).problems, []);
    const back = readSetup(d);
    assert.equal(back.exists, true);
    assert.deepEqual(back.setup, s);
    const { config } = toPlan(back.setup);
    assert.equal(config.encoders[0].encoder, 'x264');
    assert.deepEqual(config.encoders[0].encoderOptions, { preset: 'medium' });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a value over a platform limit is refused with the limit, and nothing is written', () => {
  const d = tmp();
  try {
    const s = seedSetup();
    s.outputs.find((o) => o.id === 'twitch').video.bitrateKbps = 9000; // twitch max 6000 (warning-class)
    s.outputs.find((o) => o.id === 'kick').video.bitrateKbps = 9000; // kick max 8000 (error-class)
    const r = writeSetup(d, s);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.code === 'BITRATE_RANGE' && /twitch max 6000/.test(p.message)), JSON.stringify(r.problems));
    assert.ok(r.problems.some((p) => p.code === 'BITRATE_RANGE' && /kick max 8000/.test(p.message)));
    assert.equal(readSetup(d).exists, false);
    const s2 = seedSetup();
    s2.video.bitrateKbps = 60000; // youtube max 50000
    assert.ok(setupProblems(s2).some((p) => /youtube max 50000/.test(p.message)));
    const s3 = seedSetup();
    s3.outputs.find((o) => o.id === 'kick').video.output = '1440p'; // kick max 1920x1080
    assert.ok(setupProblems(s3).some((p) => p.code === 'RESOLUTION_MAX' && /kick max 1920x1080/.test(p.message)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('shape checks refuse unknown keys, bad ids, wrong canvas and out-of-range choices', () => {
  const s = seedSetup();
  const bad = clone(s); bad.video.extra = 1; bad.outputs[0].id = 'Bad Id'; bad.outputs.push({ id: 'twitch-2', name: 'x', platform: 'twitch', canvas: 'V', enabled: true });
  bad.video.fps = 45; bad.video.audioKbps = 100;
  const msgs = shapeProblems(bad).map((p) => p.field);
  for (const f of ['video', 'outputs[0].id', 'outputs[4].canvas', 'video.fps', 'video.audioKbps']) assert.ok(msgs.includes(f), `${f} in ${msgs}`);
  const rec = clone(s); rec.outputs[0].id = 'record';
  assert.ok(shapeProblems(rec).some((p) => p.field === 'outputs[0].id'));
  const dup = clone(s); dup.outputs[1].id = dup.outputs[0].id;
  assert.ok(shapeProblems(dup).some((p) => /used twice/.test(p.message)));
});

test('main-canvas mode leaves portrait outputs out of the plan (no V rung)', () => {
  const s = seedSetup(); s.canvasMode = 'main';
  const { config, included } = toPlan(s);
  assert.deepEqual(included, ['youtube-h', 'twitch', 'kick']);
  assert.ok(!config.encoders.some((e) => e.canvas === 'V'));
});

test('summary line and new ids', () => {
  const s = seedSetup();
  assert.equal(outputSummary(s, s.outputs[1]), '1080x1920 @ 60fps 7,500 kbps · Portrait canvas');
  assert.equal(outputSummary(s, s.outputs[2]), '1080p @ 60fps 6,000 kbps · Main canvas');
  assert.equal(newOutputId(s, 'twitch'), 'twitch-2');
  assert.equal(newOutputId(s, 'youtube'), 'youtube');
});

test('plan file written for the launcher plans through planFile', () => {
  const d = tmp();
  try {
    const f = writePlanFile(d, seedSetup());
    const p = planFile(f, { allowLive: true, schemes: { 'Ujwalam/stream/twitch-server': { present: true, scheme: 'rtmp' } } });
    assert.deepEqual(p.params.sinks.map((x) => x.id), ['youtube-h', 'youtube-v', 'twitch', 'kick', 'record']);
    assert.equal(p.params.sinks.find((x) => x.id === 'twitch').proto, 'rtmp');
    assert.doesNotMatch(readFileSync(f, 'utf8'), /live_[A-Za-z0-9]|sk_/, 'no key material');
    writeFileSync(path.join(d, 'stream-setup.json'), '{ not json');
    assert.throws(() => readSetup(d));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
