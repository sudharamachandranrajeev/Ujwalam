// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, loadPlatforms } from '../../services/outputs/validate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fx = path.join(repo, 'tests', 'fixtures', 'outputs');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const base = () => readJson(path.join(fx, 'base.json'));
const testplat = () => readJson(path.join(fx, 'platforms', 'testplat.json'));
const real = loadPlatforms(path.join(repo, 'data', 'platforms'));

const codes = (res) => res.errors.map((e) => e.code);
// Run base config against the fixture platform after optional config / platform mutations.
const run = (mut, platMut) => {
  const c = base();
  const p = testplat();
  if (mut) mut(c);
  if (platMut) platMut(p);
  return validate(c, { testplat: p });
};
const s2 = { id: 's2', platform: 'testplat', encoder: 'r1', proto: 'rtmps', priority: 2 };

test('base fixture is clean', () => {
  const r = run();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.rungs.map((x) => [x.id, x.sinks]), [['r1', ['s1']]]);
});

// ---- Done-when cases ---------------------------------------------------------------

test('DONE-WHEN rung dedup: identical encoders merge into one rung', () => {
  const r = run((c) => {
    c.encoders.push({ ...c.encoders[0], id: 'r2' });
    c.sinks.push({ ...s2, encoder: 'r2' });
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.rungs.length, 1);
  assert.deepEqual(r.rungs[0].mergedFrom, ['r2']);
  assert.deepEqual(r.rungs[0].sinks, ['s1', 's2']);
  assert.deepEqual(r.info.find((i) => i.code === 'RUNG_DEDUP').mergedFrom, ['r2']);
});

test('DONE-WHEN codec refusal', () => {
  assert.deepEqual(codes(run((c) => { c.encoders[0].codec = 'hevc'; })), ['CODEC_REFUSED']);
});

test('DONE-WHEN bitrate out of range', () => {
  assert.deepEqual(codes(run((c) => { c.encoders[0].bitrate = 9000; })), ['BITRATE_RANGE']);
  assert.deepEqual(codes(run((c) => { c.encoders[0].bitrate = 500; })), ['BITRATE_RANGE']);
});

test('DONE-WHEN missing rung', () => {
  assert.deepEqual(codes(run((c) => { c.sinks[0].encoder = 'nope'; })), ['MISSING_RUNG']);
});

// ---- per-code pass/fail ----------------------------------------------------------------

test('RUNG_DEDUP: different bitrate does not merge', () => {
  const r = run((c) => { c.encoders.push({ ...c.encoders[0], id: 'r2', bitrate: 5000 }); });
  assert.equal(r.rungs.length, 2);
  assert.equal(r.info.length, 0);
});

test('RUNG_DEDUP: different encoderOptions do not merge', () => {
  const r = run((c) => {
    c.encoders[0].encoderOptions = { preset: 'P7' };
    c.encoders.push({ ...c.encoders[0], id: 'r2', encoderOptions: { preset: 'P4' } });
  });
  assert.equal(r.rungs.length, 2);
});

test('DUP_ID', () => {
  assert.deepEqual(codes(run((c) => { c.sinks.push({ ...c.sinks[0] }); })), ['DUP_ID']);
  assert.deepEqual(codes(run((c) => { c.canvases.push({ ...c.canvases[0] }); })), ['DUP_ID']);
  assert.ok(codes(run((c) => { c.audio.tracks.push({ ...c.audio.tracks[0] }); })).includes('DUP_ID'));
  assert.ok(codes(run((c) => { c.encoders.push({ ...c.encoders[0] }); })).includes('DUP_ID'));
});

test('MISSING_CANVAS', () => {
  assert.ok(codes(run((c) => { c.encoders[0].canvas = 'X'; })).includes('MISSING_CANVAS'));
});

test('MISSING_PLATFORM', () => {
  assert.deepEqual(codes(run((c) => { c.sinks[0].platform = 'nowhere'; })), ['MISSING_PLATFORM']);
});

test('MISSING_AUDIO_TRACK', () => {
  assert.deepEqual(codes(run((c) => { c.sinks[0].audioTracks = ['ghost']; })), ['MISSING_AUDIO_TRACK']);
  assert.deepEqual(codes(run((c) => { c.sinks[0].audioTracks = ['master']; })), []);
});

test('CODEC_REFUSED passes for allowed codec', () => {
  assert.deepEqual(codes(run((c) => { c.encoders[0].codec = 'hevc'; }, (p) => { p.videoCodecs.value = ['h264', 'hevc']; })), []);
});

test('AUDIO_BITRATE_RANGE', () => {
  assert.deepEqual(codes(run((c) => { c.audio.tracks[0].bitrate = 320; })), ['AUDIO_BITRATE_RANGE']);
});

test('AUDIO_CODEC_REFUSED', () => {
  assert.deepEqual(codes(run(null, (p) => { p.audioCodecs.value = ['mp3']; })), ['AUDIO_CODEC_REFUSED']);
});

test('AUDIO_TRACKS_MAX', () => {
  const two = (c) => { c.audio.tracks.push({ id: 'vod', name: 'VOD Track', codec: 'aac', bitrate: 160, sampleRate: 48000 }); };
  assert.deepEqual(codes(run(two)), ['AUDIO_TRACKS_MAX']);
  assert.deepEqual(codes(run((c) => { two(c); c.sinks[0].audioTracks = ['master']; })), []);
});

test('RESOLUTION_MAX', () => {
  const r = run((c) => { c.canvases[0].w = 3840; c.canvases[0].h = 2160; c.encoders[0].w = 3840; c.encoders[0].h = 2160; });
  assert.deepEqual(codes(r), ['RESOLUTION_MAX']);
});

test('RESOLUTION_MAX is orientation-aware (1080x1920 passes a 1920x1080 max; 1440x2560 fails)', () => {
  const vert = (w, h) => (c) => {
    c.canvases[0] = { id: 'H', w, h, fps: 60 };
    c.encoders[0].w = w;
    c.encoders[0].h = h;
  };
  assert.deepEqual(codes(run(vert(1080, 1920))), []);
  assert.deepEqual(codes(run(vert(1440, 2560))), ['RESOLUTION_MAX']);
});

test('FPS_MAX', () => {
  assert.deepEqual(codes(run((c) => { c.canvases[0].fps = 120; })), ['FPS_MAX']);
});

test('GOP_MAX', () => {
  assert.deepEqual(codes(run((c) => { c.encoders[0].gop_sec = 5; })), ['GOP_MAX']);
  assert.deepEqual(codes(run((c) => { c.encoders[0].gop_sec = 4; })), []);
});

test('UPSCALE', () => {
  const big = (p) => { p.maxWidth.value = 4000; p.maxHeight.value = 4000; };
  assert.deepEqual(codes(run((c) => { c.encoders[0].w = 2560; c.encoders[0].h = 1440; }, big)), ['UPSCALE']);
  assert.deepEqual(codes(run((c) => { c.encoders[0].w = 1280; c.encoders[0].h = 720; })), []);
});

test('FPS_DIVISOR', () => {
  assert.deepEqual(codes(run((c) => { c.encoders[0].fps = 25; })), ['FPS_DIVISOR']);
  assert.deepEqual(codes(run((c) => { c.encoders[0].fps = 30; })), []);
});

test('RC_REFUSED', () => {
  assert.deepEqual(codes(run((c) => { c.encoders[0].rc = 'vbr'; })), ['RC_REFUSED']);
  assert.deepEqual(codes(run((c) => { c.encoders[0].rc = 'vbr'; }, (p) => { p.rateControl.value = ['cbr', 'vbr']; })), []);
});

test('NOT_RECOMMENDED: audio bitrate / sample rate differing from recommended warns, never blocks', () => {
  const r = run((c) => { c.audio.tracks[0].bitrate = 128; c.audio.tracks[0].sampleRate = 44100; });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map((w) => [w.code, w.field]), [['NOT_RECOMMENDED', 'audioBitrateKbps'], ['NOT_RECOMMENDED', 'audioSampleRateHz']]);
  assert.deepEqual(run().warnings, []);
});

test('PROTO_UNSUPPORTED', () => {
  assert.deepEqual(codes(run((c) => { c.sinks[0].proto = 'srt'; })), ['PROTO_UNSUPPORTED']);
});

test('SHARED_RUNG_CONFLICT names rung and every sink', () => {
  const r = run((c) => { c.encoders[0].bitrate = 9000; c.sinks.push(s2); });
  const e = r.errors.find((x) => x.code === 'SHARED_RUNG_CONFLICT');
  assert.ok(e);
  assert.equal(e.rung, 'r1');
  assert.deepEqual(e.sinks, ['s1', 's2']);
  assert.match(e.message, /"r1"/);
  assert.match(e.message, /"s1"/);
  assert.match(e.message, /"s2"/);
});

test('SHARED_RUNG_CONFLICT absent when rung has one sink or nothing fails', () => {
  assert.ok(!codes(run((c) => { c.encoders[0].bitrate = 9000; })).includes('SHARED_RUNG_CONFLICT'));
  assert.deepEqual(codes(run((c) => { c.sinks.push(s2); })), []);
});

test('MIGRATION_PENDING is a BLOCKED-class error and skips value checks', () => {
  const r = run((c) => { c.encoders = [{ id: 'r1', canvas: 'H', migration: { from: 'Meld prefs', status: 'pending' } }]; });
  assert.deepEqual(codes(r), ['MIGRATION_PENDING']);
  assert.equal(r.errors[0].class, 'BLOCKED');
  assert.match(r.errors[0].message, /not guessed/);
  assert.deepEqual(codes(run((c) => { c.encoders[0].migration = { from: 'x', status: 'migrated' }; })), []);
});

test('UNVERIFIED_LIMIT warns once; a failed check against an unverified value is a warning, never an error', () => {
  const unv = (p) => { p.videoBitrateKbps.max = { value: 6500, severity: 'warning', unverified: true, note: 'blog only' }; };
  const r = run((c) => { c.encoders[0].bitrate = 7000; c.sinks.push(s2); }, unv);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.code === 'BITRATE_RANGE' && w.severity === 'warning'));
  assert.equal(r.warnings.filter((w) => w.field === 'videoBitrateKbps.max').length, 1);
  const ok = run(null, unv);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings.map((w) => w.code), ['UNVERIFIED_LIMIT']);
});

test('UNVERIFIED value claiming severity error is still reported as a warning', () => {
  const r = run((c) => { c.encoders[0].bitrate = 7000; }, (p) => { p.videoBitrateKbps.max = { value: 6500, severity: 'error', unverified: true, note: 'x' }; });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.code === 'BITRATE_RANGE'));
});

test('severity: the same check is an error or a warning according to its rule (fixture platform)', () => {
  const over = (c) => { c.encoders[0].bitrate = 9000; };
  const asErr = run(over);
  assert.deepEqual(asErr.errors.map((e) => [e.code, e.severity]), [['BITRATE_RANGE', 'error']]);
  const asWarn = run(over, (p) => { p.videoBitrateKbps.max.severity = 'warning'; });
  assert.deepEqual(asWarn.errors, []);
  assert.deepEqual(asWarn.warnings.map((e) => [e.code, e.severity]), [['BITRATE_RANGE', 'warning']]);
});

test('severity: shared-rung conflict is a warning when every failure is a warning, an error otherwise', () => {
  const over = (c) => { c.encoders[0].bitrate = 9000; c.sinks.push(s2); };
  const w = run(over, (p) => { p.videoBitrateKbps.max.severity = 'warning'; });
  assert.deepEqual(w.errors, []);
  assert.deepEqual(w.warnings.map((x) => x.code), ['BITRATE_RANGE', 'BITRATE_RANGE', 'SHARED_RUNG_CONFLICT']);
  assert.ok(run(over).errors.some((x) => x.code === 'SHARED_RUNG_CONFLICT' && x.severity === 'error'));
});

test('keyframe: hard max (error) and recommendation (warning) are both checked', () => {
  const kf = (p) => { p.keyframeIntervalSec.recommended = { value: 2, severity: 'warning', source: 'fixture', checked: '2026-10-26' }; };
  const g = (n) => (c) => { c.encoders[0].gop_sec = n; };
  assert.deepEqual(run(g(2), kf).warnings, []);
  const three = run(g(3), kf);
  assert.deepEqual(three.errors, []);
  assert.deepEqual(three.warnings.map((x) => x.code), ['NOT_RECOMMENDED']);
  const five = run(g(5), kf);
  assert.deepEqual(five.errors.map((x) => x.code), ['GOP_MAX']);
  assert.deepEqual(five.warnings, []);
});

test('UNVERIFIED null value is not checked and warns', () => {
  const r = run((c) => { c.encoders[0].bitrate = 99999; }, (p) => { p.videoBitrateKbps.max = { value: null, unverified: true, note: 'unknown' }; });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
});

test('validator does not mutate its inputs', () => {
  const c = base();
  const p = { testplat: testplat() };
  const before = JSON.stringify([c, p]);
  validate(c, p);
  assert.equal(JSON.stringify([c, p]), before);
});

// ---- example graph (amendment) --------------------------------------------------------------

test('output-graph example resolves 4 sinks onto 3 rungs, no errors', () => {
  const r = validate(readJson(path.join(fx, 'output-graph-example.json')), real);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rungs.map((x) => [x.id, x.sinks]), [['uhd', ['youtube-h']], ['multi', ['twitch', 'kick']], ['vert', ['youtube-v']]]);
});

test('real registry: Kick refuses the 4K HEVC rung (codec, bitrate, resolution)', () => {
  const c = readJson(path.join(fx, 'output-graph-example.json'));
  c.sinks.push({ id: 'kick-uhd', platform: 'kick', encoder: 'uhd', proto: 'rtmps', priority: 5 });
  const r = validate(c, real);
  const kc = r.errors.filter((e) => e.sink === 'kick-uhd').map((e) => e.code).sort();
  assert.deepEqual(kc, ['BITRATE_RANGE', 'CODEC_REFUSED', 'RESOLUTION_MAX']);
});

// ---- built-in presets: asserted as-is ----------------------------------------------------------

const preset = (n) => readJson(path.join(repo, 'data', 'outputs', 'presets', n));
const YT_AUDIO_WARN = [['NOT_RECOMMENDED', 'audioBitrateKbps'], ['NOT_RECOMMENDED', 'audioSampleRateHz']];

for (const [n, egress] of [['youtube-1080p60.json', 37140], ['youtube-1440p60.json', 54140], ['youtube-2160p60.json', 70140]]) {
  test(`preset ${n}: no errors; twitch+kick share reencode-tk; yt audio NOT_RECOMMENDED; egress ${egress}`, () => {
    const cfg = preset(n);
    const r = validate(cfg, real);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rungs.map((x) => [x.id, x.sinks]), [['yt-h', ['youtube-h']], ['reencode-tk', ['twitch', 'kick']], ['vert', ['youtube-v']]]);
    assert.equal(r.info.length, 0); // same-size rungs with different bitrate never dedup
    const nr = r.warnings.filter((w) => w.code === 'NOT_RECOMMENDED');
    assert.deepEqual(nr.map((w) => [w.code, w.field]), YT_AUDIO_WARN);
    assert.ok(nr.every((w) => w.platform === 'youtube'));
    assert.ok(r.warnings.every((w) => ['NOT_RECOMMENDED', 'UNVERIFIED_LIMIT'].includes(w.code)));
    assert.equal(r.egressKbps, egress);
    assert.match(cfg.note, new RegExp(`Total egress ${egress} kbps`));
    assert.match(cfg.note, /3 NVENC sessions/);
    assert.match(cfg.note, /UNVERIFIED until O2/);
  });
}

// ---- severity on the real registry ---------------------------------------------------------

// Clone of the base fixture re-pointed at one real platform.
function onPlatform(platform, proto, mut) {
  const c = base();
  c.sinks[0] = { ...c.sinks[0], platform, proto };
  if (mut) mut(c);
  return validate(c, real);
}
const sig = (list, code) => list.filter((x) => x.code === code).map((x) => x.severity);

test('YouTube VBR is a warning (CBR is listed, VBR may cause buffering)', () => {
  const r = onPlatform('youtube', 'rtmps', (c) => { c.encoders[0].rc = 'vbr'; });
  assert.deepEqual(r.errors, []);
  const w = r.warnings.find((x) => x.code === 'RC_REFUSED');
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /YouTube lists CBR; VBR may cause buffering/);
});

test('YouTube gop 5 is an error (hard max 4 s)', () => {
  const r = onPlatform('youtube', 'rtmps', (c) => { c.encoders[0].gop_sec = 5; });
  assert.deepEqual(r.errors.map((x) => [x.code, x.severity]), [['GOP_MAX', 'error']]);
  assert.ok(!r.warnings.some((x) => x.field === 'keyframeIntervalSec')); // gop not double-reported
});

test('YouTube gop 3 is a warning only (recommended 2 s)', () => {
  const r = onPlatform('youtube', 'rtmps', (c) => { c.encoders[0].gop_sec = 3; });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((x) => x.code === 'NOT_RECOMMENDED' && x.field === 'keyframeIntervalSec'));
});

test('YouTube bitrate above the table (60000 kbps) is a warning: recommendations, not stated limits', () => {
  const r = onPlatform('youtube', 'rtmps', (c) => { c.encoders[0].bitrate = 60000; });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(sig(r.warnings, 'BITRATE_RANGE'), ['warning']);
});

test('Kick VBR is an error', () => {
  const r = onPlatform('kick', 'rtmps', (c) => { c.encoders[0].rc = 'vbr'; });
  assert.deepEqual(r.errors.map((x) => [x.code, x.severity]), [['RC_REFUSED', 'error']]);
});

test('Kick 9000 kbps is an error', () => {
  const r = onPlatform('kick', 'rtmps', (c) => { c.encoders[0].bitrate = 9000; });
  assert.deepEqual(r.errors.map((x) => [x.code, x.severity]), [['BITRATE_RANGE', 'error']]);
});

test('Kick gop 3 is a warning (2 s is not stated as a hard limit)', () => {
  const r = onPlatform('kick', 'rtmps', (c) => { c.encoders[0].gop_sec = 3; });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(sig(r.warnings, 'GOP_MAX'), ['warning']);
});

test('Twitch 7500 kbps is a warning ("standard" 6000, not a hard limit); 6000 is clean', () => {
  const r = onPlatform('twitch', 'rtmp', (c) => { c.encoders[0].bitrate = 7500; });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(sig(r.warnings, 'BITRATE_RANGE'), ['warning']);
  assert.deepEqual(sig(onPlatform('twitch', 'rtmp').warnings, 'BITRATE_RANGE'), []);
});

test('error-severity rules in the real registry are exactly the documented hard limits', () => {
  const errs = [];
  const w = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    if ('value' in o) { if (o.severity === 'error') errs.push(p); return; }
    for (const [k, v] of Object.entries(o)) w(v, p + '.' + k);
  };
  for (const [id, p] of Object.entries(real)) if (id !== 'local') w(p, id);
  assert.deepEqual(errs.sort(), ['kick.maxFps', 'kick.maxHeight', 'kick.maxWidth', 'kick.rateControl', 'kick.videoBitrateKbps.max', 'kick.videoBitrateKbps.min', 'kick.videoCodecs', 'youtube.keyframeIntervalSec.max'].sort());
});

test('old Meld-migrated MULTI fixture (superseded): 7500 kbps on Twitch is now a warning, 0 errors', () => {
  const cfg = readJson(path.join(fx, 'meld-migrated-multi.json'));
  assert.equal(cfg.superseded.date, '2026-10-27');
  const r = validate(cfg, real);
  assert.deepEqual(r.errors, []);
  const w = r.warnings.filter((x) => x.code !== 'UNVERIFIED_LIMIT');
  assert.deepEqual(w.map((x) => [x.code, x.severity, x.sink ?? null]), [['BITRATE_RANGE', 'warning', 'twitch'], ['SHARED_RUNG_CONFLICT', 'warning', null]]);
  assert.deepEqual(w[1].failedSinks, ['twitch']);
  const m = cfg.encoders[0];
  assert.equal(m.bitrate, 7500);
  assert.equal(m.migration.status, 'migrated');
  assert.match(m.migration.note, /UNVERIFIED/);
});
