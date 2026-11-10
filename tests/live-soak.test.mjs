// SPDX-License-Identifier: GPL-3.0-or-later
// Pure parts of the live-soak gate (tools/soak/live-soak.mjs, LU8): arguments, timestamp gaps, error-level log
// lines, the report. The gate itself runs the host and is a release gate, not part of this suite.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { errorLines, noPaths, noteChange, parseSoakArgs, ptsGaps, report, stallLines } from '../tools/soak/live-soak.mjs';
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
  assert.deepEqual({ gaps: ptsGaps(steady).gaps, missing: ptsGaps(steady).missingFrames }, { gaps: 0, missing: 0 });
  const holed = steady.filter((_, i) => i < 100 || i >= 103);
  const g = ptsGaps(holed.reverse()); // any order (B-frames)
  assert.equal(g.gaps, 1);
  assert.equal(g.missingFrames, 3);
  assert.equal(ptsGaps([0, 1]).gaps, 0);
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
  assert.deepEqual([ptsGaps(s).gaps, ptsGaps(s).endGaps], [1, 0]);
  assert.deepEqual([ptsGaps(s, { tailSec: 0.5 }).gaps, ptsGaps(s, { tailSec: 0.5 }).endGaps], [0, 1]);
  const mid = Array.from({ length: 600 }, (_, i) => i / 60).filter((_, i) => i !== 300);
  assert.equal(ptsGaps(mid, { tailSec: 0.5 }).gaps, 1, 'a gap mid-stream still counts');
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
