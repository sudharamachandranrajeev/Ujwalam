// SPDX-License-Identifier: GPL-3.0-or-later
// Pure parts of the live-soak gate (tools/soak/live-soak.mjs, LU8): arguments, timestamp gaps, error-level log
// lines, the report, each file sink's recording file (LC2). The gate itself runs the host and is a release gate,
// not part of this suite.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { errorLines, missingRequiredStreams, noPaths, notLiveByStream, noteChange, parseSoakArgs, ptsGaps, recordingFileFor, recordingProblems, REQUIRED_STREAMS, report, sinkFps, stallLines } from '../tools/soak/live-soak.mjs';
import { stageRuntime } from '../tools/soak/stage.mjs';

test('arguments: 30 min by default, --short is 3 min, bad values refused', () => {
  assert.equal(parseSoakArgs([]).minutes, 30);
  assert.equal(parseSoakArgs([]).short, false);
  assert.equal(parseSoakArgs(['--short']).minutes, 3);
  assert.equal(parseSoakArgs(['--short']).short, true);
  assert.equal(parseSoakArgs(['--minutes', '10']).minutes, 10);
  assert.equal(parseSoakArgs(['--no-record']).record, false);
  assert.throws(() => parseSoakArgs(['--minutes', '0']));
  assert.throws(() => parseSoakArgs(['--minutes']));
  assert.throws(() => parseSoakArgs(['stray']));
});

test('timestamp gaps: a steady 60 fps stream has none; a missing run of frames is one gap', () => {
  const steady = Array.from({ length: 600 }, (_, i) => i / 60);
  assert.deepEqual({ gaps: ptsGaps(steady, { fps: 60 }).gaps, missing: ptsGaps(steady, { fps: 60 }).missingFrames }, { gaps: 0, missing: 0 });
  const holed = steady.filter((_, i) => i < 100 || i >= 103);
  const g = ptsGaps(holed.reverse(), { fps: 60 }); // any order (B-frames)
  assert.equal(g.gaps, 1);
  assert.equal(g.missingFrames, 3);
  assert.equal(ptsGaps([0, 1], { fps: 60 }).gaps, 0);
  const jitter = Array.from({ length: 600 }, (_, i) => Math.round((i * 1000) / 60) / 1000); // 16/17 ms steps (ms timebase)
  assert.equal(ptsGaps(jitter, { fps: 60 }).gaps, 0);
});

test('timestamp gaps use the planned fps, never the observed median: losing every second frame is caught (review P2)', () => {
  const half = Array.from({ length: 300 }, (_, i) => (2 * i) / 60); // a 60 fps output that delivers 30 fps
  const g = ptsGaps(half, { fps: 60 });
  assert.equal(g.gaps, 299);
  assert.equal(g.missingFrames, 299);
  assert.throws(() => ptsGaps(half), /fps is required/);
});

test('recording: a rejected start, a gap in liveness, no file or a short or holed file all fail (review P2)', () => {
  const good = { start: 'ok', sinkId: 'record', notLiveSamples: 0, samples: 18, probe: { gaps: 0, spanSec: 178 }, durationS: 180 };
  assert.deepEqual(recordingProblems(good), []);
  assert.match(recordingProblems({ ...good, start: 'error BUSY' }).join(), /start error BUSY/);
  assert.match(recordingProblems({ ...good, start: undefined }).join(), /start not called/);
  assert.match(recordingProblems({ ...good, sinkId: undefined, notLiveSamples: undefined }).join(), /no file sink/);
  assert.match(recordingProblems({ ...good, notLiveSamples: 2 }).join(), /not live in 2 of 18/);
  assert.match(recordingProblems({ ...good, samples: 0 }).join(), /not live/);
  assert.match(recordingProblems({ ...good, probe: null }).join(), /no recording file/);
  assert.match(recordingProblems({ ...good, probe: { error: 'ffprobe failed' } }).join(), /probe: ffprobe failed/);
  assert.match(recordingProblems({ ...good, probe: { gaps: 3, spanSec: 178 } }).join(), /3 timestamp gaps/);
  assert.match(recordingProblems({ ...good, probe: { gaps: 0, spanSec: 40 } }).join(), /covers 40 of 180 s/);
});

test('required streams: a plan without kick, or empty, fails; fps comes from the sink rung (review P2)', () => {
  const rtmp = { transport: 'rtmp' };
  const full = { rungs: [{ id: 'a', fps: 60 }, { id: 'v', fps: 30 }], sinks: [{ id: 'youtube-h', rung: 'a', target: rtmp }, { id: 'youtube-v', rung: 'v', target: rtmp }, { id: 'twitch', rung: 'a', target: rtmp }, { id: 'kick', rung: 'a', target: rtmp }, { id: 'record', rung: 'a', target: { transport: 'file' } }] };
  assert.deepEqual(missingRequiredStreams(full), []);
  assert.deepEqual(missingRequiredStreams({ ...full, sinks: full.sinks.filter((s) => s.id !== 'kick') }), ['kick']);
  assert.deepEqual(missingRequiredStreams({ rungs: [], sinks: [] }), [...REQUIRED_STREAMS]);
  assert.deepEqual(missingRequiredStreams({ ...full, sinks: full.sinks.map((s) => (s.id === 'twitch' ? { ...s, target: { transport: 'file' } } : s)) }), ['twitch']);
  assert.deepEqual(sinkFps(full), { 'youtube-h': 60, 'youtube-v': 30, twitch: 60, kick: 60, record: 60 });
  const live = (ids) => ({ sinks: ids.map((id) => ({ id, state: 'live' })) });
  const rows = [live([...REQUIRED_STREAMS, 'record']), live(['youtube-h', 'youtube-v', 'twitch', 'record']), { sinks: [] }];
  assert.deepEqual(notLiveByStream(rows, [...REQUIRED_STREAMS, 'record']), { 'youtube-h': 1, 'youtube-v': 1, twitch: 1, kick: 2, record: 1 });
});

test('error-level lines: host error tags and Node faults count; known benign lines and other levels do not', () => {
  const t = [
    '2026-11-10T10:00:00.000 info: started',
    '2026-11-10T10:00:00.100 warn: [data] effect-guards: guards.json not applied, the last good version stays: not valid JSON (line 3)',
    '2026-11-10T10:00:00.200 error: Tried to call obs_frontend_add_event_callback with no callbacks!',
    '2026-11-10T10:00:01.000 error: encoder failed',
    'TypeError: x is not a function',
    '[studio-ui] errors so far: 0',
  ].join('\n');
  const e = errorLines(t);
  assert.deepEqual(e.faults, ['encoder failed', 'TypeError: x is not a function']);
  assert.equal(Object.values(e.benign)[0], 1);
});

test('timestamp gaps: a gap at the very end of the last segment (stream stop) is counted apart', () => {
  const s = Array.from({ length: 600 }, (_, i) => i / 60).filter((_, i) => i !== 598);
  assert.deepEqual([ptsGaps(s, { fps: 60 }).gaps, ptsGaps(s, { fps: 60 }).endGaps], [1, 0]);
  assert.deepEqual([ptsGaps(s, { fps: 60, tailSec: 0.5 }).gaps, ptsGaps(s, { fps: 60, tailSec: 0.5 }).endGaps], [0, 1]);
  const mid = Array.from({ length: 600 }, (_, i) => i / 60).filter((_, i) => i !== 300);
  assert.equal(ptsGaps(mid, { fps: 60, tailSec: 0.5 }).gaps, 1, 'a gap mid-stream still counts');
});

test('stall lines and paths: warnings after the start with t, paths never in the report', () => {
  const start = Date.parse('2026-11-10T10:00:00.000Z');
  const t = ['2026-11-10T09:59:59.000Z warn: before start', '2026-11-10T10:00:58.000Z warn: Source x audio is lagging', '2026-11-10T10:01:00.000Z info: fine', "2026-11-10T10:01:02.000Z error: open 'D:/media/clips/a b.mp4' failed"].join('\n');
  assert.deepEqual(stallLines(t, start), [[58, 'Source x audio is lagging'], [62, "open '<path>' failed"]]);
  assert.equal(noPaths('at D:\\data\\y.txt'), 'at <path>');
  assert.equal(noPaths('no path here: 1/2'), 'no path here: 1/2');
});

test('the staged runtime resolves every relative import of the staged code', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-stage-imp-'));
  try {
    const { root } = stageRuntime(dir, { eventCoreData: dir });
    const missing = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.mjs$/.test(e.name)) for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) if (!existsSync(path.resolve(path.dirname(f), m[1]))) missing.push(`${path.relative(root, f)} -> ${m[1]}`); } };
    for (const top of ['services', 'app', 'tools']) if (existsSync(path.join(root, top))) walk(path.join(root, top));
    assert.deepEqual(missing, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('noteChange: a visible change that keeps the document shape', () => {
  assert.equal(noteChange({ $comment: 'a', x: 1 }, 't').$comment, 'a (t)');
  assert.equal(noteChange({ definition: 'd', version: 1 }, 't').definition, 'd (t)');
  assert.equal(noteChange({ x: 1 }, 't').$comment, 't');
});

test('report: a table row per check, no paths', () => {
  const md = report({ id: 'x', mode: 'short', minutes: 3, pass: false, startedAt: 'now', durationS: 180, record: true, host: {}, checks: [{ name: 'a', pass: true }, { name: 'b', pass: false, detail: { n: 1 } }], notes: [] });
  assert.match(md, /: FAIL/);
  assert.match(md, /\| a \| PASS \|/);
  assert.match(md, /\| b \| FAIL \| `\{"n":1\}` \|/);
  assert.doesNotMatch(md, /[A-Z]:\\/);
});

test('recordingFileFor (LC2): each file sink gets its own stamped file, H never takes the V file, clip saves are ignored', () => {
  const d = path.join('C:', 'w', 'media', 'recordings');
  const files = [
    { f: path.join(d, 'alpha-v-20261110-170758.mkv'), size: 50 },
    { f: path.join(d, 'alpha-20261110-170758.mkv'), size: 120 },
    { f: path.join(d, 'alpha-20261110-160000.mkv'), size: 10 },
    { f: path.join(d, 'replay-alpha-20261110-170800.mkv'), size: 500 },
    { f: path.join(d, 'clip-20261110-170900.mp4'), size: 900 },
  ];
  const h = { id: 'record', target: { transport: 'file', name: 'alpha.mkv' } };
  const v = { id: 'record-v', target: { transport: 'file', name: 'alpha-v.mkv' } };
  assert.equal(path.basename(recordingFileFor(h, files).f), 'alpha-20261110-170758.mkv', 'the largest of its own name');
  assert.equal(path.basename(recordingFileFor(v, files).f), 'alpha-v-20261110-170758.mkv');
  assert.equal(recordingFileFor({ id: 'x', target: { transport: 'file', name: 'other.mkv' } }, files), null);
  assert.equal(recordingFileFor({ id: 'x', target: { transport: 'file' } }, files), null);
  assert.equal(recordingFileFor(v, [{ f: path.join(d, 'alpha-20261110-170758.mkv'), size: 1 }]), null, 'no V file: null (the check then fails)');
});
